import type { RivenListing } from './types.js';

/**
 * Grades a riven by how common its rolls are among the expensive ones on warframe.market. Pure: it is handed a weapon's listings.
 * "High value" is a price bracket (RIVEN_HIGH_PRICE, 1000 platinum by default); a weapon with too few listings that high falls
 * back to its own top quarter, and one with too few listings at all gets no grade rather than an invented one.
 */

/** Fewer listings than this for a weapon and there is nothing meaningful to compare with. */
export const MIN_LISTINGS = 16;
/** The high bracket always holds at least this many listings. */
export const MIN_HIGH = 8;
/** Value percentiles need this many other rolls of the same stat. */
const MIN_VALUES = 5;

export interface Bracket {
  high: RivenListing[];
  /** The lowest asking price inside the bracket. */
  threshold: number;
  /** The bracket is this weapon's top quarter because too few listings reached the price line. */
  adaptive: boolean;
  total: number;
}

export function highBracket(all: RivenListing[], minPrice: number): Bracket | null {
  if (all.length < MIN_LISTINGS) return null;
  const sorted = [...all].sort((a, b) => b.price - a.price);
  const above = sorted.filter((l) => l.price >= minPrice);
  if (above.length >= MIN_HIGH) return { high: above, threshold: above[above.length - 1]!.price, adaptive: false, total: all.length };
  const high = sorted.slice(0, Math.max(MIN_HIGH, Math.ceil(all.length * 0.25)));
  return { high, threshold: high[high.length - 1]!.price, adaptive: true, total: all.length };
}

const positives = (l: RivenListing): string[] => l.stats.filter((s) => s.positive).map((s) => s.slug);
const negativeOf = (l: RivenListing): string | null => l.stats.find((s) => !s.positive)?.slug ?? null;
const setKey = (slugs: string[]): string => [...slugs].sort().join('|');

export function median(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : Math.round((v[mid - 1]! + v[mid]!) / 2);
}

