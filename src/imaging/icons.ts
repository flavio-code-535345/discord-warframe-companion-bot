import { Canvas, type Pt, arc, sparkle } from './badges.js';

/**
 * More emoji pictures Ordis draws itself (uploaded as application emojis by src/discord/app-emojis.ts), for what the wiki has no icon
 * for: the day, night, warm and cold of the open worlds, the Cambion Drift's Fass and Vome, Duviri's five moods as faces, and two
 * markers (a star for a reward worth a detour, a bolt for a quick fissure). Same style as badges.ts: flat shapes with a vertical
 * gradient, drawn at 4x and averaged down, 128x128 PNG.
 */

/** Points along a quadratic Bézier curve (end point included, start point not). */
function bezier(p0: Pt, c: Pt, p1: Pt, steps = 14): Pt[] {
  return Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    const u = 1 - t;
    return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]] as const;
  });
}

/** A closed outline from a start point and a list of [control, end] curves. */
function outline(start: Pt, curves: readonly (readonly [Pt, Pt])[]): Pt[] {
  const pts: Pt[] = [start];
  let from = start;
  for (const [control, end] of curves) {
    pts.push(...bezier(from, control, end));
    from = end;
  }
  return pts;
}

/** The shape scaled about a point. */
const scaled = (pts: readonly Pt[], about: Pt, k: number): Pt[] => pts.map((p) => [about[0] + (p[0] - about[0]) * k, about[1] + (p[1] - about[1]) * k] as const);

/** A crescent: the first circle without the second. */
export function crescent(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const n = 360;
  const on = (c: Pt, r: number, i: number): Pt => [c[0] + r * Math.cos((2 * Math.PI * i) / n), c[1] + r * Math.sin((2 * Math.PI * i) / n)];
  // The points of one circle that pass a test, as one run in order (the run may wrap past the start of the circle).
  const run = (c: Pt, r: number, keep: (p: Pt) => boolean): Pt[] => {
    const all = Array.from({ length: n }, (_, i) => on(c, r, i));
    const start = all.findIndex((p, i) => keep(p) && !keep(all[(i + n - 1) % n]!));
    if (start < 0) return all.filter(keep);
    const out: Pt[] = [];
    for (let k = 0; k < n && keep(all[(start + k) % n]!); k++) out.push(all[(start + k) % n]!);
    return out;
  };
  const outer = run(c1, r1, (p) => Math.hypot(p[0] - c2[0], p[1] - c2[1]) >= r2);
  const inner = run(c2, r2, (p) => Math.hypot(p[0] - c1[0], p[1] - c1[1]) < r1);
  const last = outer[outer.length - 1]!;
  const dist = (p: Pt) => Math.hypot(p[0] - last[0], p[1] - last[1]);
  // The inner arc is walked from the end nearest to where the outer arc stopped.
  return [...outer, ...(dist(inner[0]!) <= dist(inner[inner.length - 1]!) ? inner : [...inner].reverse())];
}

/** A star with `points` tips. */
function star(cx: number, cy: number, outerR: number, innerR: number, points = 5): Pt[] {
  return Array.from({ length: points * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 === 0 ? outerR : innerR;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
}

/** Day: a sun with eight rays. */
export async function dayIcon(): Promise<Buffer> {
  const c = new Canvas();
  const sun = c.vertical('#fde047', '#f59e0b');
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const at = (r: number, da: number): Pt => [64 + r * Math.cos(a + da), 64 + r * Math.sin(a + da)];
    c.fill([[at(37, -0.19), at(60, 0), at(37, 0.19)]], sun);
  }
  return c.fill([arc(64, 64, 29)], sun).png();
}

/** Night: a crescent moon with two stars. */
export async function nightIcon(): Promise<Buffer> {
  const c = new Canvas();
  c.fill([crescent([58, 66], 46, [82, 52], 38)], c.vertical('#e0e7ff', '#818cf8'));
  c.fill([sparkle(94, 44, 10)], '#ffffff');
  c.fill([sparkle(106, 80, 6)], '#e0e7ff');
  return c.png();
}

/** Warm (Orb Vallis): a flame with a bright core. */
export async function warmIcon(): Promise<Buffer> {
  const c = new Canvas();
  const flame = outline([64, 6], [
    [[96, 30], [98, 66]],
    [[100, 104], [64, 120]],
    [[28, 104], [26, 70]],
    [[24, 50], [46, 34]],
    [[52, 24], [64, 6]],
  ]);
  c.fill([flame], c.vertical('#fb923c', '#dc2626'));
  return c.fill([scaled(flame, [64, 112], 0.52)], '#fde047').png();
}

/** Cold (Orb Vallis): a snowflake. */
export async function coldIcon(): Promise<Buffer> {
  const c = new Canvas();
  const ice = '#7dd3fc';
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 - Math.PI / 2;
    const at = (r: number, da = 0): Pt => [64 + r * Math.cos(a + da), 64 + r * Math.sin(a + da)];
    c.line([at(0), at(52)], 8, ice);
    // A pair of branches a little over halfway out.
    const [bx, by] = at(33);
    for (const side of [-1, 1]) c.line([[bx, by], [bx + 17 * Math.cos(a + side * 0.9), by + 17 * Math.sin(a + side * 0.9)]], 7, ice);
  }
  return c.fill([arc(64, 64, 11)], '#e0f2fe').png();
}

