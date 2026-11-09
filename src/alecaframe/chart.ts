import * as PImage from 'pureimage';
import { COLORS } from '../discord/style.js';
import { type Pt, arc, roundRect, shade } from '../imaging/badges.js';
import { FONT, FONT_BOLD, loadFonts } from '../imaging/font.js';
import { encodePng } from '../imaging/png.js';
import { type AlecaStats, type Share, shares } from './api.js';

/**
 * A member's AlecaFrame stats as one picture: a header (name, period, MR, completion) and a panel per shared currency (platinum,
 * ducats, endo, credits, Aya, Vitus Essence) with its current amount, the change over the period and a line with a shaded area. Drawn
 * at twice the size and averaged down (pureimage smooths edges along a row only), in memory.
 */

const SS = 2;
const W = 960;
const PAD = 24;
const GAP = 16;
const HEAD = 96;
const PANEL_H = 204;
const FOOT = 34;
const PANEL_W = (W - PAD * 2 - GAP) / 2;
/** A line drawn with more points than this is thinned (one point per bucket of time). */
const MAX_POINTS = 150;

const BG = '#0b0d11';
const PANEL = '#151922';
const TEXT = '#e9edf3';
const MUTED = '#8a93a3';
const UP = '#4ade80';
const DOWN = '#f87171';
const BRAND = `#${COLORS.brand.toString(16).padStart(6, '0')}`;

type Key = 'plat' | 'ducats' | 'endo' | 'credits' | 'aya' | 'vitus';

const SERIES: readonly { key: Key; share: Share; label: string; color: string; compact: boolean }[] = [
  { key: 'plat', share: 'platinum', label: 'Platinum', color: '#60a5fa', compact: false },
  { key: 'ducats', share: 'ducats', label: 'Ducats', color: '#fbbf24', compact: false },
  { key: 'endo', share: 'endo', label: 'Endo', color: '#fb7185', compact: false },
  { key: 'credits', share: 'credits', label: 'Credits', color: '#cbd5e1', compact: true },
  { key: 'aya', share: 'aya', label: 'Aya', color: '#c084fc', compact: false },
  { key: 'vitus', share: 'vitus', label: 'Vitus Essence', color: '#34d399', compact: false },
];

export interface SeriesView {
  key: Key;
  label: string;
  color: string;
  compact: boolean;
  /** Oldest first; the first one may be the last reading before the period (its time is then the period's start). */
  points: { at: number; v: number }[];
  now: number;
  /** Since the start of the period; null with a single reading. */
  change: number | null;
}

