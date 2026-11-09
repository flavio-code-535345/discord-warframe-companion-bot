import * as PImage from 'pureimage';
import { FONT, FONT_BOLD, loadFonts } from '../imaging/font.js';
import { encodePng } from '../imaging/png.js';
import { decodeImage } from '../ssroles/emblem.js';
import type { Box } from './pointer.js';
import { statKey } from './ranges.js';
import type { RollBasis, RollGrade } from './rolls.js';
import type { ScanResult } from './scan.js';
import { formatStatValue } from './stats.js';

/**
 * The answer to a riven screenshot as one picture: the card on the left and, on the right, a grade for every stat (how good that roll is,
 * not a grade for the riven as a whole), and under them the weapon's most wanted bonus stats, what rivens with these bonuses are listed for
 * and what the rolls were measured against. Drawn in pure JavaScript (pureimage, no native canvas), in memory only.
 */

const PANEL_W = 400;
const MAX_LEFT_W = 560;
const PAD = 22;
const ROW_H = 88;
const HEAD_H = 74;
const BG = '#0b0c0e';
const LAVENDER = '#b9a2e6';
const MUTED = '#7c7a86';
const RULE = '#2a2733';
const OWNED = '#34e060';
/** The footer: small capitals over one or more lines of text. */
const LABEL_H = 22;
const LINE_H = 27;
const TEXT_W = PANEL_W - PAD * 2;

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
  const mark = (slug: string) => (r.reading.guessed.includes(name(slug)) ? '?' : '');
  const stats = [...r.reading.positives.map((p) => ({ ...p, curse: false })), ...(r.reading.negative ? [{ ...r.reading.negative, curse: true }] : [])];
  // A faction multiplier is shown the way the card shows it (x0.75), combo duration in seconds, punch through as a plain number.
  const shown = (s: { slug: string; value?: number | null | undefined; curse: boolean }) => {
    if (s.value === null || s.value === undefined) return s.curse ? '−' : '+';
    return statKey(s.slug) === 'faction' ? `x${s.value}` : formatStatValue(s.slug, s.curse ? -Math.abs(s.value) : Math.abs(s.value));
  };
  return stats.map((s, i) => ({ label: `${shown(s)} ${name(s.slug)}${mark(s.slug)}:`, grade: rolls[i] ?? null }));
}

type Ctx = ReturnType<ReturnType<typeof PImage.make>['getContext']>;

const plat = (n: number): string => `${n.toLocaleString('en-US')}p`;
const KIND: Record<string, string> = { rifle: 'Rifle', shotgun: 'Shotgun', pistol: 'Pistol', archgun: 'Arch-gun', melee: 'Melee' };

/** What the rolls were measured against, in a few words. */
export function basisText(basis: RollBasis | undefined): string | null {
  if (!basis) return null;
  if (basis.source === 'listings') return 'Graded from the rolls listed for sale';
  return `${KIND[basis.kind] ?? basis.kind} riven · ${basis.disposition ? `disposition ${basis.multiplier}` : `today's range (×${basis.multiplier})`}`;
}

/** What rivens with these bonuses are listed for, in one line; null when the riven was not compared with the market. */
export function saleText(r: ScanResult): string | null {
  const g = r.report?.grade;
  if (!g) return null;
  const c = g.comparable;
  if (!c) return g.marketChecked ? 'None listed with these bonuses' : "Couldn't check warframe.market";
  if (c.source === 'top') return `From ${plat(c.min)} among the priciest listings`;
  if (!c.complete) return `From ${plat(c.min)}${c.tenth !== null ? ` · 10th cheapest ${plat(c.tenth)}` : ''}`;
  return c.count === 1 ? `1 listed · ${plat(c.min)}` : `${c.count} listed · ${plat(c.min)} – ${plat(c.max)} · median ${plat(c.median)}`;
}

/** The most wanted stats, laid out word by word over as many lines as they need; the ones this riven has as bonuses are green. */
function wantedLines(ctx: Ctx, r: ScanResult): { text: string; color: string; x: number }[][] {
  const wanted = r.report?.grade?.wanted ?? [];
  const owned = new Set(r.reading.positives.map((p) => p.slug));
  ctx.font = `20px ${FONT}`;
  const lines: { text: string; color: string; x: number }[][] = [[]];
  let x = 0;
  wanted.forEach((slug, i) => {
    const text = `${r.names[slug] ?? slug}${i < wanted.length - 1 ? ' ·' : ''}`;
    const w = ctx.measureText(text).width;
    if (x > 0 && x + w > TEXT_W) {
      lines.push([]);
      x = 0;
    }
    lines[lines.length - 1]!.push({ text, color: owned.has(slug) ? OWNED : LAVENDER, x });
    x += w + ctx.measureText(' ').width;
  });
  return wanted.length ? lines : [];
}

