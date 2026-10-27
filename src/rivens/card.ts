import { distance } from '../ssroles/parse.js';
import type { OcrLine } from '../ssroles/parse.js';
import type { StatInput } from './grade.js';
import { norm, resolveStat } from './stats.js';
import type { RivenAttribute, RivenWeapon } from './types.js';

/**
 * Reads what OCR made of a screenshot of an unveiled riven mod card: the weapon (the first words of the riven's name, e.g.
 * "Kuva Bramma Crita-lexitis") and the stat lines ("+168.7% Critical Chance", "-45.2% Zoom"). Pure, so it is tested on made-up OCR
 * output. It forgives the usual OCR slips (a wrong letter, a lost "+", a "," for a "."), and says what it was unsure of instead of
 * guessing silently, because a wrong stat would give a confidently wrong grade.
 */

export interface CardReading {
  weapon: RivenWeapon | null;
  /** Bonus stats, in the order they appear, with their values. */
  positives: StatInput[];
  negative: StatInput | null;
  /** Stat names whose +/- sign OCR did not see; they were taken as bonuses (or, for a fourth line, the curse), which may be wrong. */
  unsureSign: string[];
  /** Lines that look like stats (a number with % or a sign) but whose name matched no riven stat. */
  unknown: string[];
  /** The stat lines as OCR gave them, for the "I read" message. */
  statLines: string[];
}

const MINUS = /[-−–—‒]/;
const STAT_LINE = /([+\-−–—‒]?)\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(%|s\b|m\b)?\s*([A-Za-z][A-Za-z '/\-]{2,})/;

/**
 * Stats the game shows with a minus when they are a *bonus* (less recoil is better), and with a plus when they are the curse. The
 * market names the attribute "Weapon Recoil" or "Recoil"; matching the name keeps this independent of its slug.
 */
const lowerIsBetter = (a: RivenAttribute): boolean => /recoil/i.test(a.name) || /recoil/.test(a.slug);

/** The attribute a possibly mis-read name means: the usual matching first, then one or two wrong letters forgiven. */
export function closestAttribute(attrs: RivenAttribute[], text: string): RivenAttribute | null {
  const exact = resolveStat(attrs, text);
  if (exact) return exact;
  const q = norm(text);
  if (q.length < 5) return null;
  const limit = Math.max(1, Math.floor(q.length / 6));
  let best: { a: RivenAttribute; d: number } | null = null;
  for (const a of attrs) {
    const d = distance(q, norm(a.name));
    if (d <= limit && (!best || d < best.d)) best = { a, d };
  }
  return best?.a ?? null;
}

/** The weapon whose name starts (or sits in) a line of the card, forgiving a wrong letter in longer names. The longest name wins. */
export function findWeapon(weapons: RivenWeapon[], lines: string[]): RivenWeapon | null {
  let best: { w: RivenWeapon; score: number } | null = null;
  for (const line of lines) {
    const words = norm(line).split(' ').filter(Boolean);
    for (const w of weapons) {
      const target = norm(w.name);
      const k = target.split(' ').length;
      const limit = target.length >= 8 ? Math.floor(target.length / 8) : 0;
      for (let i = 0; i + k <= words.length; i++) {
        const d = distance(words.slice(i, i + k).join(' '), target);
        if (d > limit) continue;
        // A longer name beats a shorter one ("Kuva Bramma" over "Bramma"), and an exact match beats a near one.
        const score = target.length * 10 - d;
        if (!best || score > best.score) best = { w, score };
      }
    }
  }
  return best?.w ?? null;
}

export function parseRivenCard(lines: OcrLine[], attrs: RivenAttribute[], weapons: RivenWeapon[]): CardReading {
  const texts = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map((l) => l.text.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const weapon = findWeapon(weapons, texts);

  const found: { attr: RivenAttribute; value: number; sign: '+' | '-' | null; line: string }[] = [];
  const unknown: string[] = [];
  for (const text of texts) {
    const m = STAT_LINE.exec(text);
    if (!m) continue;
    const [, sign, number, unit, name] = m;
    // A stat line has a % or an explicit sign; "Rank 0/8" or "MR 15" don't, and the name must not be a bare unit letter.
    if (!unit && !sign) continue;
    const attr = closestAttribute(attrs, name!.trim());
    if (!attr) {
      unknown.push(text);
      continue;
    }
    found.push({ attr, value: Number(number!.replace(',', '.')), sign: sign ? (MINUS.test(sign) ? '-' : '+') : null, line: text });
  }

  // The first four stat lines are the card's; a stat seen twice (a line OCR split or repeated) counts once.
  const seen = new Set<string>();
  const stats = found.filter((f) => (seen.has(f.attr.slug) ? false : (seen.add(f.attr.slug), true))).slice(0, 4);

  const positives: StatInput[] = [];
  let negative: StatInput | null = null;
  const unsureSign: string[] = [];
  stats.forEach((s, i) => {
    let isCurse: boolean;
    if (s.sign !== null) isCurse = lowerIsBetter(s.attr) ? s.sign === '+' : s.sign === '-';
    else {
      // Without a visible sign, a fourth line must be the curse (a riven has at most 3 bonuses); otherwise it is taken as a bonus.
      isCurse = stats.length === 4 && i === 3;
      unsureSign.push(s.attr.name);
    }
    if (isCurse && !negative) negative = { slug: s.attr.slug, value: s.value };
    else positives.push({ slug: s.attr.slug, value: s.value });
  });

  return { weapon, positives: positives.slice(0, 3), negative, unsureSign, unknown, statLines: stats.map((s) => s.line) };
}
