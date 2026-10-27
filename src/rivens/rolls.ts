import type { StatInput } from './grade.js';
import { CATEGORIES, DEFAULT_MULTIPLIER, baseOf, categoryOf, statKey } from './ranges.js';
import type { RivenListing, RivenWeapon } from './types.js';

/**
 * How good each rolled value on a riven is, stat by stat (not the riven as a whole). A stat's value is random within 90% to 110% of an
 * average that depends on the weapon, the stat and how many bonuses and curses the riven has. The percentage shown is where the roll sits
 * in that range (+10% is the best roll there can be). For a curse a milder (smaller) value is the better one.
 *
 * The average comes from the game's fixed ranges (ranges.ts, gradeByTable). Only when no kind of weapon and disposition makes every
 * stat of the card fit (a stat the table does not know, or a roll from a different version of the game) is it read from the rolls other
 * people are selling for the same weapon: their values are brought to one scale by dividing out the multiplier for their number of
 * bonuses and curses, the largest of them is 110% of the average, and the card's own value counts as a sample too, so it can never rate
 * above +10%. (That estimate leans on old rivens, which were rolled with other dispositions, so it is the second choice.)
 */

/** The game's multipliers by number of bonuses and whether there is a curse. */
const WEIGHTS: Record<string, { bonus: number; curse: number }> = {
  '2+0': { bonus: 0.99, curse: 0 },
  '2+1': { bonus: 1.2375, curse: 0.495 },
  '3+0': { bonus: 0.75, curse: 0 },
  '3+1': { bonus: 0.9375, curse: 0.75 },
};

/** Fewer samples than this and a range can not be trusted. */
export const MIN_SAMPLES = 8;

export const weightOf = (bonuses: number, curse: boolean, asCurse: boolean): number | null => {
  const w = WEIGHTS[`${bonuses}+${curse ? 1 : 0}`];
  if (!w) return null;
  const v = asCurse ? w.curse : w.bonus;
  return v > 0 ? v : null;
};

export interface RollGrade {
  slug: string;
  value: number | null;
  curse: boolean;
  /** How far the roll is from the middle of its range, in percent of the average, with + meaning better (-10 to +10). Null without enough data or a value. */
  deviation: number | null;
  letter: string | null;
  /** Listings the range was worked out from. */
  samples: number;
}

/** The letter for a deviation (percent, + is better). */
export function letterFor(deviation: number): string {
  const bands: [number, string][] = [[8, 'A+'], [6, 'A'], [3.5, 'A-'], [1.5, 'B+'], [-0.5, 'B'], [-2.5, 'B-'], [-4.5, 'C+'], [-6.5, 'C'], [-9.5, 'C-']];
  return bands.find(([min]) => deviation >= min)?.[1] ?? 'D';
}

/** Weapon-wide statistics: for each stat and role, the scaled values (|value| / multiplier) seen in the listings. */
function units(listings: RivenListing[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const l of listings) {
    const bonuses = l.stats.filter((s) => s.positive).length;
    const curse = l.stats.some((s) => !s.positive);
    for (const s of l.stats) {
      if (s.value === null || !Number.isFinite(s.value) || s.value === 0) continue;
      const w = weightOf(bonuses, curse, !s.positive);
      if (!w) continue;
      const key = `${s.slug}:${s.positive ? 'b' : 'c'}`;
      const list = out.get(key);
      const unit = Math.abs(s.value) / w;
      if (list) list.push(unit);
      else out.set(key, [unit]);
    }
  }
  return out;
}

/** A roll further from the middle than this (percent) can not have come from the range that was tried; the extra is for rounding. */
const FIT = 10.7;

const clampDeviation = (d: number): number => Math.max(-10, Math.min(10, d));

/**
 * Grades from the game's fixed ranges (ranges.ts): every stat of the card must fall inside the range its kind of weapon and layout allow,
 * with the weapon's disposition (an old riven was rolled with it) or the current constant. The kind of weapon comes from the market when
 * it says; otherwise every kind is tried and the first whose ranges hold every stat is taken (a rifle's damage range is not a pistol's).
 * Null when no combination fits (then the rolls other people are selling are the only guide).
 */
function gradeByTable(positives: StatInput[], negative: StatInput | null, weapon: Pick<RivenWeapon, 'type' | 'disposition'> | null | undefined): RollGrade[] | null {
  const bonuses = positives.length;
  const hasCurse = negative !== null;
  const stats = [...positives.map((s) => ({ s, curse: false })), ...(negative ? [{ s: negative, curse: true }] : [])];
  if (!stats.some(({ s }) => s.value !== null && s.value !== undefined)) return null;
  const hinted = categoryOf(weapon?.type);
  const kinds = [...(hinted ? [hinted] : []), ...CATEGORIES.filter((c) => c !== hinted)];
  const multipliers = [...new Set([...(weapon?.disposition ? [weapon.disposition] : []), DEFAULT_MULTIPLIER])];
  for (const kind of kinds) {
    for (const k of multipliers) {
      const out: RollGrade[] = [];
      let fits = true;
      for (const { s, curse } of stats) {
        const value = s.value ?? null;
        const none: RollGrade = { slug: s.slug, value, curse, deviation: null, letter: null, samples: 0 };
        const w = weightOf(bonuses, hasCurse, curse);
        const base = baseOf(kind, s.slug);
        if (base === null || !w) { fits = false; break; }
        if (value === null) { out.push(none); continue; }
        // A faction multiplier (x1.51, x0.74) is measured by how far it is from x1.
        const measured = statKey(s.slug) === 'faction' ? Math.abs(value - 1) : Math.abs(value);
        const raw = (measured / (base * k * w) - 1) * 100;
        const deviation = curse ? -raw : raw;
        if (Math.abs(deviation) > FIT) { fits = false; break; }
        const d = clampDeviation(deviation);
        out.push({ ...none, deviation: d, letter: letterFor(d) });
      }
      if (fits) return out;
    }
  }
  return null;
}

/** Grades every stat of a riven (bonuses first, then the curse). */
export function gradeRolls(listings: RivenListing[], positives: StatInput[], negative: StatInput | null, weapon?: Pick<RivenWeapon, 'type' | 'disposition'> | null): RollGrade[] {
  const fixed = gradeByTable(positives, negative, weapon);
  if (fixed) return fixed;
  const seen = units(listings);
  const bonuses = positives.length;
  const hasCurse = negative !== null;
  const stats = [...positives.map((s) => ({ s, curse: false })), ...(negative ? [{ s: negative, curse: true }] : [])];
  return stats.map(({ s, curse }): RollGrade => {
    const value = s.value ?? null;
    const w = weightOf(bonuses, hasCurse, curse);
    const sample = seen.get(`${s.slug}:${curse ? 'c' : 'b'}`) ?? [];
    const none: RollGrade = { slug: s.slug, value, curse, deviation: null, letter: null, samples: sample.length };
    if (value === null || !w || sample.length < MIN_SAMPLES) return none;
    const own = Math.abs(value) / w;
    const average = Math.max(own, ...sample) / 1.1;
    const raw = (own / average - 1) * 100;
    // A milder curse is the better roll.
    const deviation = Math.max(-10, Math.min(10, curse ? -raw : raw));
    return { ...none, deviation, letter: letterFor(deviation) };
  });
}
