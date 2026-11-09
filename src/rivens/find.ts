import { UserError } from '../services/clan.js';
import { fetchComparable } from './market.js';
import { NUMBER_TAIL, attributeNames, describeFailure, loadAttributes, resolveWeapon } from './service.js';
import { parseStatList, resolveStat } from './stats.js';
import type { RivenAttribute, RivenListing, RivenWeapon } from './types.js';

/**
 * Rivens for sale that match what someone wants: /riven find (the cheapest ones, now), the riven watch (a DM when a new one is listed)
 * and the MCP `find_rivens`. One filtered search on warframe.market, cheapest first, fixed buyout prices only (see fetchComparable).
 */

export interface RivenFilter {
  weapon: RivenWeapon;
  /** 1 to 3 bonus stats the riven must have; it may have another one too. */
  positives: string[];
  /** The curse it must have; null means any curse, or none at all with `noCurse`. */
  negative: string | null;
  noCurse: boolean;
  /** The most it may cost, in platinum. */
  maxPrice: number | null;
}

/** Whether a listing is what the filter asks for: every wanted bonus (more are fine), the curse rule and the price limit. */
export function matchesFilter(l: RivenListing, f: Pick<RivenFilter, 'positives' | 'negative' | 'noCurse' | 'maxPrice'>): boolean {
  const bonuses = new Set(l.stats.filter((s) => s.positive).map((s) => s.slug));
  if (!f.positives.every((p) => bonuses.has(p))) return false;
  const curse = l.stats.find((s) => !s.positive)?.slug ?? null;
  if (f.noCurse && curse) return false;
  if (f.negative && curse !== f.negative) return false;
  return f.maxPrice === null || l.price <= f.maxPrice;
}

/** Attribute slug → how the market writes its value, for the stats whose list says. */
export const unitsOf = (attrs: RivenAttribute[]): Record<string, string> => Object.fromEntries(attrs.flatMap((a) => (a.unit ? [[a.slug, a.unit]] : [])));

/** "none", "no curse", "-": a riven without a curse. */
const NO_CURSE = /^(none|no|no curse|no negative|without|-|—)$/i;

/** Turns what someone typed into a filter, or a UserError that says what is wrong with it. */
export async function resolveFilter(opts: { weapon: string; bonuses: string; curse?: string | null | undefined; maxPrice?: number | null | undefined }): Promise<{
  filter: RivenFilter;
  names: Record<string, string>;
  /** How the market writes each stat (see formatStatValue). */
  units: Record<string, string>;
}> {
  const [weapon, attrs] = await Promise.all([resolveWeapon(opts.weapon), loadAttributes()]);
  const positives = [...new Set(parseStatList(opts.bonuses, attrs).map((s) => s.slug))];
  if (positives.length < 1 || positives.length > 3) throw new UserError('Name 1 to 3 bonus stats, like "cc cd" or "Critical Chance, Multishot".');
  for (const slug of positives) {
    const a = attrs.find((x) => x.slug === slug);
    if (a?.negativeOnly) throw new UserError(`${a.name} can only be a curse, not a bonus.`);
  }
  let negative: string | null = null;
  const curseText = opts.curse?.trim() ?? '';
  const noCurse = NO_CURSE.test(curseText);
  if (curseText && !noCurse) {
    const a = resolveStat(attrs, curseText.replace(NUMBER_TAIL, ''));
    if (!a) throw new UserError(`I don't know the riven stat "${curseText}".`);
    if (a.positiveOnly) throw new UserError(`${a.name} can only be a bonus, never a curse.`);
    if (positives.includes(a.slug)) throw new UserError('The curse can not be one of the bonus stats.');
    negative = a.slug;
  }
  const maxPrice = opts.maxPrice ?? null;
  if (maxPrice !== null && (!Number.isFinite(maxPrice) || maxPrice < 1)) throw new UserError('The price limit must be at least 1 platinum.');
  return { filter: { weapon, positives, negative, noCurse, maxPrice: maxPrice === null ? null : Math.floor(maxPrice) }, names: attributeNames(attrs), units: unitsOf(attrs) };
}

export interface FoundRivens {
  /** What matches, cheapest first. */
  listings: RivenListing[];
  /** Every riven for sale that matches was seen: the market's answer was not cut at its page size, or it already went past the price limit. */
  complete: boolean;
}

/** The rivens for sale that match, cheapest first. Throws a UserError when warframe.market can't be searched right now. */
export async function findRivens(filter: RivenFilter, opts: { ttlMs: number; background?: boolean }): Promise<FoundRivens> {
  let r: Awaited<ReturnType<typeof fetchComparable>>;
  try {
    r = await fetchComparable(filter.weapon.slug, filter.positives, filter.negative, opts);
  } catch (err) {
    if (opts.background) throw err;
    throw new UserError(`I couldn't search warframe.market for ${filter.weapon.name} rivens: ${describeFailure(err)}`);
  }
  const listings = r.listings.filter((l) => matchesFilter(l, filter)).sort((a, b) => a.price - b.price);
  const pastLimit = filter.maxPrice !== null && r.listings.some((l) => l.price > filter.maxPrice!);
  return { listings, complete: r.complete || pastLimit };
}

/** The filter in words: "Critical Chance + Multishot, any curse, at most 500p". */
export function describeFilter(f: Pick<RivenFilter, 'positives' | 'negative' | 'noCurse' | 'maxPrice'>, names: Record<string, string>): string {
  const name = (slug: string) => names[slug] ?? slug.replace(/_/g, ' ');
  const curse = f.noCurse ? 'no curse' : f.negative ? `curse ${name(f.negative)}` : 'any curse';
  return `${f.positives.map(name).join(' + ')}, ${curse}${f.maxPrice !== null ? `, at most ${f.maxPrice.toLocaleString('en-US')}p` : ''}`;
}
