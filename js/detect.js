// Automatic disc-boundary detection: a REFINEMENT pass on the already-
// cropped CANVAS_SIZE x CANVAS_SIZE canvas crop.js produces, not the
// from-scratch full-photo search analysis/analyze_pores.py's
// find_disk_mask() had to do in Python. Calibration already gets the disk
// roughly centered at roughly the right size -- this exists only to correct
// for imprecise calibration (circle drawn a bit too big or too small), so
// measure.js doesn't have to blindly trust the fixed DISK_PX/2 assumption.
//
// Per the user's explicit instruction, this never silently substitutes a
// fallback boundary. If it can't find a confident match, the caller must
// refuse to grade -- see grade.js.
//
// v6: sturdier than v4/v5. Those required "disc" pixels to be bright
// (V > 180) and drew the circle from the blob's centroid out to its FARTHEST
// pixel. A darker/greyer patch at the rim (IMG_3546) dropped out of the blob,
// which dragged the centroid the other way and stretched the circle -- the ring
// ended up ~8% too big and poked out on the side opposite the stain, flipping
// as the disc was rotated. Now: a lower brightness gate (the blue-slate
// background is already excluded by hue), the blob's holes are filled, and the
// circle is a least-squares fit to the blob's OUTLINE with outliers trimmed, so
// a notch or a stain can't pull it.

import { CANVAS_SIZE, DISK_PX } from './crop.js';

const HUE_MAX_DEG = 70;        // cork tan/orange vs. fixture background; equivalent to OpenCV's HUE_MAX=35 on its 0-179 scale
const MIN_DISK_VALUE = 110;    // was 180; shadows/background are excluded by hue (blue) and by being darker still
const MIN_COMPACTNESS = 0.4;   // blob area / (pi * farthest-pixel radius^2); was 0.5, relaxed since a stained rim lowers it
const OPEN_RADIUS = 2;         // px; small speckle-noise cleanup kernel
const MIN_OUTLINE_POINTS = 60; // fewer than this and the fit isn't trustworthy
const MAX_FIT_RESIDUAL = 4;    // px; median distance of the outline from the fitted circle, above which it isn't round enough to trust

const EXPECTED_RADIUS = DISK_PX / 2; // 130px -- what a perfect calibration would produce
const EXPECTED_CENTER = CANVAS_SIZE / 2; // 150px
// How far from "centered, design-size" a detected disk may be before we
// distrust it rather than grade against a possibly-wrong boundary. The
// default suits a well-calibrated single pass; pipeline.js passes looser
// bounds for its coarse first pass (a loose ring is intentional there) and
// tighter ones to verify the re-cropped second pass actually converged.
export const STRICT_BOUNDS = {
  maxCenterDrift: 25,                   // px
  minRadius: EXPECTED_RADIUS * 0.65,    // 84.5px
  maxRadius: EXPECTED_RADIUS * 1.2,     // 156px (still fits inside the 300x300 canvas)
};

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, v: max };
}

function circleOffsets(radius) {
  const offsets = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) offsets.push([dx, dy]);
    }
  }
  return offsets;
}
const OPEN_OFFSETS = circleOffsets(OPEN_RADIUS);

/** Binary erode ('min') / dilate ('max') with the given kernel offsets. */
function binaryMorph(mask, w, h, offsets, mode) {
  const out = new Uint8Array(w * h);
  const dilate = mode === 'max';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = dilate ? 0 : 1;
      for (let k = 0; k < offsets.length; k++) {
        const nx = x + offsets[k][0];
        const ny = y + offsets[k][1];
        const v = (nx < 0 || nx >= w || ny < 0 || ny >= h) ? 0 : mask[ny * w + nx];
        if (dilate) { if (v) { hit = 1; break; } }
        else if (!v) { hit = 0; break; }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

/** 8-connected component labeling; returns each blob's pixel indices, area, centroid, and farthest-pixel radius from that centroid. */
function componentBlobs(binaryMask, w, h) {
  const visited = new Uint8Array(w * h);
  const blobs = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (!binaryMask[start] || visited[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    const pixels = [];
    while (sp > 0) {
      const cur = stack[--sp];
      const cx = cur % w;
      const cy = (cur / w) | 0;
      pixels.push(cur);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (binaryMask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
      }
    }
    let sx = 0, sy = 0;
    for (const p of pixels) { sx += p % w; sy += (p / w) | 0; }
    const cx = sx / pixels.length;
    const cy = sy / pixels.length;
    let maxR = 0;
    for (const p of pixels) {
      const d = Math.hypot((p % w) + 0.5 - cx, ((p / w) | 0) + 0.5 - cy);
      if (d > maxR) maxR = d;
    }
    blobs.push({ pixels, area: pixels.length, cx, cy, radius: maxR });
  }
  return blobs;
}

/** Marks every pixel that isn't reachable from the canvas border without crossing the blob, so pores inside the disc count as disc. */
function fillHoles(blobMask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const seed = (idx) => { if (!blobMask[idx] && !outside[idx]) { outside[idx] = 1; stack[sp++] = idx; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp > 0) {
    const cur = stack[--sp];
    const x = cur % w, y = (cur / w) | 0;
    if (x > 0) seed(cur - 1);
    if (x < w - 1) seed(cur + 1);
    if (y > 0) seed(cur - w);
    if (y < h - 1) seed(cur + w);
  }
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = outside[i] ? 0 : 1;
  return filled;
}

/** Centres of the filled blob's edge pixels (those with a 4-neighbour outside it). */
function outlinePoints(filled, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled[y * w + x]) continue;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !filled[y * w + x - 1] || !filled[y * w + x + 1] || !filled[(y - 1) * w + x] || !filled[(y + 1) * w + x];
      if (edge) pts.push([x + 0.5, y + 0.5]);
    }
  }
  return pts;
}

/** Least-squares circle through the points (algebraic / Kasa fit), solved on mean-centred coordinates. */
function lsqCircle(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= n; my /= n;
  // Normal equations for  x'^2 + y'^2 = 2a x' + 2b y' + c
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [px, py] of pts) {
    const x = px - mx, y = py - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * z; syz += y * z; sz += z;
  }
  // Solve [[4sxx,4sxy,2sx],[4sxy,4syy,2sy],[2sx,2sy,n]] [a b c]^T = [2sxz,2syz,sz]^T by Cramer's rule.
  const A = [[4 * sxx, 4 * sxy, 2 * sx], [4 * sxy, 4 * syy, 2 * sy], [2 * sx, 2 * sy, n]];
  const B = [2 * sxz, 2 * syz, sz];
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det3(A);
  if (Math.abs(D) < 1e-9) return null;
  const col = (k) => A.map((row, i) => row.map((v, j) => (j === k ? B[i] : v)));
  const a = det3(col(0)) / D, b = det3(col(1)) / D, c = det3(col(2)) / D;
  const r2 = c + a * a + b * b;
  if (!(r2 > 0)) return null;
  return { cx: a + mx, cy: b + my, r: Math.sqrt(r2) };
}

