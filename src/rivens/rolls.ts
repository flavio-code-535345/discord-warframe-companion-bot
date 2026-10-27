import type { StatInput } from './grade.js';
import type { RivenListing } from './types.js';

/**
 * How good each rolled value on a riven is, stat by stat (not the riven as a whole). A stat's value is random within 90% to 110% of an
 * average that depends on the weapon, the stat and how many bonuses and curses the riven has. The percentage shown is where the roll sits
 * in that range (+10% is the best roll there can be). For a curse a milder (smaller) value is the better one.
 *
 * The average is not taken from a table (those differ between game versions): it is read from the rolls other people are selling for the
 * same weapon. Their values are brought to one scale by dividing out the multiplier for their number of bonuses and curses, the largest
 * of them is 110% of the average, and the card's own value counts as a sample too, so it can never rate above +10%.
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

/** Grades every stat of a riven (bonuses first, then the curse). */
export function gradeRolls(listings: RivenListing[], positives: StatInput[], negative: StatInput | null): RollGrade[] {
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
