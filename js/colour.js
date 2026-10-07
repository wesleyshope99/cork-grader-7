// Discoloration: how much of the disc differs in COLOUR from the disc's own
// normal colour and lighting -- pale grey blotches, pinkish/reddish stains,
// shallow pores whose interior is no darker than the cork around them. The
// brightness-based pore test in measure.js can't see those (V = max(R,G,B)
// barely changes), but they still detract from a disc, just less than a pore.
//
// Method (tested offline on the 44 reference discs and the 6-Oct anomaly
// discs): fit a smooth model of the disc's normal colour/lighting from the
// pixels that are neither pores nor already deviating (iteratively, so a big
// blotch can't become its own reference -- the failure of an earlier
// local-median version), then flag pixels whose CIE Lab distance from that
// model exceeds a threshold. Discoloration = flagged area, NOT already counted
// as pore, as a % of the same search area the porosity uses.
//
// The model is smooth (sigma 35px at the 300px scale), so it is fitted at 1/8
// resolution -- same result, a fraction of the work, which matters on a phone.

const SIGMA_PX = 1.2;         // light pre-smoothing before comparing: suppresses grain / chroma noise
const SIGMA_MODEL = 35;       // px: how smooth the model of "normal" colour is
const MODEL_BLOCK = 8;        // the model is fitted on a grid 1/8 the size
const ITERATIONS = 4;
const EXCLUDE_DELTA_E = 10;   // pixels deviating more than this are left out of the model fit
const DELTA_E = 12;           // a pixel deviating more than this counts as discoloration
const MIN_AREA_PX = 4;        // connected patches smaller than this are noise
const INSIDE_FRAC = 0.95;     // ignore the outer rim, where bevel/shadow dominates

const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const XN = 0.95047, ZN = 1.08883;
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

function toLab(data, count) {
  const L = new Float32Array(count), A = new Float32Array(count), B = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const r = LINEAR[data[i * 4]], g = LINEAR[data[i * 4 + 1]], b = LINEAR[data[i * 4 + 2]];
    const fx = labF((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN);
    const fy = labF(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
    const fz = labF((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / ZN);
    L[i] = 116 * fy - 16;
    A[i] = 500 * (fx - fy);
    B[i] = 200 * (fy - fz);
  }
  return [L, A, B];
}

function gaussKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + radius] = v; sum += v; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, radius };
}

/** Separable Gaussian blur of one float plane (edges clamped). */
function blurPlane(src, w, h, sigma) {
  const { k, radius } = gaussKernel(sigma);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) acc += k[t + radius] * src[y * w + Math.min(w - 1, Math.max(0, x + t))];
      tmp[y * w + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) acc += k[t + radius] * tmp[Math.min(h - 1, Math.max(0, y + t)) * w + x];
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Bilinear lookup tables mapping each full-res coordinate onto the coarse grid. */
function axisTable(size, coarse) {
  const lo = new Int32Array(size), hi = new Int32Array(size), t = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const u = Math.min(coarse - 1, Math.max(0, (i + 0.5) / MODEL_BLOCK - 0.5));
    lo[i] = Math.floor(u);
    hi[i] = Math.min(coarse - 1, lo[i] + 1);
    t[i] = u - lo[i];
  }
  return { lo, hi, t };
}

/** 8-connected labelling of a binary mask; returns a mask of pixels in patches of at least `minArea`, and their count. */
function keepPatches(mask, w, h, minArea) {
  const seen = new Uint8Array(w * h), kept = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let total = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0, n = 0;
    const members = [];
    stack[sp++] = s; seen[s] = 1;
    while (sp > 0) {
      const cur = stack[--sp];
      members.push(cur); n++;
      const cx = cur % w, cy = (cur / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack[sp++] = ni; }
        }
      }
    }
    if (n >= minArea) { for (const m of members) kept[m] = 1; total += n; }
  }
  return { kept, total };
}

/**
 * `data`/`width`/`height`: the measured canvas's RGBA pixels. `poreMask`: 1 where
 * measure.js counted a pore. `disk`: { cx, cy, radius }. `searchArea`: the
 * porosity denominator, so discoloration % is on the same footing.
 * Returns { pct, mask } -- `mask` marks the discoloration pixels.
 */
export function discoloration(data, width, height, poreMask, disk, searchArea) {
  const count = width * height;
  let [L, A, B] = toLab(data, count);
  L = blurPlane(L, width, height, SIGMA_PX);
  A = blurPlane(A, width, height, SIGMA_PX);
  B = blurPlane(B, width, height, SIGMA_PX);

  const insideR2 = (INSIDE_FRAC * disk.radius) ** 2;
  const inside = new Uint8Array(count);
  const ok = new Uint8Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const dx = x + 0.5 - disk.cx, dy = y + 0.5 - disk.cy;
      if (dx * dx + dy * dy > insideR2) continue;
      inside[i] = 1;
      let nearPore = false;
      for (let oy = -1; oy <= 1 && !nearPore; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && poreMask[ny * width + nx]) { nearPore = true; break; }
        }
      }
      if (!nearPore) ok[i] = 1;
    }
  }

  const bw = Math.ceil(width / MODEL_BLOCK), bh = Math.ceil(height / MODEL_BLOCK);
  const xt = axisTable(width, bw), yt = axisTable(height, bh);
  const sigmaCoarse = SIGMA_MODEL / MODEL_BLOCK;
  const de = new Float32Array(count);
  let fit = ok.slice();

  for (let it = 0; it < ITERATIONS; it++) {
    const sums = [new Float32Array(bw * bh), new Float32Array(bw * bh), new Float32Array(bw * bh), new Float32Array(bw * bh)];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!fit[i]) continue;
        const b = ((y / MODEL_BLOCK) | 0) * bw + ((x / MODEL_BLOCK) | 0);
        sums[0][b] += L[i]; sums[1][b] += A[i]; sums[2][b] += B[i]; sums[3][b] += 1;
      }
    }
    const blurred = sums.map((s) => blurPlane(s, bw, bh, sigmaCoarse));
    const ref = [0, 1, 2].map((c) => {
      const r = new Float32Array(bw * bh);
      for (let b = 0; b < bw * bh; b++) r[b] = blurred[c][b] / Math.max(blurred[3][b], 1e-3);
      return r;
    });

    for (let y = 0; y < height; y++) {
      const y0 = yt.lo[y] * bw, y1 = yt.hi[y] * bw, fy = yt.t[y];
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const x0 = xt.lo[x], x1 = xt.hi[x], fx = xt.t[x];
        let sq = 0;
        const src = [L, A, B];
        for (let c = 0; c < 3; c++) {
          const r = ref[c];
          const top = r[y0 + x0] * (1 - fx) + r[y0 + x1] * fx;
          const bot = r[y1 + x0] * (1 - fx) + r[y1 + x1] * fx;
          const d = src[c][i] - (top * (1 - fy) + bot * fy);
          sq += d * d;
        }
        de[i] = Math.sqrt(sq);
      }
    }
    for (let i = 0; i < count; i++) fit[i] = ok[i] && de[i] < EXCLUDE_DELTA_E ? 1 : 0;
  }

  const flagged = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (inside[i] && !poreMask[i] && de[i] > DELTA_E) flagged[i] = 1;
  const { kept, total } = keepPatches(flagged, width, height, MIN_AREA_PX);
  return { pct: searchArea ? (100 * total) / searchArea : 0, mask: kept };
}
