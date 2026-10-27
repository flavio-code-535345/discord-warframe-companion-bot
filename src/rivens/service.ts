import type { AppContext } from '../context.js';
import { UserError } from '../services/clan.js';
import { ApiBlockedError, api } from '../warframe/fetch.js';
import { searchItems } from '../warframe/market.js';
import { type Grade, type MarketComparable, type StatInput, type TopRolls, gradeRiven, topRolls } from './grade.js';
import { RIVEN_SCOPE, fetchComparable, fetchListings, getRivenAttributes, getRivenWeapons } from './market.js';
import { type RollGrade, gradeRolls } from './rolls.js';
import { parseStatList, resolveStat } from './stats.js';
import type { RivenAttribute, RivenListing, RivenWeapon } from './types.js';

/** Listings a person's grade is built from are re-read when older than this (the slow crawl keeps weapons much fresher than it needs to). */
const USER_MAX_AGE_MS = 6 * 3_600_000;
/** A read someone asked for may be served from the API client's cache for this long. */
const USER_TTL_MS = 30 * 60_000;
/** A rolled value written after a stat name ("zoom -40"), which the negative option ignores. */
const NUMBER_TAIL = /-?\d+(?:[.,]\d+)?\s*%?/g;

export const attributeNames = (attrs: RivenAttribute[]): Record<string, string> => Object.fromEntries(attrs.map((a) => [a.slug, a.name]));

/** One of warframe.market's lists (weapons, stats), with a failure explained in words. */
async function listOf<T>(what: string, read: () => Promise<T[]>): Promise<T[]> {
  let list: T[];
  try {
    list = await read();
  } catch (err) {
    throw new UserError(`I couldn't load the riven ${what} list from warframe.market: ${describeFailure(err)}`);
  }
  if (!list.length) throw new UserError(`I couldn't load the riven ${what} list from warframe.market just now. Try again in a minute.`);
  return list;
}

export async function resolveWeapon(query: string): Promise<RivenWeapon> {
  const list = await listOf('weapon', getRivenWeapons);
  const hit = searchItems(list, query, 1)[0];
  if (!hit) throw new UserError(`No weapon with a riven matches "${query}".`);
  return hit;
}

/** Explains a failed read in words a player understands. */
function describeFailure(err: unknown): string {
  if (err instanceof ApiBlockedError) return `warframe.market asked the bot to back off, so riven reads are paused for about ${Math.max(1, Math.ceil((err.until - Date.now()) / 60_000))} min (${err.reason}).`;
  return err instanceof Error ? err.message : String(err);
}

export interface Loaded {
  listings: RivenListing[];
  fetchedAt: number | null;
  /** The listings are older than they should be because warframe.market could not be read. */
  stale: boolean;
}

const inflight = new Map<string, Promise<Loaded>>();

/**
 * A weapon's listings: what the slow crawl already stored when it is recent, else one fresh read (shared by everyone asking at the
 * same time). A failed read falls back to older stored listings, and only throws when there is nothing at all.
 */
export function loadListings(ctx: AppContext, weapon: RivenWeapon, now = Date.now()): Promise<Loaded> {
  const running = inflight.get(weapon.slug);
  if (running) return running;
  const p = (async (): Promise<Loaded> => {
    const row = ctx.store.rivenCrawlRow(weapon.slug);
    if (row?.fetchedAt && now - row.fetchedAt < USER_MAX_AGE_MS) return { listings: ctx.store.rivenListings(weapon.slug), fetchedAt: row.fetchedAt, stale: false };
    try {
      const listings = await fetchListings(weapon.slug, { background: false, ttlMs: USER_TTL_MS });
      ctx.store.replaceRivenListings(weapon.slug, listings, now);
      return { listings, fetchedAt: now, stale: false };
    } catch (err) {
      ctx.store.markRivenFailure(weapon.slug, describeFailure(err), now);
      if (row?.fetchedAt) return { listings: ctx.store.rivenListings(weapon.slug), fetchedAt: row.fetchedAt, stale: true };
      throw new UserError(`I couldn't read riven listings for ${weapon.name} from warframe.market: ${describeFailure(err)}`);
    }
  })().finally(() => inflight.delete(weapon.slug));
  inflight.set(weapon.slug, p);
  return p;
}

/**
 * What is for sale with exactly these bonuses, from one filtered search (see fetchComparable). The stored listings are only the
 * weapon's priciest, so they would make every price lean high. A failure just means the grade falls back to them, and says so.
 */
