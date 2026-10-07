// Shared disk-crop/normalize renderer.
//
// This is the ONE code path used to turn "a source image/video plus a
// pan+zoom transform" into the standardized square, black-background,
// disk-in-a-circle canvas that both the reference library (Workflow 1,
// manual pan/zoom) and the fast-grading auto-crop (Workflow 2, calibrated
// region of the live video) rely on. Phase 1 used two different rendering
// paths (CSS transform for the live preview, canvas drawImage for the
// saved output) that were supposed to be equivalent and weren't -- so
// here there is deliberately only one function that ever draws a disk,
// and both workflows call it with a canvas of the exact same pixel size.
//
// Copied verbatim from cork-grader-2/js/crop.js -- it's already
// ML-agnostic (no model/classifier dependency), so v3 reuses it unchanged.

export const CANVAS_SIZE = 300; // full output canvas, px
export const DISK_PX = 260;     // visible disk diameter within the canvas, px
export const MARGIN_COLOR = '#000000';

/**
 * Draw `source` (an HTMLImageElement, HTMLVideoElement, or HTMLCanvasElement)
 * into `ctx` as a centered circular disk of diameter `diskPx` inside a
 * `canvasSize` x `canvasSize` canvas, with the area outside the circle
 * filled solid black. `transform` describes how the source is panned/zoomed
 * under the fixed circular viewport.
 *
 * transform = { offsetX, offsetY, scale }
 *   scale   : multiplier from source pixels -> canvas pixels
 *   offsetX/offsetY : shift (in canvas px) of the source's center away from
 *                      the canvas center (i.e. panning)
 */
