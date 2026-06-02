/**
 * Bottle Detector — Frontend controller
 */

/* ── State ──────────────────────────────────────────────────────────── */
const state = {
  mode:         'webcam',
  ws:           null,
  running:      false,
  videoFile:    null,
  videoId:      null,
  sessionStart: null,
  sessionTimer: null,
  fpsTimer:     null,
  fpsFrames:    0,
  history:      [],
  maxHistory:   30,
  previewFrame: null,
  webcamAnnotated: false,
  videoAnnotated: false,
  videoPreviewUrl: null,
  videoPreview: null,
};

/* ── DOM refs ────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const dom = {
  statusDot:         $('statusDot'),
  statusLabel:       $('statusLabel'),
  bottleCount:       $('bottleCount'),
  sessionTime:       $('sessionTime'),
  frameBar:          $('frameBar'),
  startBtn:          $('startBtn'),
  stopBtn:           $('stopBtn'),
  recIndicator:      $('recIndicator'),
  fpsIndicator:      $('fpsIndicator'),
  progressIndicator: $('progressIndicator'),
  progressBar:       $('progressBar'),
  historyChart:      $('historyChart'),
  webcamPanel:       $('webcamPanel'),
  videoPanel:        $('videoPanel'),
  rawVideo:          $('rawVideo'),
  displayCanvas:     $('displayCanvas'),
  captureCanvas:     $('captureCanvas'),
  feedOverlay:       $('feedOverlay'),
  dropZone:          $('dropZone'),
  videoWrapper:      $('videoWrapper'),
  videoCanvas:       $('videoCanvas'),
  fileInput:         $('fileInput'),
  fileInfo:          $('fileInfo'),
  fileName:          $('fileName'),
  btnWebcam:         $('btnWebcam'),
  btnVideo:          $('btnVideo'),
};

/* ── Helpers ─────────────────────────────────────────────────────────── */
function wsBase() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function formatTime(sec) {
  return `${pad2(Math.floor(sec / 60))}:${pad2(sec % 60)}`;
}

function waitForVideoReady(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('canplay', onReady);
      video.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(video.error || new Error('Video failed to load'));
    };

    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('canplay', onReady);
    video.addEventListener('error', onError);
  });
}

function drawFrameToCanvas(canvas, img) {
  const width = img.naturalWidth || img.videoWidth || img.width;
  const height = img.naturalHeight || img.videoHeight || img.height;
  if (!width || !height) return;

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

function stopLocalPreview() {
  if (state.previewFrame) {
    cancelAnimationFrame(state.previewFrame);
    state.previewFrame = null;
  }
}

function startLocalPreview(video, canvas, shouldContinue) {
  stopLocalPreview();

  const render = () => {
    if (!shouldContinue()) {
      state.previewFrame = null;
      return;
    }

    if (video.videoWidth && video.videoHeight) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    }

    state.previewFrame = requestAnimationFrame(render);
  };

  render();
}

function showError(message) {
  console.error(message);
  setStatus('ERROR', 'error');
}

/* ── Status ──────────────────────────────────────────────────────────── */
function setStatus(label, cls = '') {
  dom.statusLabel.textContent = label;
  dom.statusDot.className = 'status-dot' + (cls ? ' ' + cls : '');
}

/* ── Dashboard ───────────────────────────────────────────────────────── */
function updateStats(frameCount, totalCount) {
  dom.bottleCount.textContent = frameCount;

  dom.bottleCount.classList.add('stat-pulse');
  setTimeout(() => {
    dom.bottleCount.classList.remove('stat-pulse');
  }, 400);

  dom.frameBar.style.width = `${Math.min(100, (frameCount / 10) * 100)}%`;

  state.history.push(frameCount);
  if (state.history.length > state.maxHistory) state.history.shift();
  drawChart();
}