async function comparableFor(weapon: string, positives: string[], negative: string | null): Promise<MarketComparable | null> {
  try {
    return await fetchComparable(weapon, positives, negative, { ttlMs: USER_TTL_MS });
  } catch (err) {
    console.warn(`[riven] could not look up what is for sale for ${weapon}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

export interface GradeReport {
  weapon: RivenWeapon;
  names: Record<string, string>;
  /** null when warframe.market lists too few rivens for this weapon to compare with. */
  grade: Grade | null;
  /** How good each rolled value is, stat by stat (see rolls.ts). */
  rolls: RollGrade[];
  listings: number;
  fetchedAt: number | null;
  stale: boolean;
  minPrice: number;
}

export async function gradeFor(ctx: AppContext, opts: { weapon: string; positives: string; negative?: string | undefined }): Promise<GradeReport> {
  const [weapon, attrs] = await Promise.all([resolveWeapon(opts.weapon), listOf('stat', getRivenAttributes)]);
  const positives = parseStatList(opts.positives, attrs);
  let negative: StatInput | null = null;
  if (opts.negative?.trim()) {
    const a = resolveStat(attrs, opts.negative.replace(NUMBER_TAIL, ''));
    if (!a) throw new UserError(`I don't know the riven stat "${opts.negative}".`);
    negative = { slug: a.slug };
  }
  return gradeResolved(ctx, weapon, attrs, positives, negative);
}

/** Grades a riven whose weapon and stats are already known (typed in, or read from a screenshot). */
export async function gradeResolved(ctx: AppContext, weapon: RivenWeapon, attrs: RivenAttribute[], positives: StatInput[], negative: StatInput | null): Promise<GradeReport> {
  if (positives.length < 2 || positives.length > 3) throw new UserError('A riven has 2 or 3 bonus stats: list them like "cc cd ms" or "Critical Chance 180, Multishot 120".');
  if (new Set(positives.map((p) => p.slug)).size !== positives.length) throw new UserError('Each bonus stat can only appear once.');
  const nameOf = (slug: string) => attrs.find((x) => x.slug === slug)?.name ?? slug;
  if (negative) {
    if (attrs.find((x) => x.slug === negative.slug)?.positiveOnly) throw new UserError(`${nameOf(negative.slug)} can only be a bonus, never a curse.`);
    if (positives.some((p) => p.slug === negative.slug)) throw new UserError('The curse can not be one of the bonus stats.');
  }
  for (const p of positives) {
    const a = attrs.find((x) => x.slug === p.slug);
    if (a?.negativeOnly) throw new UserError(`${a.name} can only be a curse, not a bonus.`);
  }
  const loaded = await loadListings(ctx, weapon);
  const market = await comparableFor(weapon.slug, positives.map((p) => p.slug), negative?.slug ?? null);
  return { weapon, names: attributeNames(attrs), rolls: gradeRolls(loaded.listings, positives, negative), grade: gradeRiven(loaded.listings, { positives, negative }, ctx.config.RIVEN_HIGH_PRICE, market), listings: loaded.listings.length, fetchedAt: loaded.fetchedAt, stale: loaded.stale, minPrice: ctx.config.RIVEN_HIGH_PRICE };
}

export interface TopReport {
  weapon: RivenWeapon;
  names: Record<string, string>;
  top: TopRolls | null;
  listings: number;
  fetchedAt: number | null;
  stale: boolean;
  minPrice: number;
}

export async function topFor(ctx: AppContext, weaponQuery: string): Promise<TopReport> {
  const [weapon, attrs] = await Promise.all([resolveWeapon(weaponQuery), listOf('stat', getRivenAttributes)]);
  const loaded = await loadListings(ctx, weapon);
  return { weapon, names: attributeNames(attrs), top: topRolls(loaded.listings, ctx.config.RIVEN_HIGH_PRICE), listings: loaded.listings.length, fetchedAt: loaded.fetchedAt, stale: loaded.stale, minPrice: ctx.config.RIVEN_HIGH_PRICE };
}

export interface RivenStatus {
  enabled: boolean;
  intervalSeconds: number;
  refreshDays: number;
  highPrice: number;
  weaponsKnown: number | null;
  weaponsRead: number;
  listings: number;
  failing: { weapon: string; error: string }[];
  lastReadAt: number | null;
  pausedMs: number;
}

export async function rivenStatus(ctx: AppContext): Promise<RivenStatus> {
  const rows = ctx.store.rivenCrawlRows();
  const totals = ctx.store.rivenTotals();
  const known = await getRivenWeapons().then((w) => w.length, () => null);
  return {
    enabled: ctx.config.RIVEN_CRAWL_ENABLED,
    intervalSeconds: ctx.config.RIVEN_CRAWL_INTERVAL_SECONDS,
    refreshDays: ctx.config.RIVEN_REFRESH_DAYS,
    highPrice: ctx.config.RIVEN_HIGH_PRICE,
    weaponsKnown: known,
    weaponsRead: rows.filter((r) => r.fetchedAt !== null).length,
    listings: totals.listings,
    failing: rows.filter((r) => r.error).slice(0, 5).map((r) => ({ weapon: r.weapon, error: r.error! })),
    lastReadAt: rows.reduce<number | null>((m, r) => (r.fetchedAt !== null && (m === null || r.fetchedAt > m) ? r.fetchedAt : m), null),
    pausedMs: api.blockedFor(`api.warframe.market#${RIVEN_SCOPE}`),
  };
}