/** Circle fit that repeatedly drops outline points far from the current fit (notches, crumbs, a stained rim). */
function trimmedCircleFit(pts, iterations = 4) {
  let keep = pts;
  let fit = null;
  for (let it = 0; it < iterations; it++) {
    fit = lsqCircle(keep);
    if (!fit) return null;
    const res = pts.map(([x, y]) => Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r));
    const keptRes = keep.map(([x, y]) => Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r)).sort((p, q) => p - q);
    const median = keptRes[keptRes.length >> 1];
    const tol = Math.max(1.5, 2 * 1.4826 * median);
    const next = pts.filter((_, i) => res[i] < tol);
    if (next.length < 20 || next.length === keep.length) { if (next.length >= 20) keep = next; break; }
    keep = next;
  }
  fit = lsqCircle(keep);
  if (!fit) return null;
  const finalRes = keep.map(([x, y]) => Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r)).sort((p, q) => p - q);
  return { ...fit, medianResidual: finalRes[finalRes.length >> 1] };
}

/**
 * Find the disc's actual boundary within a normalized disk canvas (as
 * produced by crop.js's drawNormalizedDisk). Returns { cx, cy, radius,
 * detected }. `detected: false` means no confident boundary was found --
 * the caller must not grade using the fallback numbers included in that
 * case, they're for logging/debugging only.
 */
export function detectDisc(source, bounds = STRICT_BOUNDS) {
  const ctx = source.getContext ? source.getContext('2d') : null;
  const { data, width, height } = ctx
    ? ctx.getImageData(0, 0, source.width || CANVAS_SIZE, source.height || CANVAS_SIZE)
    : source;

  const candidate = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const { h, v } = rgbToHsv(data[o], data[o + 1], data[o + 2]);
    if (h < HUE_MAX_DEG && v > MIN_DISK_VALUE) candidate[i] = 1;
  }

  const opened = binaryMorph(binaryMorph(candidate, width, height, OPEN_OFFSETS, 'min'), width, height, OPEN_OFFSETS, 'max');
  const blobs = componentBlobs(opened, width, height);

  let best = null;
  for (const blob of blobs) {
    const enclosingArea = Math.PI * blob.radius * blob.radius;
    const compactness = enclosingArea ? blob.area / enclosingArea : 0;
    if (compactness < MIN_COMPACTNESS) continue;
    if (!best || blob.area > best.area) best = blob;
  }

  const fallback = { cx: EXPECTED_CENTER, cy: EXPECTED_CENTER, radius: EXPECTED_RADIUS, detected: false };
  if (!best) return fallback;

  const blobMask = new Uint8Array(width * height);
  for (const p of best.pixels) blobMask[p] = 1;
  const outline = outlinePoints(fillHoles(blobMask, width, height), width, height);
  if (outline.length < MIN_OUTLINE_POINTS) return fallback;
  const fit = trimmedCircleFit(outline);
  if (!fit || fit.medianResidual > MAX_FIT_RESIDUAL) return fallback;

  const drift = Math.hypot(fit.cx - EXPECTED_CENTER, fit.cy - EXPECTED_CENTER);
  if (drift > bounds.maxCenterDrift || fit.r < bounds.minRadius || fit.r > bounds.maxRadius) {
    return fallback;
  }

  return { cx: fit.cx, cy: fit.cy, radius: fit.r, detected: true };
}
