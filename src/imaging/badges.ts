import * as PImage from 'pureimage';
import { FONT_BOLD, FONT_GREEK_BOLD, loadFonts } from './font.js';
import { encodePng } from './png.js';

/**
 * Emoji pictures Ordis draws itself because no wiki icon shows them (uploaded as application emojis by src/discord/app-emojis.ts): the
 * Arbitration tier badges S…F, the Omnia fissure (white line art like the clan's own fissure icons) and the day/night cycle. pureimage
 * smooths edges along a row only, so each picture is drawn at 4x and averaged down, which gives clean curves. 128x128 PNG, in memory.
 */

export const EMOJI_SIZE = 128;
const SS = 4;
const FULL = EMOJI_SIZE * SS;
/** Roboto's cap height in em: a capital is centred on its middle, so every badge's letter sits at the same height. */
const CAP = 0.711;

type Bitmap = ReturnType<typeof PImage.make>;
type Ctx = ReturnType<Bitmap['getContext']>;
type Gradient = ReturnType<Ctx['createLinearGradient']>;
type Paint = string | Gradient;
export type Pt = readonly [number, number];

/** Points on a circle from angle a0 to a1 (radians; y points down, so angles run clockwise on screen), about one per pixel. */
export function arc(cx: number, cy: number, r: number, a0 = 0, a1 = Math.PI * 2): Pt[] {
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) * r));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / steps;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
}

export function roundRect(x: number, y: number, w: number, h: number, r: number): Pt[] {
  const q = Math.PI / 2;
  return [...arc(x + w - r, y + r, r, -q, 0), ...arc(x + w - r, y + h - r, r, 0, q), ...arc(x + r, y + h - r, r, q, 2 * q), ...arc(x + r, y + r, r, 2 * q, 3 * q)];
}

/** A four-pointed star with curved sides. */
export function sparkle(cx: number, cy: number, r: number): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 - Math.PI / 2;
    // From this point to the next one along a curve pulled towards the centre.
    const [x0, y0] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x1, y1] = [cx + r * Math.cos(a + Math.PI / 2), cy + r * Math.sin(a + Math.PI / 2)];
    for (let i = 0; i < 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      pts.push([u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1]);
    }
  }
  return pts;
}

/** Mixes a #rrggbb colour with white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  const f = Math.abs(amount);
  const parts = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - f) + target * f));
  return `#${parts.map((p) => p.toString(16).padStart(2, '0')).join('')}`;
}

/** A pureimage bitmap starts opaque black; an emoji needs a transparent background. */
function blank(size: number): Bitmap {
  const img = PImage.make(size, size);
  img.data.fill(0);
  return img;
}

export class Canvas {
  private readonly img = blank(FULL);
  private readonly ctx = this.img.getContext('2d');

