import { DEFAULT_MULTIPLIER, baseOf, categoryOf, statKey, type Category } from './ranges.js';
import { weightOf } from './rolls.js';
import type { RivenListing, RivenWeapon } from './types.js';

/**
 * A check of the fixed ranges (ranges.ts) against real rivens: the listings the background read stored. A roll is random within
 * 90%-110% of its range's centre, so over many listings each stat's lowest and highest deviation should come out near -10 and +10 and the
 * mean near 0; a base value that is wrong shows as a shifted range, a stat the table lacks as "no range", an unknown weapon kind as listings
 * that fit no range. Pure, so the same code is tested without a database.
 */

export interface StatSpread {
  n: number;
  mean: number;
  min: number;
  max: number;
}

export interface KindAudit {
  listings: number;
  /** Listings whose every stat falls inside the 90%-110% window of the weapon's kind with its disposition or the current constant. */
  fit: number;
  /** Listings with a stat the table has no range for, by stat. */
  noRange: Record<string, number>;
  /** Listings with a stat outside its window, by stat. */
  outOfRange: Record<string, number>;
  /** Where the rolls sit in their windows, by stat (bonus and curse apart), from the listings that fit. */
  spread: Record<string, StatSpread>;
}

/** Same tolerance as the grader (rolls.ts): the extra covers rounding. */
const FIT = 10.7;

const emptyKind = (): KindAudit => ({ listings: 0, fit: 0, noRange: {}, outOfRange: {}, spread: {} });

/** The deviation of each stat of a listing for one kind and multiplier, or the first problem. */
function evaluate(listing: RivenListing, kind: Category, k: number): { devs: { key: string; dev: number }[] } | { bad: { slug: string; why: 'noRange' | 'outOfRange' } } {
  const bonuses = listing.stats.filter((s) => s.positive).length;
  const hasCurse = listing.stats.some((s) => !s.positive);
  const devs: { key: string; dev: number }[] = [];
  for (const s of listing.stats) {
    if (s.value === null || !Number.isFinite(s.value) || s.value === 0) continue;
    const w = weightOf(bonuses, hasCurse, !s.positive);
    const base = baseOf(kind, s.slug);
    if (base === null || !w) return { bad: { slug: s.slug, why: 'noRange' } };
    const key = statKey(s.slug) ?? s.slug;
    const measured = key === 'faction' ? Math.abs(Math.abs(s.value) > 5 ? Math.abs(s.value) / 100 : s.value - 1) : Math.abs(s.value);
    const raw = (measured / (base * k * w) - 1) * 100;
    const dev = s.positive ? raw : -raw;
    if (Math.abs(dev) > FIT) return { bad: { slug: s.slug, why: 'outOfRange' } };
    devs.push({ key: `${key}:${s.positive ? 'bonus' : 'curse'}`, dev });
  }
  return { devs };
}

export function auditListings(weapons: { weapon: Pick<RivenWeapon, 'type' | 'disposition'>; listings: RivenListing[] }[]): Record<string, KindAudit> {
  const out: Record<string, KindAudit> = {};
  const sums = new Map<string, { n: number; total: number; min: number; max: number }>();
  for (const { weapon, listings } of weapons) {
    const kind = categoryOf(weapon.type);
    const label = weapon.type ? `${weapon.type}${kind ? '' : ' (no range)'}` : '(no type)';
    const audit = (out[label] ??= emptyKind());
    const multipliers = [...new Set([...(weapon.disposition ? [weapon.disposition] : []), DEFAULT_MULTIPLIER])];
    for (const listing of listings) {
      if (listing.stats.length < 2) continue;
      audit.listings++;
      if (!kind) continue;
      let problem: { slug: string; why: 'noRange' | 'outOfRange' } | null = null;
      let fitted: { key: string; dev: number }[] | null = null;
      for (const k of multipliers) {
        const r = evaluate(listing, kind, k);
        if ('devs' in r) {
          fitted = r.devs;
          break;
        }
        problem ??= r.bad;
      }
      if (fitted) {
        audit.fit++;
        for (const { key, dev } of fitted) {
          const id = `${label}|${key}`;
          const s = sums.get(id) ?? { n: 0, total: 0, min: Infinity, max: -Infinity };
          s.n++;
          s.total += dev;
          s.min = Math.min(s.min, dev);
          s.max = Math.max(s.max, dev);
          sums.set(id, s);
        }
      } else if (problem) {
        const bucket = problem.why === 'noRange' ? audit.noRange : audit.outOfRange;
        const key = statKey(problem.slug) ?? problem.slug;
        bucket[key] = (bucket[key] ?? 0) + 1;
      }
    }
  }
  for (const [id, s] of sums) {
    const [label, key] = id.split('|') as [string, string];
    out[label]!.spread[key] = { n: s.n, mean: Number((s.total / s.n).toFixed(2)), min: Number(s.min.toFixed(2)), max: Number(s.max.toFixed(2)) };
  }
  return out;
}