/** 1,234,567 or, compact, 1.2M. */
export function amount(n: number, compact = false): string {
  const abs = Math.abs(n);
  if (compact && abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (compact && abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (compact && abs >= 1e4) return `${Math.round(n / 1e3)}k`;
  return Math.round(n).toLocaleString('en-US');
}

/** The shared currencies over a period (pure): only what the link shares, each with its readings since `since`. */
export function statSeries(stats: AlecaStats, since: number): SeriesView[] {
  const out: SeriesView[] = [];
  for (const s of SERIES) {
    const all = stats.points.map((p) => ({ at: p.at, v: p[s.key] })).filter((p): p is { at: number; v: number } => typeof p.v === 'number');
    // A link without flags (an old one) shows what has data.
    if (!all.length || !(shares(stats.parts, s.share) || (stats.parts === 0 && all.some((p) => p.v !== 0)))) continue;
    const inPeriod = all.filter((p) => p.at >= since);
    const before = all.filter((p) => p.at < since).at(-1);
    const points = before ? [{ at: since, v: before.v }, ...inPeriod] : inPeriod;
    if (!points.length) points.push(all.at(-1)!);
    const now = points.at(-1)!.v;
    out.push({ key: s.key, label: s.label, color: s.color, compact: s.compact, points, now, change: points.length > 1 ? now - points[0]!.v : null });
  }
  return out;
}

/** At most `max` points: the last reading of each equal slice of time, plus the first one. */
function thin(points: { at: number; v: number }[], max: number): { at: number; v: number }[] {
  if (points.length <= max) return points;
  const t0 = points[0]!.at;
  const span = points.at(-1)!.at - t0 || 1;
  const buckets = new Map<number, { at: number; v: number }>();
  for (const p of points) buckets.set(Math.min(max - 2, Math.floor(((p.at - t0) / span) * (max - 1))), p);
  return [points[0]!, ...[...buckets.values()].filter((p) => p !== points[0])];
}

const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const stamp = (t: number) => `${day(t)} ${new Date(t).toISOString().slice(11, 16)} UTC`;

type Bitmap = ReturnType<typeof PImage.make>;
type Ctx = ReturnType<Bitmap['getContext']>;
type Gradient = ReturnType<Ctx['createLinearGradient']>;

class Drawing {
  private readonly img: Bitmap;
  private readonly ctx: Ctx;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.img = PImage.make(width * SS, height * SS);
    this.ctx = this.img.getContext('2d');
    this.ctx.fillStyle = BG;
    this.ctx.fillRect(0, 0, width * SS, height * SS);
  }

  poly(points: readonly Pt[], paint: string | Gradient): void {
    const [first, ...rest] = points;
    if (!first) return;
    const ctx = this.ctx;
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.moveTo(first[0] * SS, first[1] * SS);
    for (const [x, y] of rest) ctx.lineTo(x * SS, y * SS);
    ctx.lineTo(first[0] * SS, first[1] * SS);
    ctx.fill();
  }

  /** A vertical gradient from `top` to `bottom` (pureimage wraps positions outside it, so it must cover what it paints). */
  gradient(top: number, bottom: number, from: string, to: string): Gradient {
    const g = this.ctx.createLinearGradient(0, top * SS, 0, bottom * SS);
    // pureimage's types say number, but it parses the CSS colour string.
    g.addColorStop(0, from as unknown as number);
    g.addColorStop(1, to as unknown as number);
    return g;
  }

  /** A polyline of the given width: a quad per segment and a disc at every bend. */
  line(points: readonly Pt[], width: number, color: string): void {
    const h = width / 2;
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1]!;
      const [x2, y2] = points[i]!;
      const len = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (-(y2 - y1) / len) * h;
      const ny = ((x2 - x1) / len) * h;
      this.poly([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]], color);
      if (i < points.length - 1) this.poly(arc(x2, y2, h), color);
    }
  }

  /** Text with its baseline at y; `right` aligns its end to x. Shrinks to fit `maxWidth`. */
  text(s: string, x: number, y: number, size: number, bold: boolean, color: string, opts: { right?: boolean; center?: boolean; maxWidth?: number } = {}): void {
    const ctx = this.ctx;
    let px = size;
    for (;;) {
      ctx.font = `${px * SS}px ${bold ? FONT_BOLD : FONT}`;
      if (!opts.maxWidth || px <= 9 || ctx.measureText(s).width <= opts.maxWidth * SS) break;
      px -= 1;
    }
    const w = ctx.measureText(s).width;
    ctx.fillStyle = color;
    ctx.fillText(s, opts.right ? x * SS - w : opts.center ? x * SS - w / 2 : x * SS, y * SS);
  }

  /** Each 2x2 block averaged into one pixel, as a PNG. */
  async png(): Promise<Buffer> {
    const out = PImage.make(this.width, this.height);
    const src = this.img.data;
    const dst = out.data;
    const rowBytes = this.width * SS * 4;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = y * SS * rowBytes + x * SS * 4;
        const o = (y * this.width + x) * 4;
        for (let c = 0; c < 3; c++) dst[o + c] = (src[i + c]! + src[i + 4 + c]! + src[i + rowBytes + c]! + src[i + rowBytes + 4 + c]!) >> 2;
        dst[o + 3] = 255;
      }
    }
    return encodePng(out);
  }
}

