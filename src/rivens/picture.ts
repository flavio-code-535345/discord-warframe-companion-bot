import { PassThrough } from 'node:stream';
import * as PImage from 'pureimage';
import { FONT, FONT_BOLD, loadFonts } from '../imaging/font.js';
import { decodeImage } from '../ssroles/emblem.js';
import type { Box } from './pointer.js';
import type { RollGrade } from './rolls.js';
import type { ScanResult } from './scan.js';

/**
 * The answer to a riven screenshot as one picture: the card on the left and, on the right, a grade for every stat (how good that roll is,
 * not a grade for the riven as a whole). Drawn in pure JavaScript (pureimage, no native canvas), in memory only.
 */

const PANEL_W = 400;
const MAX_LEFT_W = 560;
const PAD = 22;
const ROW_H = 88;
const HEAD_H = 74;
const BG = '#0b0c0e';
const LAVENDER = '#b9a2e6';
const MUTED = '#7c7a86';

/** Green for the best rolls, through yellow and orange to red. */
const COLORS: Record<string, string> = {
  'A+': '#34e060',
  A: '#5ee03a',
  'A-': '#9ee03a',
  'B+': '#cfe03a',
  B: '#e3d23a',
  'B-': '#e6b43a',
  'C+': '#e8993a',
  C: '#e8793a',
  'C-': '#e9503e',
  D: '#d92b2b',
};

interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Shrinks (or, rarely, enlarges) a picture; each target pixel averages the source pixels it covers. */
function resize(src: Pixels, x0: number, y0: number, w: number, h: number, outW: number, outH: number): Pixels {
  const data = new Uint8Array(outW * outH * 4);
  const fx = w / outW;
  const fy = h / outH;
  for (let y = 0; y < outH; y++) {
    const sy0 = Math.floor(y0 + y * fy);
    const sy1 = Math.max(sy0 + 1, Math.ceil(y0 + (y + 1) * fy));
    for (let x = 0; x < outW; x++) {
      const sx0 = Math.floor(x0 + x * fx);
      const sx1 = Math.max(sx0 + 1, Math.ceil(x0 + (x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const i = (sy * src.width + sx) * 4;
          r += src.data[i]!;
          g += src.data[i + 1]!;
          b += src.data[i + 2]!;
          n++;
        }
      }
      const o = (y * outW + x) * 4;
      data[o] = n ? r / n : 0;
      data[o + 1] = n ? g / n : 0;
      data[o + 2] = n ? b / n : 0;
      data[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data };
}

/** The part of a big screenshot that holds the card: its text block plus room for the artwork above it. */
export function cardCrop(width: number, height: number, box: Box | null): { x: number; y: number; w: number; h: number } {
  if (!box || Math.max(width, height) <= 900) return { x: 0, y: 0, w: width, h: height };
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  const x0 = Math.max(0, Math.floor(box.x0 - bw * 0.55));
  const x1 = Math.min(width, Math.ceil(box.x1 + bw * 0.55));
  const y0 = Math.max(0, Math.floor(box.y0 - bh * 1.7));
  const y1 = Math.min(height, Math.ceil(box.y1 + bh * 0.5));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const pct = (d: number): string => `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(3)}%`;

/** One line per stat of the card: the value as read, the stat's name, then its grade. */
function rows(r: ScanResult): { label: string; grade: RollGrade | null }[] {
  const rolls = r.report?.rolls ?? [];
  const name = (slug: string) => r.names[slug] ?? slug;
  const val = (v: number | null | undefined) => (v === null || v === undefined ? '' : `${Math.abs(v)}%`);
  const mark = (slug: string) => (r.reading.guessed.includes(name(slug)) ? '?' : '');
  const stats = [...r.reading.positives.map((p) => ({ ...p, curse: false })), ...(r.reading.negative ? [{ ...r.reading.negative, curse: true }] : [])];
  return stats.map((s, i) => ({ label: `${s.curse ? '−' : '+'}${val(s.value)} ${name(s.slug)}${mark(s.slug)}:`, grade: rolls[i] ?? null }));
}

/** Draws the picture, or returns null when there is nothing to show next to (no picture, no weapon, no stats). */
export async function rivenPicture(r: ScanResult): Promise<Buffer | null> {
  if (!r.image || !r.report || !r.reading.weapon || !r.reading.positives.length) return null;
  const decoded = decodeImage(r.image.bytes, r.image.mime);
  if (!decoded) return null;
  loadFonts();

  const lines = rows(r);
  const panelH = PAD + HEAD_H + lines.length * ROW_H + PAD / 2;
  const crop = cardCrop(decoded.width, decoded.height, r.box);
  let scale = Math.min(Math.max(panelH, 420) / crop.h, MAX_LEFT_W / crop.w);
  scale = Math.min(scale, 1.6);
  const leftW = Math.max(1, Math.round(crop.w * scale));
  const leftH = Math.max(1, Math.round(crop.h * scale));
  const height = Math.max(panelH, leftH);
  const width = leftW + PANEL_W;

  const img = PImage.make(width, height);
  const ctx = img.getContext('2d');
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  // The screenshot, scaled, copied pixel by pixel (centred in the height when the panel is taller).
  const left = resize(decoded, crop.x, crop.y, crop.w, crop.h, leftW, leftH);
  const top = Math.floor((height - leftH) / 2);
  for (let y = 0; y < leftH; y++) {
    for (let x = 0; x < leftW; x++) {
      const i = (y * leftW + x) * 4;
      img.setPixelRGBA(x, top + y, ((left.data[i]! << 24) | (left.data[i + 1]! << 16) | (left.data[i + 2]! << 8) | 255) >>> 0);
    }
  }

  ctx.fillStyle = LAVENDER;
  ctx.font = `34px ${FONT}`;
  ctx.fillText(r.reading.weapon.name, leftW + PAD, PAD + 34);
  let y = PAD + HEAD_H;
  for (const { label, grade } of lines) {
    ctx.fillStyle = LAVENDER;
    ctx.font = `25px ${FONT}`;
    ctx.fillText(label, leftW + PAD, y + 12);
    if (grade?.letter && grade.deviation !== null) {
      ctx.fillStyle = COLORS[grade.letter] ?? MUTED;
      ctx.font = `25px ${FONT_BOLD}`;
      ctx.fillText(`Grade:  ${grade.letter}  (${pct(grade.deviation)})`, leftW + PAD, y + 46);
    } else {
      ctx.fillStyle = MUTED;
      ctx.font = `25px ${FONT}`;
      ctx.fillText('Grade:  not enough data', leftW + PAD, y + 46);
    }
    y += ROW_H;
  }

  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (c: Buffer) => chunks.push(c));
  await PImage.encodePNGToStream(img, sink);
  return Buffer.concat(chunks);
}