/* ── Mini chart ──────────────────────────────────────────────────────── */
function drawChart() {
  const cvs = dom.historyChart;
  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;
  ctx.clearRect(0, 0, W, H);
  const data = state.history;
  if (data.length < 2) return;

  const max  = Math.max(...data, 1);
  const step = W / (state.maxHistory - 1);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,255,136,0.35)');
  grad.addColorStop(1, 'rgba(0,255,136,0.02)');

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i * step, y = H - (v / max) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo((data.length - 1) * step, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i * step, y = H - (v / max) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

/* ── Session timer ───────────────────────────────────────────────────── */
function startTimer() {
  state.sessionStart = Date.now();
  state.sessionTimer = setInterval(() => {
    dom.sessionTime.textContent = formatTime(
      Math.floor((Date.now() - state.sessionStart) / 1000)
    );
  }, 1000);
}
function stopTimer() { clearInterval(state.sessionTimer); state.sessionTimer = null; }

/* ── FPS counter ─────────────────────────────────────────────────────── */
function startFpsCounter() {
  state.fpsFrames = 0;
  state.fpsTimer  = setInterval(() => {
    dom.fpsIndicator.textContent = `${state.fpsFrames} FPS`;
    state.fpsFrames = 0;
  }, 1000);
}
function stopFpsCounter() {
  clearInterval(state.fpsTimer);
  state.fpsTimer = null;
  dom.fpsIndicator.textContent = '0 FPS';
}

/* ── Mode switching ──────────────────────────────────────────────────── */
window.setMode = function(mode) {
  if (state.running) handleStop();
  state.mode = mode;
  dom.btnWebcam.classList.toggle('active', mode === 'webcam');
  dom.btnVideo.classList.toggle('active',  mode === 'video');
  dom.webcamPanel.classList.toggle('hidden', mode !== 'webcam');
  dom.videoPanel.classList.toggle('hidden',  mode !== 'video');
};

/* ══════════════════════════════════════════════════════════════════════
   WEBCAM — CONTINUOUS PING-PONG LOOP
   Send frame → receive response → immediately send next frame
   This guarantees non-stop detection with zero gaps.
══════════════════════════════════════════════════════════════════════ */
let camStream = null;

async function startWebcamSession() {
  state.webcamAnnotated = false;

  // 1. Get camera
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    dom.rawVideo.srcObject = camStream;
    const videoReady = waitForVideoReady(dom.rawVideo);
    await dom.rawVideo.play();
    await videoReady;
  } catch (err) {
    showError(err.message || 'Could not start webcam.');
    resetUI();
    return;
  }

  const vw = dom.rawVideo.videoWidth;
  const vh = dom.rawVideo.videoHeight;
  dom.captureCanvas.width  = vw;
  dom.captureCanvas.height = vh;
  dom.displayCanvas.width  = vw;
  dom.displayCanvas.height = vh;
  startLocalPreview(dom.rawVideo, dom.displayCanvas, () => state.running && !state.webcamAnnotated);

  // 2. Open WebSocket
  const ws = new WebSocket(`${wsBase()}/ws/webcam`);
  state.ws  = ws;
  const captCtx = dom.captureCanvas.getContext('2d');

  // ── Helper: capture current webcam frame and send it ──────────────
  function sendNextFrame() {
    if (!state.running || ws.readyState !== WebSocket.OPEN) return;
    captCtx.drawImage(dom.rawVideo, 0, 0);
    const b64 = dom.captureCanvas.toDataURL('image/jpeg', 0.7).split(',')[1];
    ws.send(JSON.stringify({ frame: b64 }));
  }

  ws.onopen = () => {
    setStatus('LIVE', 'online');
    dom.feedOverlay.style.display = 'none';
    dom.recIndicator.style.display = 'inline';
    startFpsCounter();
    startTimer();
    sendNextFrame();   // 🚀 kick off the continuous loop
  };

  ws.onmessage = evt => {
    if (!state.running) return;

    const msg = JSON.parse(evt.data);
    if (msg.reset) {
      sendNextFrame();   // keep loop alive after reset
      return;
    }

    state.fpsFrames++;
    updateStats(msg.frame_count, msg.total_count);

    // Render annotated frame
    const img = new Image();
    img.onload = () => {
      state.webcamAnnotated = true;
      stopLocalPreview();
      drawFrameToCanvas(dom.displayCanvas, img);
    };
    img.src = `data:image/jpeg;base64,${msg.frame}`;

    // ✅ Immediately request the next frame — continuous loop
    sendNextFrame();
  };

  ws.onerror = () => { showError('Webcam WebSocket failed. Check that FastAPI is running on the same URL.'); resetUI(); };
  ws.onclose = () => { if (state.running && !state.webcamAnnotated) showError('Webcam stream closed before any detection frame arrived.'); if (state.running) resetUI(); };
}

function stopWebcam() {
  stopLocalPreview();
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  dom.rawVideo.srcObject = null;
}

/* ══════════════════════════════════════════════════════════════════════
   VIDEO UPLOAD
══════════════════════════════════════════════════════════════════════ */
window.handleFileSelect = function(event) {
  const file = event.target.files[0];
  if (file) acceptVideoFile(file);
};

function acceptVideoFile(file) {
  state.videoFile = file;
  state.videoAnnotated = false;
  if (state.videoPreviewUrl) URL.revokeObjectURL(state.videoPreviewUrl);
  state.videoPreviewUrl = URL.createObjectURL(file);
  state.videoPreview = document.createElement('video');
  state.videoPreview.muted = true;
  state.videoPreview.playsInline = true;
  state.videoPreview.preload = 'metadata';
  state.videoPreview.src = state.videoPreviewUrl;
  state.videoPreview.addEventListener('loadeddata', () => {
    drawFrameToCanvas(dom.videoCanvas, state.videoPreview);
  }, { once: true });
  dom.fileName.textContent = file.name;
  dom.dropZone.classList.add('hidden');
  dom.videoWrapper.classList.remove('hidden');
  dom.fileInfo.classList.remove('hidden');
  dom.progressBar.style.width = '0%';
  dom.videoCanvas.width  = 1280;
  dom.videoCanvas.height = 720;
}