export function drawNormalizedDisk(ctx, source, transform, opts = {}) {
  const canvasSize = opts.canvasSize ?? CANVAS_SIZE;
  const diskPx = opts.diskPx ?? DISK_PX;
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;

  ctx.save();
  ctx.clearRect(0, 0, canvasSize, canvasSize);
  ctx.fillStyle = MARGIN_COLOR;
  ctx.fillRect(0, 0, canvasSize, canvasSize);

  ctx.save();
  ctx.beginPath();
  ctx.arc(canvasSize / 2, canvasSize / 2, diskPx / 2, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(canvasSize / 2 + transform.offsetX, canvasSize / 2 + transform.offsetY);
  ctx.scale(transform.scale, transform.scale);
  ctx.drawImage(source, -sw / 2, -sh / 2, sw, sh);
  ctx.restore(); // undo clip + translate/scale

  ctx.restore();
}

/** Initial transform: fit the source's smaller dimension to fill the disk, centered. */
export function fitTransform(sourceWidth, sourceHeight, opts = {}) {
  const diskPx = opts.diskPx ?? DISK_PX;
  const scale = diskPx / Math.min(sourceWidth, sourceHeight);
  return { offsetX: 0, offsetY: 0, scale };
}

/**
 * Convert a calibration circle (defined in the source's own native pixel
 * coordinates, e.g. video pixel space) into the same {offsetX, offsetY, scale}
 * transform shape used above, so a fixed calibration region renders through
 * the identical drawNormalizedDisk() path as the manual crop UI.
 */
export function transformFromCalibration(calibration, sourceWidth, sourceHeight, opts = {}) {
  const diskPx = opts.diskPx ?? DISK_PX;
  const scale = diskPx / (2 * calibration.radius);
  const offsetX = scale * (sourceWidth / 2 - calibration.cx);
  const offsetY = scale * (sourceHeight / 2 - calibration.cy);
  return { offsetX, offsetY, scale };
}

const MIN_SCALE_FACTOR = 0.4; // relative to the fit-to-disk scale
const MAX_SCALE_FACTOR = 6;

/**
 * Wires up drag-to-pan / pinch-to-zoom / wheel-to-zoom on a canvas element
 * and keeps it re-rendered via drawNormalizedDisk. Used by the reference
 * library capture screen and by the Workflow 2 calibration screen (which
 * reuses it to let the person position/size the calibration circle).
 */
export class CropCanvas {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = { canvasSize: CANVAS_SIZE, diskPx: DISK_PX, ...opts };
    this.source = null;
    this.transform = { offsetX: 0, offsetY: 0, scale: 1 };
    this.baseScale = 1;
    this.onChange = null;

    this._pointers = new Map();
    this._pinchStartDist = null;
    this._pinchStartScale = null;
    this._dragLast = null;

    canvas.addEventListener('pointerdown', this._onPointerDown.bind(this));
    canvas.addEventListener('pointermove', this._onPointerMove.bind(this));
    canvas.addEventListener('pointerup', this._onPointerUp.bind(this));
    canvas.addEventListener('pointercancel', this._onPointerUp.bind(this));
    canvas.addEventListener('pointerleave', this._onPointerUp.bind(this));
    canvas.addEventListener('wheel', this._onWheel.bind(this), { passive: false });
  }

  setSource(source, { resetTransform = true } = {}) {
    this.source = source;
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    this.baseScale = this.opts.diskPx / Math.min(sw, sh);
    if (resetTransform) {
      this.transform = { offsetX: 0, offsetY: 0, scale: this.baseScale };
    }
    this.render();
  }

  setTransform(t) {
    this.transform = { ...this.transform, ...t };
    this.render();
  }

  render() {
    if (!this.source) return;
    drawNormalizedDisk(this.ctx, this.source, this.transform, this.opts);
    if (this.onChange) this.onChange(this.transform);
  }

  _clampScale(scale) {
    const min = this.baseScale * MIN_SCALE_FACTOR;
    const max = this.baseScale * MAX_SCALE_FACTOR;
    return Math.min(max, Math.max(min, scale));
  }

  _sourceSize() {
    return {
      sw: this.source.videoWidth || this.source.naturalWidth || this.source.width,
      sh: this.source.videoHeight || this.source.naturalHeight || this.source.height,
    };
  }

  // client (viewport) px -> canvas-internal px, using the same CSS-to-canvas
  // ratio as the drag handler below.
  _clientToCanvasPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleFactor = this.canvas.width / rect.width;
    return { x: (clientX - rect.left) * scaleFactor, y: (clientY - rect.top) * scaleFactor };
  }

  // Inverse of the mapping drawNormalizedDisk uses: canvas-internal px -> the
  // source-image point currently drawn there, given the live transform.
  _canvasPointToImagePoint(pt) {
    const { sw, sh } = this._sourceSize();
    const size = this.opts.canvasSize;
    return {
      x: (pt.x - size / 2 - this.transform.offsetX) / this.transform.scale + sw / 2,
      y: (pt.y - size / 2 - this.transform.offsetY) / this.transform.scale + sh / 2,
    };
  }

  _pinchMidpointClient() {
    const pts = [...this._pointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  _onPointerDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 1) {
      this._dragLast = { x: e.clientX, y: e.clientY };
    } else if (this._pointers.size === 2) {
      this._pinchStartDist = this._currentPinchDist();
      this._pinchStartScale = this.transform.scale;
      // Remember which point on the *image* sits under the fingers right now,
      // so we can keep that same point pinned under the fingers as the pinch
      // continues -- rather than always zooming around the image's center.
      const mid = this._pinchMidpointClient();
      const midCanvas = this._clientToCanvasPoint(mid.x, mid.y);
      this._pinchAnchorImg = this._canvasPointToImagePoint(midCanvas);
    }
  }

  _onPointerMove(e) {
    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 1 && this._dragLast) {
      const rect = this.canvas.getBoundingClientRect();
      const scaleFactor = this.canvas.width / rect.width; // CSS px -> canvas px
      const dx = (e.clientX - this._dragLast.x) * scaleFactor;
      const dy = (e.clientY - this._dragLast.y) * scaleFactor;
      this._dragLast = { x: e.clientX, y: e.clientY };
      this.setTransform({
        offsetX: this.transform.offsetX + dx,
        offsetY: this.transform.offsetY + dy,
      });
    } else if (this._pointers.size === 2) {
      const dist = this._currentPinchDist();
      if (this._pinchStartDist) {
        const ratio = dist / this._pinchStartDist;
        const newScale = this._clampScale(this._pinchStartScale * ratio);
        const mid = this._pinchMidpointClient();
        const midCanvas = this._clientToCanvasPoint(mid.x, mid.y);
        const { sw, sh } = this._sourceSize();
        const size = this.opts.canvasSize;
        this.setTransform({
          scale: newScale,
          offsetX: midCanvas.x - size / 2 - newScale * (this._pinchAnchorImg.x - sw / 2),
          offsetY: midCanvas.y - size / 2 - newScale * (this._pinchAnchorImg.y - sh / 2),
        });
      }
    }
  }

  _onPointerUp(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) {
      this._pinchStartDist = null;
      this._pinchStartScale = null;
    }
    if (this._pointers.size === 1) {
      const remaining = [...this._pointers.values()][0];
      this._dragLast = { x: remaining.x, y: remaining.y };
    } else if (this._pointers.size === 0) {
      this._dragLast = null;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    this.setTransform({ scale: this._clampScale(this.transform.scale * (1 + delta)) });
  }

  _currentPinchDist() {
    const pts = [...this._pointers.values()];
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  toBlob(type = 'image/png') {
    return new Promise((resolve) => this.canvas.toBlob(resolve, type));
  }
}
