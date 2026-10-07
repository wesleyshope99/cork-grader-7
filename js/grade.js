import * as db from './db.js';
import { drawNormalizedDisk, transformFromCalibration, CANVAS_SIZE, DISK_PX } from './crop.js';
import { captureAndMeasure } from './pipeline.js';

function $(id) { return document.getElementById(id); }

let sharedStream = null;
let calibVideoW = 0, calibVideoH = 0;
let calibState = null; // { cx, cy, radius } in native pixel coords, for the calibration screen only
let calibRafId = null;

let gradeVideoW = 0, gradeVideoH = 0;
let calibrationPixels = null; // { transform, circle } reconstructed from stored fractional calibration
let isGradeScreenVisible = false;

// Full-resolution copy of the live frame at the moment of the tap. Both
// capture passes read from this same snapshot, so the re-crop can't land on a
// different frame than the one the disc was found in.
const snapshot = document.createElement('canvas');
const snapshotCtx = snapshot.getContext('2d');

function grabFrame(video) {
  if (snapshot.width !== video.videoWidth || snapshot.height !== video.videoHeight) {
    snapshot.width = video.videoWidth;
    snapshot.height = video.videoHeight;
  }
  snapshotCtx.drawImage(video, 0, 0);
  return snapshot;
}

// The camera request. 'ideal' is a hint -- the browser picks the nearest mode it
// supports. On the user's iPhone this delivers a 1920x1920 square. Asking for the
// maximum instead (3024x4032, v6's 'Max') was tested against it on five discs and
// made no difference (porosity 0.94-1.03x), so v7 doesn't offer it. The video-info
// line still shows what the device actually delivers.
const CAMERA_SIZE = 1920;

// Sharpening levels (unsharp-mask amount). Live video is softer than a still, but
// how much correction a disc needs varies with its pores: on five discs the exact
// amount ranged 0.45 (pore-rich) to ~1.1 (cleaner), so 'light' is the compromise.
const SHARPEN_LEVELS = { off: 0, light: 0.5, medium: 1.0 };
let sharpenLevel = 'light';
let weightedOn = false;

function calibrationKey() { return 'calibration'; }

async function getSharedStream() {
  if (sharedStream) return sharedStream;
  sharedStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: CAMERA_SIZE }, height: { ideal: CAMERA_SIZE } },
    audio: false,
  });
  return sharedStream;
}

function updateVideoInfo(width, height) {
  const track = sharedStream && sharedStream.getVideoTracks()[0];
  const fps = track && track.getSettings && track.getSettings().frameRate;
  $('video-info').textContent = `video: ${width}\u00d7${height}${fps ? ` @ ${Math.round(fps)}fps` : ''}`;
}

function coverParams(containerRect, nativeW, nativeH) {
  const scale = Math.max(containerRect.width / nativeW, containerRect.height / nativeH);
  return {
    scale,
    offX: (containerRect.width - nativeW * scale) / 2,
    offY: (containerRect.height - nativeH * scale) / 2,
  };
}
function nativeToCss(x, y, cover) { return { x: x * cover.scale + cover.offX, y: y * cover.scale + cover.offY }; }
function cssToNative(x, y, cover) { return { x: (x - cover.offX) / cover.scale, y: (y - cover.offY) / cover.scale }; }

// Draws a circle guide (in native video pixel coords) onto an overlay canvas
// that sits on top of a <video>, accounting for the video's object-fit:cover
// cropping. Shared by the calibration screen (editable circle) and the live
// grading screen (a fixed reminder of where the calibrated disk position is).
function drawCircleGuide(canvasEl, nativeW, nativeH, circle) {
  const rect = canvasEl.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvasEl.width = rect.width * dpr;
  canvasEl.height = rect.height * dpr;
  const ctx = canvasEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!circle || !nativeW) return;

  const cover = coverParams(rect, nativeW, nativeH);
  const center = nativeToCss(circle.cx, circle.cy, cover);
  const radiusCss = circle.radius * cover.scale;

  ctx.strokeStyle = '#5ea6b2';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radiusCss, 0, Math.PI * 2);
  ctx.stroke();
}

// ============================= Calibration =============================
// Reused verbatim from cork-grader-2/js/grade.js -- calibrating "where is
// the disk in the frame" has nothing to do with how the disk gets graded
// once cropped.

