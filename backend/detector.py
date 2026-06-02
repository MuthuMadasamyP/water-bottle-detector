"""
Water Bottle Detector — wraps a trained YOLO model.
Place your trained model at:  backend/models/11n.pt
"""
from detector import BottleDetector
import cv2
import numpy as np
from pathlib import Path

FONT = cv2.FONT_HERSHEY_SIMPLEX


class BottleDetector:
    """Loads a YOLO model and runs inference on single frames."""

    DEFAULT_MODEL = Path(__file__).parent / "models" / "best.pt"

    def __init__(self, model_path: str | None = None, conf=0.5):
        self.conf       = conf
        self.model      = None
        self.seen_ids   = set()   # tracks unique bottle IDs across frames
        self.model_path = Path(model_path) if model_path else self.DEFAULT_MODEL
        self._load()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load(self) -> None:
        if not self.model_path.exists():
            print(
                f"[Detector] ⚠  Model not found at '{self.model_path}'.\n"
                "           Running in DEMO mode (no real detections)."
            )
            return
        try:
            from ultralytics import YOLO
            self.model = YOLO(str(self.model_path))
            print(f"[Detector] ✓ Model loaded from {self.model_path}")
        except ImportError:
            print("[Detector] ⚠  'ultralytics' package not found. pip install ultralytics")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, frame: np.ndarray) -> tuple[np.ndarray, int, int]:
        """
        Run detection on *frame* (BGR numpy array).

        Returns
        -------
        annotated_frame : np.ndarray   — frame with bounding boxes
        frame_count     : int          — bottles visible in THIS frame
        new_count       : int          — NEW unique bottles (never seen before)
                                         add this to overall total
        """
        if self.model is None:
            return self._demo_frame(frame), 0, 0

        # tracker assigns a persistent unique ID to each bottle across frames
        results = self.model.track(
            frame,
            conf=self.conf,
            verbose=False,
            persist=True,
            tracker="bytetrack.yaml"
        )[0]

        annotated = results.plot(
            line_width=2,
            font_size=0.6,
            labels=True,
            conf=True,
        )

        # How many bottles are visible RIGHT NOW in this frame
        frame_count = len(results.boxes)

        # How many of those are BRAND NEW (never seen before)
        new_count = 0
        if results.boxes.id is not None:
            current_ids = set(results.boxes.id.tolist())
            new_ids     = current_ids - self.seen_ids
            new_count   = len(new_ids)
            self.seen_ids.update(current_ids)

        return annotated, frame_count, new_count

    def reset(self) -> None:
        """Clear all tracked IDs — call on session reset."""
        self.seen_ids.clear()

    # ------------------------------------------------------------------
    # Demo / fallback
    # ------------------------------------------------------------------

    @staticmethod
    def _demo_frame(frame: np.ndarray) -> np.ndarray:
        out = frame.copy()
        h, w = out.shape[:2]
        overlay = out.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (20, 20, 20), -1)
        cv2.addWeighted(overlay, 0.35, out, 0.65, 0, out)
        cv2.putText(
            out, "DEMO MODE — model not loaded",
            (w // 2 - 200, h // 2),
            FONT, 0.75, (0, 200, 80), 2, cv2.LINE_AA,
        )
        return out  
