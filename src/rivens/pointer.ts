import { PNG } from 'pngjs';
import { decodeImage } from '../ssroles/emblem.js';

/**
 * Screenshots often have the mouse pointer sitting on the riven card, and OCR turns the pointer's white arrow into garbage that
 * swallows the letters around it. This paints the pointer out of a picture. It only looks inside one band (the stat line OCR could
 * not read), so the card's artwork, which has plenty of white of its own, is never touched. Pure JavaScript, in memory only.
 */

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The pointer's body is white with no colour; the card's text is lavender and its frame is coloured too. */
const whitish = (r: number, g: number, b: number): boolean => Math.min(r, g, b) >= 195 && Math.max(r, g, b) - Math.min(r, g, b) <= 30;

/**
 * Returns the picture (as PNG bytes) with a pointer-shaped white shape inside `band` painted over with the surrounding colour, or null
 * when there is no such shape. The pointer is a compact, taller-than-wide arrow of a few hundred pixels at most.
 */
export function erasePointer(bytes: Uint8Array, mime: string, band: Box): Uint8Array | null {
  const img = decodeImage(bytes, mime);
  if (!img) return null;
  const { width: W, height: H, data } = img;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
  const bx0 = clamp(band.x0 - 10, W - 1);
  const bx1 = clamp(band.x1 + 10, W - 1);
  const by0 = clamp(band.y0 - 14, H - 1);
  const by1 = clamp(band.y1 + 14, H - 1);

  // Connected white shapes inside the band; keep the one that looks like an arrow.
  const seen = new Uint8Array(W * H);
  let best: Box | null = null;
  let bestSize = 0;
  for (let sy = by0; sy <= by1; sy++) {
    for (let sx = bx0; sx <= bx1; sx++) {
      const s = sy * W + sx;
      if (seen[s] || !whitish(data[s * 4]!, data[s * 4 + 1]!, data[s * 4 + 2]!)) continue;
      const stack = [s];
      seen[s] = 1;
      let n = 0;
      let x0 = sx;
      let x1 = sx;
      let y0 = sy;
      let y1 = sy;
      while (stack.length) {
        const p = stack.pop()!;
        n++;
        const x = p % W;
        const y = (p - x) / W;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue;
            const q = ny * W + nx;
            if (!seen[q] && whitish(data[q * 4]!, data[q * 4 + 1]!, data[q * 4 + 2]!)) {
              seen[q] = 1;
              stack.push(q);
            }
          }
        }
      }
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      const arrow = n >= 40 && n <= 900 && h >= 12 && h <= 60 && w >= 6 && w <= 36 && h >= w * 1.3 && n / (w * h) >= 0.3;
      if (arrow && n > bestSize) {
        best = { x0, y0, x1, y1 };
        bestSize = n;
      }
    }
  }
  if (!best) return null;

  // Paint a box a little larger than the arrow (it has a grey shadow and an outline) with the colour around it.
  const pad = 5;
  const px0 = clamp(best.x0 - pad, W - 1);
  const px1 = clamp(best.x1 + pad, W - 1);
  const py0 = clamp(best.y0 - pad, H - 1);
  const py1 = clamp(best.y1 + pad, H - 1);
  const ring: number[][] = [[], [], []];
  for (let y = py0 - 2; y <= py1 + 2; y++) {
    for (let x = px0 - 2; x <= px1 + 2; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (x >= px0 && x <= px1 && y >= py0 && y <= py1) continue;
      const i = (y * W + x) * 4;
      if (whitish(data[i]!, data[i + 1]!, data[i + 2]!)) continue;
      for (let c = 0; c < 3; c++) ring[c]!.push(data[i + c]!);
    }
  }
  if (!ring[0]!.length) return null;
  // The median of the ring is the card's background, not the lavender of a letter that happens to touch it.
  const fill = ring.map((values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!);
  const out = new PNG({ width: W, height: H });
  out.data = Buffer.from(data);
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      const i = (y * W + x) * 4;
      out.data[i] = fill[0]!;
      out.data[i + 1] = fill[1]!;
      out.data[i + 2] = fill[2]!;
      out.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(out);
}