/** Sets the largest font from `max` down to `min` px at which `text` fits `width`. */
function fit(ctx: Ctx, text: string, family: string, max: number, min: number, width: number): void {
  let size = max;
  ctx.font = `${size}px ${family}`;
  while (size > min && ctx.measureText(text).width > width) ctx.font = `${--size}px ${family}`;
}

/**
 * Draws the picture, or returns null when there is nothing to show next to (no picture, no weapon, no stats). `label` ("#1") is drawn in
 * the top corner when several rivens are compared, so the verdict can name them.
 */
export async function rivenPicture(r: ScanResult, opts: { label?: string } = {}): Promise<Buffer | null> {
  if (!r.image || !r.report || !r.reading.weapon || !r.reading.positives.length) return null;
  const decoded = decodeImage(r.image.bytes, r.image.mime);
  if (!decoded) return null;
  loadFonts();

  const lines = rows(r);
  const probe = PImage.make(1, 1).getContext('2d');
  const wanted = wantedLines(probe, r);
  const sale = saleText(r);
  const basis = basisText(r.report.basis);
  const footerH = wanted.length || sale || basis
    ? 14 + (wanted.length ? LABEL_H + wanted.length * LINE_H + 8 : 0) + (sale ? LABEL_H + LINE_H + 8 : 0) + (basis ? 24 : 0)
    : 0;
  const panelH = PAD + HEAD_H + lines.length * ROW_H + footerH + PAD / 2;
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

  let pillW = 0;
  if (opts.label) {
    ctx.font = `18px ${FONT_BOLD}`;
    pillW = Math.ceil(ctx.measureText(opts.label).width) + 18;
    ctx.fillStyle = LAVENDER;
    ctx.fillRect(width - PAD - pillW, PAD + 8, pillW, 28);
    ctx.fillStyle = BG;
    ctx.fillText(opts.label, width - PAD - pillW + 9, PAD + 29);
  }
  ctx.fillStyle = LAVENDER;
  fit(ctx, r.reading.weapon.name, FONT, 34, 20, TEXT_W - (pillW ? pillW + 12 : 0));
  ctx.fillText(r.reading.weapon.name, leftW + PAD, PAD + 34);
  let y = PAD + HEAD_H;
  for (const { label, grade } of lines) {
    ctx.fillStyle = LAVENDER;
    // A long stat name ("Melee Damage on Heavy Attack") is made smaller until it fits the panel.
    let size = 25;
    ctx.font = `${size}px ${FONT}`;
    while (size > 14 && ctx.measureText(label).width > PANEL_W - PAD * 2) ctx.font = `${--size}px ${FONT}`;
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

  if (footerH) {
    const x = leftW + PAD;
    const label = (text: string) => {
      ctx.fillStyle = MUTED;
      ctx.font = `15px ${FONT_BOLD}`;
      ctx.fillText(text, x, y + 14);
      y += LABEL_H;
    };
    ctx.fillStyle = RULE;
    ctx.fillRect(x, y, TEXT_W, 1);
    y += 14;
    if (wanted.length) {
      label('MOST WANTED ON THIS WEAPON');
      ctx.font = `20px ${FONT}`;
      for (const line of wanted) {
        for (const part of line) {
          ctx.fillStyle = part.color;
          ctx.fillText(part.text, x + part.x, y + 19);
        }
        y += LINE_H;
      }
      y += 8;
    }
    if (sale) {
      label('LISTED WITH THESE BONUSES');
      ctx.fillStyle = r.report.grade?.comparable ? LAVENDER : MUTED;
      fit(ctx, sale, FONT, 20, 14, TEXT_W);
      ctx.fillText(sale, x, y + 19);
      y += LINE_H + 8;
    }
    if (basis) {
      ctx.fillStyle = MUTED;
      fit(ctx, basis, FONT, 16, 12, TEXT_W);
      ctx.fillText(basis, x, y + 16);
    }
  }

  return encodePng(img);
}
