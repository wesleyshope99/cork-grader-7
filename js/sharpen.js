// Light unsharp mask for the measured canvas.
//
// Why: the phone's live video is measurably softer than a still photo of the
// same disc -- best matched by a ~0.75-1.0px Gaussian blur at the 300px canvas
// scale (tested on four discs: live-view screenshots vs. their stills). Fine
// pore edges lose contrast, so the thresholded pore area shrinks and grades
// come out about a step too lenient. Sharpening the live pixels by about that
// amount brought porosity back from 0.62x to 0.99x of the still (top-3 hole
// size 0.93x -> 1.01x) in that test.
//
// The amount that matches a still varies with the disc (0.45 for pore-rich discs
// up to ~1.1 for cleaner ones), so the app offers Off / Light (0.5) / Medium (1.0)
// and the caller (grade.js) passes the amount; the default below is Medium.
//
// out = in + amount * (in - gaussianBlur(in, sigma)), per colour channel.

export const SHARPEN_SIGMA = 1.0;   // px at the 300px canvas scale
export const SHARPEN_AMOUNT = 1.0;

function gaussianKernel(sigma) {
  const radius = Math.ceil(sigma * 3);
  const k = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return { k, radius };
}

/** Sharpens `canvas` in place. */
export function sharpenCanvas(canvas, sigma = SHARPEN_SIGMA, amount = SHARPEN_AMOUNT) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const { k, radius } = gaussianKernel(sigma);

  const horiz = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let t = -radius; t <= radius; t++) {
          const xx = Math.min(w - 1, Math.max(0, x + t));
          acc += k[t + radius] * px[(y * w + xx) * 4 + c];
        }
        horiz[(y * w + x) * 3 + c] = acc;
      }
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let blurred = 0;
        for (let t = -radius; t <= radius; t++) {
          const yy = Math.min(h - 1, Math.max(0, y + t));
          blurred += k[t + radius] * horiz[(yy * w + x) * 3 + c];
        }
        const o = (y * w + x) * 4 + c;
        const v = px[o] + amount * (px[o] - blurred);
        px[o] = v < 0 ? 0 : v > 255 ? 255 : v;   // Uint8ClampedArray rounds on store
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