function panel(d: Drawing, s: SeriesView, x0: number, y0: number): void {
  d.poly(roundRect(x0, y0, PANEL_W, PANEL_H, 14), PANEL);
  // A thin bar in the currency's colour along the panel's left edge.
  d.poly(roundRect(x0, y0 + 18, 4, 34, 2), s.color);
  d.text(s.label.toUpperCase(), x0 + 18, y0 + 30, 13, true, MUTED);
  d.text(amount(s.now, s.compact), x0 + 18, y0 + 64, 30, true, TEXT, { maxWidth: PANEL_W / 2 });
  if (s.change !== null) {
    const start = s.points[0]!.v;
    const pct = start > 0 && s.change !== 0 ? ` (${s.change > 0 ? '+' : ''}${((s.change / start) * 100).toFixed(Math.abs(s.change / start) < 0.1 ? 1 : 0)}%)` : '';
    const text = s.change === 0 ? 'no change' : `${s.change > 0 ? '+' : '−'}${amount(Math.abs(s.change), s.compact)}${pct}`;
    d.text(text, x0 + PANEL_W - 18, y0 + 62, 16, true, s.change > 0 ? UP : s.change < 0 ? DOWN : MUTED, { right: true, maxWidth: PANEL_W / 2 - 30 });
  }

  const left = x0 + 18;
  const right = x0 + PANEL_W - 18;
  const top = y0 + 84;
  const bottom = y0 + PANEL_H - 34;
  const pts = thin(s.points, MAX_POINTS);
  if (pts.length < 2) {
    d.text('Not enough history yet', (left + right) / 2, (top + bottom) / 2 + 5, 14, false, MUTED, { center: true });
    return;
  }
  const t0 = pts[0]!.at;
  const t1 = pts.at(-1)!.at;
  let lo = Math.min(...pts.map((p) => p.v));
  let hi = Math.max(...pts.map((p) => p.v));
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const room = (hi - lo) * 0.1;
  const y = (v: number) => bottom - ((v - (lo - room)) / (hi - lo + room * 2)) * (bottom - top);
  const x = (t: number) => left + ((t - t0) / (t1 - t0 || 1)) * (right - left);
  const line: Pt[] = pts.map((p) => [x(p.at), y(p.v)] as const);
  d.poly([...line, [right, bottom], [left, bottom]], d.gradient(top, bottom, shade(s.color, -0.62), PANEL));
  d.poly([[left, bottom - 0.5], [right, bottom - 0.5], [right, bottom + 0.5], [left, bottom + 0.5]], '#262c38');
  d.line(line, 2.4, s.color);
  // The latest reading as a dot.
  d.poly(arc(line.at(-1)![0], line.at(-1)![1], 3.6), s.color);

  const low = Math.min(...s.points.map((p) => p.v));
  const high = Math.max(...s.points.map((p) => p.v));
  d.text(day(t0), left, y0 + PANEL_H - 12, 12, false, MUTED);
  d.text(day(t1), right, y0 + PANEL_H - 12, 12, false, MUTED, { right: true });
  d.text(`low ${amount(low, s.compact)} · high ${amount(high, s.compact)}`, (left + right) / 2, y0 + PANEL_H - 12, 12, false, MUTED, { center: true });
}

export interface ChartOptions {
  since: number;
  /** "Last 30 days". */
  periodLabel: string;
}

/** The picture, or null when the link shares no currency. */
export async function drawStatsChart(stats: AlecaStats, opts: ChartOptions): Promise<Buffer | null> {
  const series = statSeries(stats, opts.since);
  if (!series.length) return null;
  loadFonts();
  const rows = Math.ceil(series.length / 2);
  const height = HEAD + rows * PANEL_H + (rows - 1) * GAP + FOOT;
  const d = new Drawing(W, height);

  d.poly([[0, 0], [W, 0], [W, 3], [0, 3]], BRAND);
  d.text(stats.username ?? 'AlecaFrame stats', PAD, 46, 28, true, TEXT, { maxWidth: W - PAD * 2 });
  const last = stats.points.at(-1);
  const facts = [
    `AlecaFrame · ${opts.periodLabel}`,
    last && shares(stats.parts, 'account') && last.mr ? `MR ${last.mr}` : null,
    last && shares(stats.parts, 'account') && last.completion ? `${last.completion}% complete` : null,
    stats.updatedAt ? `updated ${stamp(stats.updatedAt)}` : null,
  ].filter(Boolean);
  d.text(facts.join('  ·  '), PAD, 76, 15, false, MUTED, { maxWidth: W - PAD * 2 });

  series.forEach((s, i) => panel(d, s, PAD + (i % 2) * (PANEL_W + GAP), HEAD + Math.floor(i / 2) * (PANEL_H + GAP)));
  d.text('Data from AlecaFrame (stats.alecaframe.com), shared by its owner', PAD, height - 13, 12, false, MUTED);
  return d.png();
}
