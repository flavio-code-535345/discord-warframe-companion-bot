import { PNG } from 'pngjs';
import { decodeImage } from '../ssroles/emblem.js';

/**
 * Makes a screenshot easier for OCR: grayscale, dark backgrounds turned into dark-on-light text, contrast stretched, and small images
 * enlarged (tesseract does best on text about 30 px tall; a cropped riven card is often smaller). Pure JavaScript like the rest of the
 * image code (no native module), and the picture only ever exists in memory.
 */

const MAX_PIXELS = 12_000_000;

export interface Prepared {
  png: Uint8Array;
  width: number;
  height: number;
  inverted: boolean;
  scale: number;
  /** True when the picture was shrunk first because it was huge. */
  shrunk: boolean;
  /** Pixels of the prepared picture per pixel of the one that was handed in (the enlargement, or 1/k when it was shrunk by k). */
  sourceScale: number;
}

export function scaleFor(width: number, height: number): number {
  const longest = Math.max(width, height);
  let scale = longest < 800 ? 3 : longest < 1700 ? 2 : 1;
  while (scale > 1 && width * height * scale * scale > MAX_PIXELS) scale--;
  return scale;
}

/** Pictures wider than this are shrunk (4K screenshots make tesseract take minutes, and the card text is large enough to read at half size). */
const BIG_SIDE = 2600;
const TARGET_SIDE = 2000;

/** Averages k x k blocks of an RGBA picture. */
function shrink(img: { width: number; height: number; data: Uint8Array }, k: number): { width: number; height: number; data: Uint8Array } {
  const width = Math.floor(img.width / k);
  const height = Math.floor(img.height / k);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) sum += img.data[(((y * k + dy) * img.width) + x * k + dx) * 4 + c]!;
        data[(y * width + x) * 4 + c] = Math.round(sum / (k * k));
      }
      data[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data };
}

export function prepareForOcr(bytes: Uint8Array, mime: string): Prepared | null {
  const decoded = decodeImage(bytes, mime);
  if (!decoded) return null;
  const longest = Math.max(decoded.width, decoded.height);
  const shrunk = longest > BIG_SIDE;
  const k = Math.ceil(longest / TARGET_SIDE);
  const img = shrunk ? shrink(decoded, k) : decoded;
  const { width, height, data } = img;
  const gray = new Uint8Array(width * height);
  const histogram = new Array<number>(256).fill(0);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = Math.round(0.299 * data[i * 4]! + 0.587 * data[i * 4 + 1]! + 0.114 * data[i * 4 + 2]!);
    gray[i] = g;
    histogram[g]!++;
    sum += g;
  }
  // Light text on a dark card is the usual look of the game; tesseract reads dark text on a light background better.
  const inverted = sum / gray.length < 120;
  // Stretch the middle 96% of the brightness range over 0-255, so a dull screenshot gets full contrast.
  const cut = gray.length * 0.02;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && acc + histogram[lo]! < cut; lo++) acc += histogram[lo]!;
  for (let acc = 0; hi > 0 && acc + histogram[hi]! < cut; hi--) acc += histogram[hi]!;
  const span = Math.max(1, hi - lo);
  const level = (g: number) => {
    const v = Math.min(255, Math.max(0, Math.round(((g - lo) / span) * 255)));
    return inverted ? 255 - v : v;
  };

  const scale = scaleFor(width, height);
  const w = width * scale;
  const h = height * scale;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    // Bilinear sampling from the original pixels.
    const sy = Math.min(height - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const fx = sx - x0;
      const top = gray[y0 * width + x0]! * (1 - fx) + gray[y0 * width + x1]! * fx;
      const bottom = gray[y1 * width + x0]! * (1 - fx) + gray[y1 * width + x1]! * fx;
      const v = level(top * (1 - fy) + bottom * fy);
      const o = (y * w + x) * 4;
      out.data[o] = v;
      out.data[o + 1] = v;
      out.data[o + 2] = v;
      out.data[o + 3] = 255;
    }
  }
  return { png: PNG.sync.write(out), width: w, height: h, inverted, scale, shrunk, sourceScale: shrunk ? scale / k : scale };
}