function drawCalibPreview() {
  if (!calibState || !calibVideoW) return;
  const video = $('calib-video');
  const t = transformFromCalibration(calibState, calibVideoW, calibVideoH, { canvasSize: 300, diskPx: DISK_PX });
  drawNormalizedDisk($('calib-preview').getContext('2d'), video, t, { canvasSize: 300, diskPx: DISK_PX });
}

function calibLoop() {
  drawCircleGuide($('calib-overlay'), calibVideoW, calibVideoH, calibState);
  drawCalibPreview();
  calibRafId = requestAnimationFrame(calibLoop);
}

function wireCalibPointerEvents() {
  const canvas = $('calib-overlay');
  const pointers = new Map();
  let dragLast = null;
  let pinchStartDist = null;
  let pinchStartRadius = null;

  function currentPinchDist() {
    const pts = [...pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) dragLast = { x: e.clientX, y: e.clientY };
    else if (pointers.size === 2) { pinchStartDist = currentPinchDist(); pinchStartRadius = calibState.radius; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = canvas.getBoundingClientRect();
    const cover = coverParams(rect, calibVideoW, calibVideoH);

    if (pointers.size === 1 && dragLast) {
      const prevNative = cssToNative(dragLast.x - rect.left, dragLast.y - rect.top, cover);
      const curNative = cssToNative(e.clientX - rect.left, e.clientY - rect.top, cover);
      calibState.cx += curNative.x - prevNative.x;
      calibState.cy += curNative.y - prevNative.y;
      dragLast = { x: e.clientX, y: e.clientY };
    } else if (pointers.size === 2) {
      const dist = currentPinchDist();
      if (pinchStartDist) calibState.radius = Math.max(20, pinchStartRadius * (dist / pinchStartDist));
    }
  });
  function release(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { pinchStartDist = null; pinchStartRadius = null; }
    dragLast = pointers.size === 1 ? [...pointers.values()][0] : null;
  }
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', release);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    calibState.radius = Math.max(20, calibState.radius * (1 - e.deltaY * 0.001));
  }, { passive: false });
}