/** A glowing orb with a four-pointed spark: the Cambion Drift's Fass (orange) and Vome (blue). */
async function orb(top: string, bottom: string, spark: string): Promise<Buffer> {
  const c = new Canvas();
  c.fill([arc(64, 64, 46)], c.vertical(top, bottom));
  return c.fill([sparkle(64, 64, 26)], spark).png();
}
export const fassIcon = (): Promise<Buffer> => orb('#fdba74', '#c2410c', '#fff7ed');
export const vomeIcon = (): Promise<Buffer> => orb('#7dd3fc', '#0369a1', '#f0f9ff');

export type Mood = 'joy' | 'anger' | 'envy' | 'sorrow' | 'fear';

const FACES: Record<Mood, readonly [string, string]> = {
  joy: ['#fde047', '#eab308'],
  anger: ['#fb7185', '#e11d48'],
  envy: ['#86efac', '#16a34a'],
  sorrow: ['#7dd3fc', '#2563eb'],
  fear: ['#d8b4fe', '#9333ea'],
};

/** Duviri's moods as faces: a round face in the mood's colour with eyes, brows and a mouth. */
export async function moodIcon(mood: Mood): Promise<Buffer> {
  const ink = '#1f2937';
  const c = new Canvas();
  c.fill([arc(64, 64, 48)], c.vertical(...FACES[mood]));
  const dot = (x: number, y: number, r = 6) => c.fill([arc(x, y, r)], ink);
  const brow = (x0: number, y0: number, x1: number, y1: number) => c.line([[x0, y0], [x1, y1]], 7, ink);
  switch (mood) {
    case 'joy':
      dot(46, 52);
      dot(82, 52);
      c.line(arc(64, 58, 28, Math.PI * 0.22, Math.PI * 0.78), 8, ink);
      break;
    case 'anger':
      dot(46, 62);
      dot(82, 62);
      brow(32, 40, 56, 52);
      brow(96, 40, 72, 52);
      c.line(arc(64, 108, 24, Math.PI * 1.22, Math.PI * 1.78), 8, ink);
      break;
    case 'envy':
      // Eyes glancing to the side, a raised brow on each, a flat mouth.
      dot(52, 58, 7);
      dot(88, 58, 7);
      brow(34, 46, 58, 42);
      brow(70, 42, 94, 46);
      c.line([[44, 92], [84, 88]], 8, ink);
      break;
    case 'sorrow':
      dot(46, 58);
      dot(82, 58);
      brow(30, 46, 56, 38);
      brow(98, 46, 72, 38);
      c.line(arc(64, 104, 20, Math.PI * 1.22, Math.PI * 1.78), 8, ink);
      c.fill([[[96, 62], [90, 76], [102, 76]]], '#dbeafe').fill([arc(96, 79, 7)], '#dbeafe');
      break;
    case 'fear':
      c.fill([arc(46, 54, 12)], '#ffffff').fill([arc(82, 54, 12)], '#ffffff');
      dot(46, 56, 5);
      dot(82, 56, 5);
      brow(32, 32, 56, 36);
      brow(96, 32, 72, 36);
      c.fill([arc(64, 94, 11)], ink);
      break;
  }
  return c.png();
}

/** A gold star: marks a reward worth a detour. */
export async function starIcon(): Promise<Buffer> {
  const c = new Canvas();
  return c.fill([star(64, 68, 58, 25)], c.vertical('#fde047', '#f59e0b')).png();
}

/** A lightning bolt: marks the quick fissure missions. */
export async function boltIcon(): Promise<Buffer> {
  const c = new Canvas();
  const bolt: Pt[] = [[78, 4], [26, 74], [58, 74], [46, 124], [102, 48], [70, 48]];
  return c.fill([bolt], c.vertical('#fde047', '#f97316')).png();
}