/** Share (0 to 1) of the listings that carry each stat as a bonus (or, with `negative`, as the curse). */
export function shares(listings: RivenListing[], negative = false): Map<string, number> {
  const counts = new Map<string, number>();
  for (const l of listings) {
    const slugs = negative ? [negativeOf(l)].filter((s): s is string => s !== null) : positives(l);
    for (const s of new Set(slugs)) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return new Map([...counts].map(([k, n]) => [k, n / Math.max(1, listings.length)]));
}

const ranked = (m: Map<string, number>): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

export interface StatInput {
  slug: string;
  value?: number | null | undefined;
}

export interface GradeInput {
  positives: StatInput[];
  negative?: StatInput | null | undefined;
}

export interface StatReading {
  slug: string;
  /** Share of the high-value rivens that have this stat. */
  share: number;
  /** Position among this weapon's most common bonus stats (1 = the most common), null when none of the high-value rivens have it. */
  rank: number | null;
  /** How the rolled value compares with the other rolls of this stat on the market (share of them that are lower or equal), when known. */
  percentile: number | null;
}

export type Letter = 'S' | 'A' | 'B' | 'C' | 'D';

export interface Comparable {
  count: number;
  min: number;
  median: number;
  max: number;
  /** The 10th cheapest asking price, when ten or more were found. */
  tenth: number | null;
  sameNegative: boolean;
  /** `count` is everything for sale with these bonuses (the market was asked for exactly them and did not hit its page limit), so the median means something. When false only the cheapest are known: the floor and the tenth cheapest are right, a median would lean low. */
  complete: boolean;
  /** `market`: warframe.market was asked for exactly these bonuses, cheapest first. `top`: only the weapon's stored priciest listings were available, so every price leans high. */
  source: 'market' | 'top';
}

/** What warframe.market returned when asked for listings with exactly the graded bonus stats, cheapest first. */
export interface MarketComparable {
  listings: RivenListing[];
  complete: boolean;
}

export interface Grade {
  letter: Letter;
  bracket: { high: number; total: number; threshold: number; adaptive: boolean };
  stats: StatReading[];
  /** High-value rivens with exactly this set of bonus stats. */
  exact: number;
  /** What listings with the same bonus stats ask, or null when nobody is selling that combination. */
  comparable: Comparable | null;
  /** warframe.market was asked what is for sale with these bonuses (so a null `comparable` really means nobody is selling them). */
  marketChecked: boolean;
  negative: { slug: string; share: number; rank: number | null } | null;
}

export function gradeRiven(all: RivenListing[], input: GradeInput, minPrice: number, market?: MarketComparable | null): Grade | null {
  const bracket = highBracket(all, minPrice);
  if (!bracket || input.positives.length === 0) return null;
  const { high } = bracket;
  const posShares = shares(high);
  const order = ranked(posShares).map(([slug]) => slug);
  const wantKey = setKey(input.positives.map((p) => p.slug));

  const stats: StatReading[] = input.positives.map((p) => {
    const at = order.indexOf(p.slug);
    return { slug: p.slug, share: posShares.get(p.slug) ?? 0, rank: at === -1 ? null : at + 1, percentile: percentileOf(all, p) };
  });

  const points = stats.reduce((n, s) => n + (s.rank === null ? 0 : s.rank <= 3 ? 2 : s.rank <= 6 ? 1 : 0), 0);
  const exact = high.filter((l) => setKey(positives(l)) === wantKey).length;
  const ratio = points / (2 * stats.length);
  const letter: Letter = ratio === 1 && exact >= 1 ? 'S' : ratio >= 5 / 6 ? 'A' : ratio >= 0.5 ? 'B' : ratio > 0 ? 'C' : 'D';

  const wantNeg = input.negative?.slug ?? null;
  const comparable = comparableFrom(market?.listings ?? [], wantKey, wantNeg, market?.complete ?? false, 'market') ?? (market?.complete ? null : comparableFrom(all, wantKey, wantNeg, false, 'top'));

  let negative: Grade['negative'] = null;
  if (wantNeg) {
    const negShares = shares(high, true);
    const at = ranked(negShares).findIndex(([slug]) => slug === wantNeg);
    negative = { slug: wantNeg, share: negShares.get(wantNeg) ?? 0, rank: at === -1 ? null : at + 1 };
  }

  return { letter, bracket: { high: high.length, total: bracket.total, threshold: bracket.threshold, adaptive: bracket.adaptive }, stats, exact, comparable, marketChecked: Boolean(market), negative };
}

function comparableFrom(listings: RivenListing[], wantKey: string, wantNeg: string | null, complete: boolean, source: Comparable['source']): Comparable | null {
  const sameSet = listings.filter((l) => setKey(positives(l)) === wantKey);
  const sameNeg = wantNeg ? sameSet.filter((l) => negativeOf(l) === wantNeg) : [];
  const pool = sameNeg.length >= 3 ? sameNeg : sameSet;
  if (!pool.length) return null;
  const prices = pool.map((l) => l.price).sort((a, b) => a - b);
  return { count: pool.length, min: prices[0]!, median: median(prices), max: prices[prices.length - 1]!, tenth: prices.length >= 10 ? prices[9]! : null, sameNegative: pool === sameNeg, complete, source };
}

/** Share of the other rolls of this stat (as a bonus) that are lower or equal; null when the value is unknown or there are too few. */
function percentileOf(all: RivenListing[], stat: StatInput): number | null {
  if (stat.value === null || stat.value === undefined) return null;
  const values = all.flatMap((l) => l.stats.filter((s) => s.positive && s.slug === stat.slug && s.value !== null).map((s) => s.value!));
  if (values.length < MIN_VALUES) return null;
  return values.filter((v) => v <= stat.value!).length / values.length;
}

export interface TopCombo {
  slugs: string[];
  count: number;
  median: number;
}

export interface TopRolls {
  bracket: { high: number; total: number; threshold: number; adaptive: boolean };
  stats: { slug: string; share: number }[];
  negatives: { slug: string; share: number }[];
  combos: TopCombo[];
}

/** What the weapon's expensive rivens look like: the most common bonus stats, curses and exact combinations. */
export function topRolls(all: RivenListing[], minPrice: number, limit = 5): TopRolls | null {
  const bracket = highBracket(all, minPrice);
  if (!bracket) return null;
  const { high } = bracket;
  const groups = new Map<string, RivenListing[]>();
  for (const l of high) {
    const k = setKey(positives(l));
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const combos = [...groups]
    .map(([k, ls]) => ({ slugs: k.split('|'), count: ls.length, median: median(ls.map((l) => l.price)) }))
    .sort((a, b) => b.count - a.count || b.median - a.median)
    .slice(0, limit);
  return {
    bracket: { high: high.length, total: bracket.total, threshold: bracket.threshold, adaptive: bracket.adaptive },
    stats: ranked(shares(high)).slice(0, 8).map(([slug, share]) => ({ slug, share })),
    negatives: ranked(shares(high, true)).slice(0, 4).map(([slug, share]) => ({ slug, share })),
    combos,
  };
}
