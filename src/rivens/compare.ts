import type { Letter } from './grade.js';
import type { ScanResult } from './scan.js';

/**
 * The reroll question: two (or three) screenshots of rivens for the same weapon, usually the roll a riven has and the one cycling it just
 * offered, and which to keep. Pure. The bonuses come first (whether expensive rivens of the weapon carry them, the market letter), the
 * rolls second (how good the values are inside their ranges, on average, the curse counted the other way round).
 */

const POINTS: Record<Letter, number> = { S: 4, A: 3, B: 2, C: 1, D: 0 };
/** Rolls this close (percent of the average, on average per stat) are about as good as each other. */
const SAME_ROLLS = 1;

/** The average of a riven's graded rolls (+ is better, from -10 to +10), or null when none could be graded. */
export function rollScore(r: ScanResult): number | null {
  const d = (r.report?.rolls ?? []).map((x) => x.deviation).filter((x): x is number => x !== null);
  return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null;
}

const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;

interface Entry {
  n: number;
  letter: Letter | null;
  points: number;
  rolls: number | null;
  from: number | null;
}

const better = (a: Entry, b: Entry): number => b.points - a.points || (b.rolls ?? -99) - (a.rolls ?? -99);

/**
 * Which riven to keep, as one short paragraph ("**Keep #2.** …"), the pictures being numbered #1, #2 in the order they were posted.
 * Null unless every picture is a graded riven and all of them are for the same weapon: there is nothing to compare otherwise.
 */
export function compareRivens(results: ScanResult[]): string | null {
  if (results.length < 2 || results.some((r) => !r.report)) return null;
  const weapon = results[0]!.report!.weapon;
  if (results.some((r) => r.report!.weapon.slug !== weapon.slug)) return null;
  const entries: Entry[] = results.map((r, i) => {
    const g = r.report!.grade;
    const c = g?.comparable;
    return { n: i + 1, letter: g?.letter ?? null, points: g ? POINTS[g.letter] : -1, rolls: rollScore(r), from: c && c.source === 'market' ? c.min : null };
  });
  if (entries.every((e) => e.letter === null && e.rolls === null)) return null;
  const ranked = [...entries].sort(better);
  const best = ranked[0]!;
  const rest = ranked.slice(1);
  const runnerUp = rest[0]!;
  const price = best.from !== null ? ` Rivens with its bonuses are listed from ${best.from}p.` : '';
  const others = (pick: (e: Entry) => string) => rest.map((e) => `#${e.n} ${pick(e)}`).join(', ');

  if (best.points !== runnerUp.points) {
    const letters = others((e) => (e.letter ? `is ${e.letter}` : 'has no grade'));
    return `**Keep #${best.n}.** Its bonuses are what expensive ${weapon.name} rivens have (grade ${best.letter}; ${letters}).${price}`;
  }
  const kind = best.letter ? `the same kind of bonuses (grade ${best.letter})` : 'bonuses the market has too few rivens to grade';
  if (best.rolls === null || runnerUp.rolls === null || best.rolls - runnerUp.rolls < SAME_ROLLS) {
    const known = entries.filter((e) => e.rolls !== null);
    const rolls = known.length === entries.length ? `, and their rolls are about as good (${known.map((e) => `#${e.n} ${signed(e.rolls!)}`).join(', ')} on average)` : '';
    return `**Either one.** ${entries.length === 2 ? 'Both have' : 'They all have'} ${kind}${rolls}. Keep the one whose stats suit how you play.${price}`;
  }
  const versus = rest.map((e) => (e.rolls === null ? `#${e.n} not graded` : `${signed(e.rolls)} on #${e.n}`)).join(', ');
  return `**Keep #${best.n}.** ${entries.length === 2 ? 'Both have' : 'They all have'} ${kind}, and its rolls are better (${signed(best.rolls)} on average, against ${versus}).${price}`;
}