async function startCalibrationScreen() {
  $('grade-calibrate-prompt').hidden = true;
  $('grading-screen').hidden = true;
  $('settings-row').hidden = true;
  $('calibration-screen').hidden = false;

  const stream = await getSharedStream();
  const video = $('calib-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise((resolve) => {
    if (video.videoWidth) resolve();
    else video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  calibVideoW = video.videoWidth;
  calibVideoH = video.videoHeight;

  const existing = await db.getSetting(calibrationKey(), null);
  if (existing) {
    calibState = {
      cx: existing.fx * calibVideoW,
      cy: existing.fy * calibVideoH,
      radius: existing.fr * calibVideoW,
    };
  } else {
    calibState = {
      cx: calibVideoW / 2,
      cy: calibVideoH / 2,
      radius: Math.min(calibVideoW, calibVideoH) * 0.3,
    };
  }

  calibLoop();
}

function stopCalibrationScreen() {
  if (calibRafId) cancelAnimationFrame(calibRafId);
  calibRafId = null;
  $('calibration-screen').hidden = true;
}

async function confirmCalibration() {
  await db.setSetting(calibrationKey(), {
    fx: calibState.cx / calibVideoW,
    fy: calibState.cy / calibVideoH,
    fr: calibState.radius / calibVideoW,
    aspect: calibVideoW / calibVideoH, // so a later change in the picture's shape isn't silently trusted
  });
  stopCalibrationScreen();
  await showGradingScreenIfReady();
}

// ============================= Grading (tap-to-grade) =============================
//
// v2 found continuous auto-grading confidently wrong on partial/unstable
// frames, so grading here is tap-triggered only too -- same reasoning, now
// applied to the deterministic pipeline instead of the ML one.

function porosityText(result) {
  return result.weighted
    ? `porosity ${result.gradedPorosityPct}% (pores ${result.porosityPct}% + discoloration ${result.discolorationPct}%)`
    : `porosity ${result.porosityPct}%`;
}

function setResultOverlay(result) {
  const overlay = $('grade-result-overlay');
  const letter = $('grade-result-letter');
  const metrics = $('grade-result-metrics');
  overlay.className = 'result-overlay' + (result ? ` grade-${result.grade}` : '');
  letter.textContent = result ? result.grade : '';
  metrics.textContent = result ? `${porosityText(result)}  ·  top-3 holes ${result.top3Mm}mm` : '';
  overlay.hidden = !result;
}

function drawCropPreviewWithBoundary(sourceCanvas, disk) {
  const previewCanvas = $('grade-crop-preview');
  const ctx = previewCanvas.getContext('2d');
  const previewSize = previewCanvas.width; // 120, per index.html
  const scale = previewSize / CANVAS_SIZE;
  ctx.clearRect(0, 0, previewSize, previewSize);
  ctx.drawImage(sourceCanvas, 0, 0, previewSize, previewSize);
  ctx.strokeStyle = '#4fd873'; // green -- a drawn boundary always means detection succeeded, there's no fallback case to distinguish
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(disk.cx * scale, disk.cy * scale, disk.radius * scale, 0, Math.PI * 2);
  ctx.stroke();
}

// Tracks only the single most-recently-committed log entry, in memory --
// enough to undo a bad tap (wrong moment, disc not settled yet) right
// after it happens, without building out full per-row log editing. Resets
// on page reload by design: undoing something from a past session isn't
// what this is for.
let lastLogEntryId = null;

function setUndoAvailable(available) {
  $('btn-undo-last-grade').disabled = !available;
}

async function commitGrade(result, sourceCanvas, diameterMm, disk, capture) {
  lastLogEntryId = await db.addLogEntry({
    grade: result.grade,
    porosityPct: result.gradedPorosityPct,       // the porosity the grade came from
    porePorosityPct: result.porosityPct,         // pores only
    discolorationPct: result.discolorationPct,   // raw, uncorrected -- logged whether or not it was used
    weighted: result.weighted,
    top3Mm: result.top3Mm,
    numPores: result.numPores,
    diameterMm,
    videoW: capture.videoW,
    videoH: capture.videoH,
    sharpenLevel: capture.sharpenLevel,
  });
  setUndoAvailable(true);
  setResultOverlay(result);
  $('grade-status').textContent = `Graded: ${result.grade} (${porosityText(result)}, top-3 holes ${result.top3Mm}mm)`;
  $('last-graded').textContent = `${result.grade} at ${new Date().toLocaleTimeString()}`;
  drawCropPreviewWithBoundary(sourceCanvas, disk);
  if (navigator.vibrate) navigator.vibrate(80);
}

async function handleUndoLastGrade() {
  if (lastLogEntryId == null) return;
  await db.deleteLogEntry(lastLogEntryId);
  lastLogEntryId = null;
  setUndoAvailable(false);
  setResultOverlay(null);
  $('grade-crop-preview').getContext('2d').clearRect(0, 0, 120, 120);
  $('last-graded').textContent = '—';
  $('grade-status').textContent = 'Last grade undone.';
}

function redrawGradeOverlay() {
  if (!calibrationPixels || !gradeVideoW) return;
  drawCircleGuide($('grade-overlay'), gradeVideoW, gradeVideoH, calibrationPixels.circle);
}

async function showGradingScreenIfReady() {
  const calibration = await db.getSetting(calibrationKey(), null);

  $('grade-calibrate-prompt-text').textContent = 'Camera not calibrated yet.';
  $('grade-calibrate-prompt').hidden = !!calibration;
  $('grading-screen').hidden = !calibration;
  $('settings-row').hidden = false;
  $('calibration-screen').hidden = true;

  if (!calibration) {
    // Still start the camera so the video-info line shows what the device delivers --
    // but don't wait on it: an unanswered permission prompt must not hold up the rest of the app.
    getSharedStream()
      .then((stream) => {
        const st = stream.getVideoTracks()[0].getSettings();
        updateVideoInfo(st.width, st.height);
      })
      .catch(() => { $('video-info').textContent = 'video: camera unavailable'; });
    return;
  }

  const lastDiameter = await db.getSetting('lastDiameter', null);
  if (lastDiameter && !$('session-diameter').value) {
    $('session-diameter').value = lastDiameter;
  }

  const stream = await getSharedStream();
  const video = $('grade-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await new Promise((resolve) => {
    if (video.videoWidth) resolve();
    else video.addEventListener('loadedmetadata', resolve, { once: true });
  });
  gradeVideoW = video.videoWidth;
  gradeVideoH = video.videoHeight;
  updateVideoInfo(gradeVideoW, gradeVideoH);

  if (calibration.aspect && Math.abs((gradeVideoW / gradeVideoH) / calibration.aspect - 1) > 0.03) {
    $('grade-calibrate-prompt-text').textContent = "The camera's picture shape changed since you calibrated -- please recalibrate.";
    $('grade-calibrate-prompt').hidden = false;
    $('grading-screen').hidden = true;
    return;
  }

  const circle = { cx: calibration.fx * gradeVideoW, cy: calibration.fy * gradeVideoH, radius: calibration.fr * gradeVideoW };
  calibrationPixels = {
    transform: transformFromCalibration(circle, gradeVideoW, gradeVideoH, { canvasSize: CANVAS_SIZE, diskPx: DISK_PX }),
    circle,
  };

  setResultOverlay(null);
  setGradeError(null);
  $('grade-status').textContent = 'Enter the disk diameter, line the disk up in the circle, then tap to grade.';
  redrawGradeOverlay();
}