  /** A stroked line through the points with round ends and joints. Each piece is filled on its own, so overlaps leave no holes. */
  line(points: readonly Pt[], width: number, paint: Paint): this {
    const r = width / 2;
    for (let i = 0; i + 1 < points.length; i++) {
      const [x0, y0] = points[i]!;
      const [x1, y1] = points[i + 1]!;
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const nx = (-(y1 - y0) / len) * r;
      const ny = ((x1 - x0) / len) * r;
      this.fill([[[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]], paint);
    }
    for (const [x, y] of points) this.fill([arc(x, y, r)], paint);
    return this;
  }

  /** Fills the polygons as one shape: one inside another cuts a hole (even-odd). Coordinates are in the final 128 px. */
  fill(polys: Pt[][], paint: Paint): this {
    const ctx = this.ctx;
    ctx.fillStyle = paint;
    ctx.beginPath();
    for (const poly of polys) {
      const [first, ...rest] = poly;
      if (!first) continue;
      ctx.moveTo(first[0] * SS, first[1] * SS);
      for (const [x, y] of rest) ctx.lineTo(x * SS, y * SS);
      ctx.lineTo(first[0] * SS, first[1] * SS);
    }
    ctx.fill();
    return this;
  }

  /** A top-to-bottom gradient over the whole picture (pureimage wraps positions outside 0…1, so it must span everything drawn). */
  vertical(top: string, bottom: string): Gradient {
    const g = this.ctx.createLinearGradient(0, 0, 0, FULL);
    // pureimage's types say number, but it parses the CSS colour string (util.colorStringToUint32).
    g.addColorStop(0, top as unknown as number);
    g.addColorStop(1, bottom as unknown as number);
    return g;
  }

  /** Text centred on (cx, cy): horizontally by its advance, vertically by a capital's middle. */
  text(s: string, cx: number, cy: number, size: number, font: string, paint: string): this {
    const ctx = this.ctx;
    ctx.font = `${size * SS}px ${font}`;
    ctx.fillStyle = paint;
    const width = ctx.measureText(s).width;
    ctx.fillText(s, cx * SS - width / 2, (cy + (size * CAP) / 2) * SS);
    return this;
  }

  /** Each 4x4 block averaged into one pixel, weighted by alpha (so edges get no dark fringe), as a PNG. */
  async png(): Promise<Buffer> {
    const out = blank(EMOJI_SIZE);
    const src = this.img.data;
    for (let y = 0; y < EMOJI_SIZE; y++) {
      for (let x = 0; x < EMOJI_SIZE; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let dy = 0; dy < SS; dy++) {
          for (let dx = 0; dx < SS; dx++) {
            const i = ((y * SS + dy) * FULL + x * SS + dx) * 4;
            const al = src[i + 3]!;
            r += src[i]! * al;
            g += src[i + 1]! * al;
            b += src[i + 2]! * al;
            a += al;
          }
        }
        if (a) out.setPixelRGBA_i(x, y, Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / (SS * SS)));
      }
    }
    return encodePng(out);
  }
}

/** An Arbitration tier: a rounded square in the tier's colour (lighter at the top) with the letter in near-black. */
export async function tierBadge(letter: string, color: string): Promise<Buffer> {
  loadFonts();
  const c = new Canvas();
  c.fill([roundRect(4, 4, 120, 120, 30)], c.vertical(shade(color, 0.28), shade(color, -0.12)));
  // A thin lighter rim along the top edge gives the badge some depth.
  c.fill([roundRect(4, 4, 120, 120, 30), roundRect(7, 8, 114, 113, 27)], shade(color, 0.42));
  return c.text(letter, 64, 66, 84, FONT_BOLD, '#0b1220').png();
}

/** The Omnia fissure (any relic): a white ring with four points on the diagonals, like the clan's fissure icons, around an Ω. */
export async function omniaIcon(): Promise<Buffer> {
  loadFonts();
  const c = new Canvas();
  const white = '#ffffff';
  c.fill([arc(64, 64, 46), arc(64, 64, 40.5)], white);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const at = (r: number, da = 0): Pt => [64 + r * Math.cos(a + da), 64 + r * Math.sin(a + da)];
    c.fill([[at(44, -0.22), at(62), at(44, 0.22)]], white);
  }
  return c.text('Ω', 64, 64, 52, FONT_GREEK_BOLD, white).png();
}

/** The day/night cycles: a disc, its left half the sun (with rays), its right half the night sky (with stars). */
export async function cycleIcon(): Promise<Buffer> {
  const c = new Canvas();
  const half = Math.PI / 2;
  const sun = c.vertical('#fde68a', '#f59e0b');
  c.fill([arc(64, 64, 46, half, 3 * half)], sun);
  for (const a of [Math.PI * 0.78, Math.PI, Math.PI * 1.22]) {
    const at = (r: number, da: number): Pt => [64 + r * Math.cos(a + da), 64 + r * Math.sin(a + da)];
    c.fill([[at(51, -0.07), at(61, -0.045), at(61, 0.045), at(51, 0.07)]], sun);
  }
  c.fill([arc(64, 64, 46, -half, half)], c.vertical('#818cf8', '#312e81'));
  c.fill([sparkle(84, 46, 9)], '#ffffff');
  c.fill([sparkle(96, 72, 5)], '#e0e7ff');
  c.fill([sparkle(78, 88, 6)], '#ffffff');
  return c.png();
}
