"""
Water Bottle Detection — FastAPI Backend (Optimised)
"""
import os
import asyncio
import base64
import json
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from detector import BottleDetector
# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Water Bottle Detector", version="1.0.0")

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
UPLOAD_DIR   = Path(tempfile.gettempdir()) / "wbd_uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")

detector  = BottleDetector()
executor  = ThreadPoolExecutor(max_workers=2)   # run YOLO in background thread

# ---------------------------------------------------------------------------
# Tuning knobs
# ---------------------------------------------------------------------------

JPEG_QUALITY   = [cv2.IMWRITE_JPEG_QUALITY, 50]   # higher = clearer display
INFER_WIDTH    = 320          # resize very wide frames before inference
FRAME_SKIP     = 7           # process 1 out of every N frames (2 = every other)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def frame_to_b64(frame: np.ndarray) -> str:
    _, buf = cv2.imencode(".jpg", frame, JPEG_QUALITY)
    return base64.b64encode(buf).decode("utf-8")


def b64_to_frame(data: str) -> np.ndarray:
    raw = base64.b64decode(data)
    arr = np.frombuffer(raw, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def resize_for_inference(frame: np.ndarray) -> np.ndarray:
    """Downscale wide frames to INFER_WIDTH before sending to YOLO."""
    h, w = frame.shape[:2]
    if w <= INFER_WIDTH:
        return frame
    scale = INFER_WIDTH / w
    return cv2.resize(frame, (INFER_WIDTH, int(h * scale)), interpolation=cv2.INTER_LINEAR)


def run_detection(frame: np.ndarray):
    small = resize_for_inference(frame)
    annotated, frame_count, new_count = detector.detect(small)
    if annotated.shape[:2] != frame.shape[:2]:
        annotated = cv2.resize(
            annotated,
            (frame.shape[1], frame.shape[0]),
            interpolation=cv2.INTER_LINEAR,
        )
    return annotated, frame_count, new_count


# ---------------------------------------------------------------------------
# HTTP routes
# ---------------------------------------------------------------------------

@app.get("/")
async def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/api/health")
async def health():
    return {"status": "ok", "model_loaded": detector.model is not None}


@app.post("/api/upload-video")
async def upload_video(file: UploadFile = File(...)):
    ext      = Path(file.filename).suffix or ".mp4"
    vid_id   = uuid.uuid4().hex
    vid_path = UPLOAD_DIR / f"{vid_id}{ext}"

    chunk_size = 1024 * 1024
    with open(vid_path, "wb") as f:
        while chunk := await file.read(chunk_size):
            f.write(chunk)

    return JSONResponse({"video_id": vid_id, "filename": file.filename})


# ---------------------------------------------------------------------------
# WebSocket — live webcam
# ---------------------------------------------------------------------------

@app.websocket("/ws/webcam")
async def webcam_ws(ws: WebSocket):
    await ws.accept()
    total_count = 0
    detector.reset()
    loop = asyncio.get_event_loop()

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)

            if msg.get("action") == "reset":
                total_count = 0
                detector.reset()
                await ws.send_text(json.dumps({"reset": True, "total_count": 0}))
                continue

            frame = b64_to_frame(msg["frame"])

            # Run YOLO in thread pool → event loop stays free
            annotated, frame_count, new_count = await loop.run_in_executor(
                executor, run_detection, frame
            )
            total_count += new_count

            await ws.send_text(json.dumps({
                "frame":       frame_to_b64(annotated),
                "frame_count": frame_count,
                "total_count": total_count,
            }))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[webcam_ws] error: {exc}")


# ---------------------------------------------------------------------------
# WebSocket — uploaded video  (OPTIMISED)
# ---------------------------------------------------------------------------

@app.websocket("/ws/video/{video_id}")
async def video_ws(ws: WebSocket, video_id: str):
    await ws.accept()

    matches = list(UPLOAD_DIR.glob(f"{video_id}.*"))
    if not matches:
        await ws.send_text(json.dumps({"status": "error", "message": "Video not found"}))
        await ws.close()
        return

    vid_path    = matches[0]
    total_count = 0
    paused      = False
    detector.reset()
    loop        = asyncio.get_event_loop()

    cap = cv2.VideoCapture(str(vid_path))
    if not cap.isOpened():
        await ws.send_text(json.dumps({"status": "error", "message": "Cannot open video"}))
        await ws.close()
        return

    total_frames  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    frame_idx     = 0
    last_annotated = None
    last_frame_count = 0

    async def poll_control():
        nonlocal paused, total_count
        try:
            raw    = await asyncio.wait_for(ws.receive_text(), timeout=0.001)
            action = json.loads(raw).get("action", "")
            if action == "pause":
                paused = True
            elif action in ("resume", "start"):
                paused = False
            elif action == "reset":
                total_count = 0
                detector.reset()
        except (asyncio.TimeoutError, Exception):
            pass

    try:
        while cap.isOpened():
            await poll_control()

            if paused:
                await asyncio.sleep(0.05)
                continue

            ret, frame = cap.read()
            if not ret:
                break

            frame_idx += 1
            progress   = round((frame_idx / total_frames) * 100, 1)

            # ── Frame skipping ──────────────────────────────────────────
            # Skip every FRAME_SKIP-1 frames — still sends the last result
            # so the video display never freezes.
            if frame_idx == 1 or frame_idx % FRAME_SKIP == 0:
                # Run YOLO in thread pool (non-blocking)
                annotated, frame_count, new_count = await loop.run_in_executor(
                    executor, run_detection, frame
                )
                total_count      += new_count
                last_annotated    = annotated
                last_frame_count  = frame_count
            else:
                # Skipped frame — reuse last result, no inference cost
                if last_annotated is None:
                    continue          # skip until first inference is done
                annotated    = last_annotated
                frame_count  = last_frame_count

            await ws.send_text(json.dumps({
                "frame":       frame_to_b64(annotated),
                "frame_count": frame_count,
                "total_count": total_count,
                "progress":    progress,
                "status":      "processing",
            }))

            # No artificial sleep — run as fast as inference allows

        await ws.send_text(json.dumps({
            "status":      "done",
            "total_count": total_count,
        }))

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print(f"[video_ws] error: {exc}")
    finally:
        cap.release()
        try:
            vid_path.unlink(missing_ok=True)
        except Exception:
            pass
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000))
    )