import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { fitsPixelBudget } from '../imaging/size.js';

/** Pixel work for the clan emblem: decode, find the emblem above the clan name, and compare by a tiny fingerprint. */

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Side of the square grayscale thumbnail an emblem is reduced to. Only this is stored, never the image. */
export const FINGERPRINT_SIDE = 16;
export const FINGERPRINT_BYTES = FINGERPRINT_SIDE * FINGERPRINT_SIDE;

/** A stored reference may hold several fingerprints back to back (e.g. cards from different screen sizes or UI themes). */
export function splitFingerprints(blob: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + FINGERPRINT_BYTES <= blob.length; i += FINGERPRINT_BYTES) out.push(blob.slice(i, i + FINGERPRINT_BYTES));
  return out;
}

/** How well an emblem matches the best of several reference fingerprints. */
export function bestSimilarity(emblem: Uint8Array, blob: Uint8Array): number {
  return Math.max(0, ...splitFingerprints(blob).map((f) => similarity(emblem, f)));
}
/** Pearson correlation above which two emblems count as the same picture. */
export const MATCH_THRESHOLD = 0.8;

/** PNG and JPEG only (pure JS, no native code). Anything else, or a picture that declares more pixels than a screenshot can have, returns null and goes to the fallback reader. */
export function decodeImage(bytes: Uint8Array, mime: string): Pixels | null {
  if (!fitsPixelBudget(bytes)) return null;
  try {
    if (mime === 'image/png') {
      const png = PNG.sync.read(Buffer.from(bytes));
      return { width: png.width, height: png.height, data: png.data };
    }
    if (mime === 'image/jpeg') {
      const img = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {
    return null;
  }
  return null;
}

const px = (img: Pixels, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!] as const;
};
const gray = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * The emblem is the picture centred above the clan name. Its size depends on the screenshot's resolution, so the
 * search band is scaled by the height of the name line, and the picture is whatever differs from the panel colour.
 */
export function findEmblem(img: Pixels, clanLine: Box): Box | null {
  const lineH = Math.max(8, clanLine.y1 - clanLine.y0);
  const cx = Math.round((clanLine.x0 + clanLine.x1) / 2);
  const band: Box = {
    x0: Math.max(0, Math.round(cx - lineH * 3.4)),
    x1: Math.min(img.width, Math.round(cx + lineH * 3.4)),
    y0: Math.max(0, Math.round(clanLine.y0 - lineH * 4.7)),
    y1: Math.max(0, Math.round(clanLine.y0 - 2)),
  };
  if (band.x1 - band.x0 < 20 || band.y1 - band.y0 < 20) return null;

  // Panel colour: the median of the band's border pixels.
  const edge: number[][] = [];
  for (let x = band.x0; x < band.x1; x += 2) edge.push([...px(img, x, band.y0), ...px(img, x, band.y1 - 1)]);
  for (let y = band.y0; y < band.y1; y += 2) edge.push([...px(img, band.x0, y), ...px(img, band.x1 - 1, y)]);
  const med = (k: number) => edge.map((e) => e[k]!).sort((a, b) => a - b)[Math.floor(edge.length / 2)]!;
  const bg = [med(0), med(1), med(2)];
  const differs = (x: number, y: number) => {
    const [r, g, b] = px(img, x, y);
    return Math.abs(r - bg[0]!) + Math.abs(g - bg[1]!) + Math.abs(b - bg[2]!) > 45;
  };

  const w = band.x1 - band.x0;
  const h = band.y1 - band.y0;
  // The emblem is the longest unbroken stretch of rows (then columns) that differ from the panel. The CLAN heading
  // and its rule above are short separate runs, so they are ignored. Small gaps inside a run are bridged.
  const longestRun = (counts: number[], min: number, gap = 3): [number, number] | null => {
    let best: [number, number] | null = null;
    let start = -1;
    let lastActive = -1;
    const close = () => {
      if (start >= 0 && (!best || lastActive - start > best[1] - best[0])) best = [start, lastActive];
    };
    counts.forEach((v, i) => {
      if (v < min) return;
      if (start >= 0 && i - lastActive > gap) {
        close();
        start = -1;
      }
      if (start < 0) start = i;
      lastActive = i;
    });
    close();
    return best;
  };
  const rows = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (differs(band.x0 + x, band.y0 + y)) rows[y]!++;
  const ry = longestRun(rows, w * 0.1);
  if (!ry) return null;
  const cols = new Array<number>(w).fill(0);
  for (let y = ry[0]; y <= ry[1]; y++) for (let x = 0; x < w; x++) if (differs(band.x0 + x, band.y0 + y)) cols[x]!++;
  const rx = longestRun(cols, (ry[1] - ry[0] + 1) * 0.2);
  if (!rx) return null;
  const box = { x0: band.x0 + rx[0], y0: band.y0 + ry[0], x1: band.x0 + rx[1] + 1, y1: band.y0 + ry[1] + 1 };
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  // An emblem is a roughly square picture, a good fraction of the line height tall.
  if (bw < lineH * 1.5 || bh < lineH * 1.5 || bw / bh > 1.6 || bh / bw > 1.6) return null;
  return box;
}

/** A 16x16 grayscale thumbnail (box-averaged), as 256 bytes. */
export function fingerprint(img: Pixels, box: Box): Uint8Array {
  const out = new Uint8Array(FINGERPRINT_SIDE * FINGERPRINT_SIDE);
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  for (let ty = 0; ty < FINGERPRINT_SIDE; ty++) {
    for (let tx = 0; tx < FINGERPRINT_SIDE; tx++) {
      const sx0 = box.x0 + Math.floor((tx * bw) / FINGERPRINT_SIDE);
      const sx1 = Math.max(sx0 + 1, box.x0 + Math.floor(((tx + 1) * bw) / FINGERPRINT_SIDE));
      const sy0 = box.y0 + Math.floor((ty * bh) / FINGERPRINT_SIDE);
      const sy1 = Math.max(sy0 + 1, box.y0 + Math.floor(((ty + 1) * bh) / FINGERPRINT_SIDE));
      let sum = 0;
      let n = 0;
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const [r, g, b] = px(img, x, y);
          sum += gray(r, g, b);
          n++;
        }
      }
      out[ty * FINGERPRINT_SIDE + tx] = Math.round(sum / n);
    }
  }
  return out;
}

/** Pearson correlation of two fingerprints: 1 for the same picture at any brightness or size, near 0 for different ones. */
export function similarity(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}