function setGradeError(message) {
  const el = $('grade-error');
  el.textContent = message || '';
  el.hidden = !message;
}

async function handleManualGrade() {
  const video = $('grade-video');
  const diameterMm = parseFloat($('session-diameter').value);
  if (!diameterMm || diameterMm <= 0) {
    setGradeError(null);
    $('grade-status').textContent = 'Enter the disk diameter (mm) before grading.';
    return;
  }
  if (!video.videoWidth || !calibrationPixels) return;

  await db.setSetting('lastDiameter', diameterMm);

  try {
    // Two passes (see pipeline.js): find the disc in the calibrated region,
    // then re-crop from the full-resolution frame so it fills the size the
    // thresholds were tuned at. If either pass isn't confident, refuse to
    // grade at all rather than guess.
    const capture = captureAndMeasure(grabFrame(video), calibrationPixels.transform, diameterMm, { sharpen: SHARPEN_LEVELS[sharpenLevel], weighted: weightedOn });
    if (!capture.detected) {
      setResultOverlay(null);
      setGradeError('Error: Could not confidently find disc');
      return;
    }
    setGradeError(null);
    const { result, disk, canvas } = capture;
    // Every real disc in the reference set had dozens of detected pores at
    // minimum, even at the cleanest (Extra) grade -- a reading of zero means
    // the capture failed (out of focus, lens cap, nothing in frame), not
    // that a flawless disc was found. Don't log a grade for a failed capture.
    if (result.numPores === 0) {
      setResultOverlay(null);
      $('grade-status').textContent = 'No texture detected -- likely an out-of-focus or empty capture. Not logged; try again.';
      return;
    }
    await commitGrade(result, canvas, diameterMm, disk, { videoW: video.videoWidth, videoH: video.videoHeight, sharpenLevel });
  } catch (err) {
    $('grade-status').textContent = err.message;
  }
}

async function initSettings() {
  const savedLevel = await db.getSetting('sharpenLevel', 'light');
  sharpenLevel = SHARPEN_LEVELS[savedLevel] !== undefined ? savedLevel : 'light';
  weightedOn = (await db.getSetting('weighted', 'off')) === 'on';
  $('sharpen-mode').value = sharpenLevel;
  $('weighted-mode').value = weightedOn ? 'on' : 'off';

  $('sharpen-mode').addEventListener('change', async (e) => {
    sharpenLevel = e.target.value;
    await db.setSetting('sharpenLevel', sharpenLevel);
  });
  $('weighted-mode').addEventListener('change', async (e) => {
    weightedOn = e.target.value === 'on';
    await db.setSetting('weighted', weightedOn ? 'on' : 'off');
  });
}

export async function initGradeTab() {
  await initSettings();
  $('btn-start-calibration').addEventListener('click', startCalibrationScreen);
  $('btn-confirm-calibration').addEventListener('click', confirmCalibration);
  $('btn-cancel-calibration').addEventListener('click', async () => { stopCalibrationScreen(); await showGradingScreenIfReady(); });
  $('btn-recalibrate').addEventListener('click', startCalibrationScreen);
  $('btn-manual-grade').addEventListener('click', handleManualGrade);
  $('btn-undo-last-grade').addEventListener('click', handleUndoLastGrade);
  wireCalibPointerEvents();

  window.addEventListener('resize', () => {
    if (isGradeScreenVisible) redrawGradeOverlay();
  });

  window.addEventListener('tab-shown', (e) => {
    isGradeScreenVisible = e.detail.tab === 'grade';
    if (isGradeScreenVisible) showGradingScreenIfReady();
  });

  isGradeScreenVisible = true; // grade is the default active tab on load
  await showGradingScreenIfReady();
}
