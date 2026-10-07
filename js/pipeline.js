// Two-pass capture: find the disc, then re-crop straight from the source so
// the disc fills the size the thresholds were tuned at, then measure that.
//
// Why: the pore thresholds (black-hat kernel, porosity cuts) were tuned with
// the disc filling a 260px circle in the 300x300 canvas. A loose calibration
// ring works fine for *finding* the disc but leaves it smaller in the canvas,
// so the measurement would depend on how big the user drew the ring. Pass 1
// uses the calibrated region only to locate the disc; pass 2 re-renders from
// the full-resolution source with that disc centered at the design size, so
// the ring size and placement no longer matter. (Tested on 44 full-frame
// stand-ins: this reproduces the tight-ring measurements at ring sizes
// 1.3x-1.8x. It does not by itself change grading accuracy -- an earlier note
// here claiming loose rings read ~0.7x lower came from a flawed simulation.)

import { drawNormalizedDisk, transformFromCalibration, CANVAS_SIZE, DISK_PX } from './crop.js';
import { detectDisc } from './detect.js';
import { measureDisk } from './measure.js';
import { sharpenCanvas } from './sharpen.js';

// Pass 1 only has to locate the disc, so accept a small disc anywhere in the
// ring (a loose, off-center ring is the point). Pass 2 re-renders that disc at
// the design size, so it must land there: a disc that doesn't means pass 1
// misjudged it, and we refuse to grade rather than measure the wrong thing.
const PASS1_BOUNDS = { maxCenterDrift: 70, minRadius: 45, maxRadius: DISK_PX / 2 };
const PASS2_BOUNDS = { maxCenterDrift: 15, minRadius: DISK_PX / 2 * 0.9, maxRadius: DISK_PX / 2 * 1.1 };

// willReadFrequently: detect/measure both call getImageData on these.
const pass1Canvas = document.createElement('canvas');
pass1Canvas.width = pass1Canvas.height = CANVAS_SIZE;
const pass1Ctx = pass1Canvas.getContext('2d', { willReadFrequently: true });

const pass2Canvas = document.createElement('canvas');
pass2Canvas.width = pass2Canvas.height = CANVAS_SIZE;
const pass2Ctx = pass2Canvas.getContext('2d', { willReadFrequently: true });

/**
 * The transform that renders a disc found in a first-pass canvas centered at
 * the design size. Maps the detected circle back into source pixels (inverting
 * drawNormalizedDisk's mapping), then reuses transformFromCalibration.
 */
export function refinedTransform(firstTransform, disk, sourceWidth, sourceHeight) {
  const half = CANVAS_SIZE / 2;
  return transformFromCalibration({
    cx: sourceWidth / 2 + (disk.cx - half - firstTransform.offsetX) / firstTransform.scale,
    cy: sourceHeight / 2 + (disk.cy - half - firstTransform.offsetY) / firstTransform.scale,
    radius: disk.radius / firstTransform.scale,
  }, sourceWidth, sourceHeight, { diskPx: DISK_PX });
}

/**
 * `source` is anything drawNormalizedDisk accepts (a frame snapshot canvas,
 * image, or video); `firstTransform` comes from the calibration. Returns
 * { detected: false } if either pass can't confidently find the disc --
 * never a fallback measurement -- otherwise
 * { detected: true, result, disk, canvas } where `canvas` is the re-cropped
 * image that was actually measured and `disk` the boundary found in it.
 *
 * `options.sharpen` is the unsharp-mask amount (0 = off) applied to the
 * re-cropped image AFTER the disc has been found in it and BEFORE it is
 * measured (live video is softer than the stills the thresholds were tuned on;
 * see sharpen.js). `options.weighted` grades on pore porosity plus a share of
 * the discoloration (see measure.js / colour.js); discoloration is always
 * measured and returned so it can be logged either way.
 */
export function captureAndMeasure(source, firstTransform, diameterMm, options = {}) {
  drawNormalizedDisk(pass1Ctx, source, firstTransform, { canvasSize: CANVAS_SIZE, diskPx: DISK_PX });
  const coarse = detectDisc(pass1Canvas, PASS1_BOUNDS);
  if (!coarse.detected) return { detected: false };

  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const tight = refinedTransform(firstTransform, coarse, sw, sh);

  // Clip wider than the design disc (diskPx = the whole canvas) so the disc's
  // rim is never truncated and the detector sees a margin of real background.
  drawNormalizedDisk(pass2Ctx, source, tight, { canvasSize: CANVAS_SIZE, diskPx: CANVAS_SIZE });
  const disk = detectDisc(pass2Canvas, PASS2_BOUNDS);
  if (!disk.detected) return { detected: false };

  if (options.sharpen) sharpenCanvas(pass2Canvas, undefined, options.sharpen);
  const result = measureDisk(pass2Canvas, diameterMm, disk, { discoloration: true, weighted: !!options.weighted });
  return { detected: true, result, disk, canvas: pass2Canvas };
}