window.clearVideo = function() {
  if (state.running) handleStop();
  stopLocalPreview();
  if (state.videoPreview) {
    state.videoPreview.pause();
    state.videoPreview.removeAttribute('src');
    state.videoPreview.load();
  }
  if (state.videoPreviewUrl) URL.revokeObjectURL(state.videoPreviewUrl);
  state.videoFile = null;
  state.videoId   = null;
  state.videoPreview = null;
  state.videoPreviewUrl = null;
  state.videoAnnotated = false;
  dom.fileName.textContent = '—';
  dom.dropZone.classList.remove('hidden');
  dom.videoWrapper.classList.add('hidden');
  dom.fileInfo.classList.add('hidden');
  dom.fileInput.value = '';
  dom.progressBar.style.width = '0%';
  dom.progressIndicator.textContent = 'READY';
};

async function uploadAndStream() {
  if (!state.videoFile) return;
  state.videoAnnotated = false;

  dom.progressIndicator.textContent = 'UPLOADING…';
  const formData = new FormData();
  formData.append('file', state.videoFile);

  let videoId;
  try {
    const res  = await fetch('/api/upload-video', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const json = await res.json();
    if (!json.video_id) throw new Error('Upload response did not include video_id');
    videoId = json.video_id;
    state.videoId = videoId;
  } catch (err) {
    dom.progressIndicator.textContent = 'UPLOAD ERROR';
    showError(err.message || 'Video upload failed.');
    resetUI();
    return;
  }

  const ws = new WebSocket(`${wsBase()}/ws/video/${videoId}`);
  state.ws = ws;

  ws.onopen = () => {
    setStatus('PROCESSING', 'online');
    dom.progressIndicator.textContent = 'PROCESSING';
    startTimer();
    if (state.videoPreview) {
      state.videoPreview.currentTime = 0;
      state.videoPreview.play().catch(() => {});
      startLocalPreview(state.videoPreview, dom.videoCanvas, () => state.running && !state.videoAnnotated);
    }
    ws.send(JSON.stringify({ action: 'start' }));
  };

  ws.onmessage = evt => {
    const msg = JSON.parse(evt.data);

    if (msg.status === 'error') { dom.progressIndicator.textContent = 'ERROR'; showError(msg.message || 'Video processing failed.'); resetUI(); return; }

    if (msg.status === 'done') {
      dom.progressIndicator.textContent = 'DONE';
      dom.progressBar.style.width = '100%';
      setStatus('DONE', '');
      resetUI();
      return;
    }

    updateStats(msg.frame_count, msg.total_count);
    dom.progressBar.style.width = `${msg.progress}%`;
    dom.progressIndicator.textContent = `${msg.progress}%`;

    const img = new Image();
    img.onload = () => {
      state.videoAnnotated = true;
      stopLocalPreview();
      drawFrameToCanvas(dom.videoCanvas, img);
    };
    img.src = `data:image/jpeg;base64,${msg.frame}`;
  };

  ws.onerror = () => { dom.progressIndicator.textContent = 'STREAM ERROR'; showError('Video WebSocket failed.'); resetUI(); };
  ws.onclose = () => {};
}

/* ══════════════════════════════════════════════════════════════════════
   UNIFIED CONTROLS
══════════════════════════════════════════════════════════════════════ */
function resetUI() {
  state.running = false;
  stopLocalPreview();
  dom.startBtn.disabled = false;
  dom.stopBtn.disabled  = true;
  dom.recIndicator.style.display = 'none';
  stopTimer();
  stopFpsCounter();
}

window.handleStart = async function() {
  if (state.running) return;
  state.running = true;
  dom.startBtn.disabled = true;
  dom.stopBtn.disabled  = false;

  if (state.mode === 'webcam') {
    await startWebcamSession();
  } else {
    await uploadAndStream();
  }
};

window.handleStop = function() {
  if (!state.running) return;
  state.running = false;

  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.mode === 'webcam') {
    stopWebcam();
    dom.feedOverlay.style.display = '';
  }
  setStatus('OFFLINE', '');
  resetUI();
};

window.handleReset = function() {
  state.history = [];
  dom.bottleCount.textContent = '0';
  dom.sessionTime.textContent = '00:00';
  dom.frameBar.style.width    = '0%';
  drawChart();

  if (state.ws && state.ws.readyState === WebSocket.OPEN && state.mode === 'webcam') {
    state.ws.send(JSON.stringify({ action: 'reset' }));
  }
};

/* ── Drag & drop ─────────────────────────────────────────────────────── */
const dz = dom.dropZone;
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('video/')) acceptVideoFile(file);
});

/* ── Init ────────────────────────────────────────────────────────────── */
(function init() {
  drawChart();
  fetch('/api/health').then(r => r.json()).then(d => {
    setStatus(d.model_loaded ? 'READY' : 'DEMO', d.model_loaded ? '' : '');
  }).catch(() => setStatus('ERROR', 'error'));
})();