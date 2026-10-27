import { ApiHttpError, apiJson } from '../warframe/fetch.js';
import type { RivenAttribute, RivenListing, RivenStat, RivenWeapon } from './types.js';

/**
 * Riven data from warframe.market. The weapon and attribute lists come from the v2 API; the listings come from the auctions
 * search, which still lives under v1. Every call goes through the shared ApiClient in its own `rivens` scope: a 403 or 429 there
 * pauses riven reads only, never /price, and the crawl runs as background work with half of the global request budget.
 */

const V2 = 'https://api.warframe.market/v2';
export const AUCTIONS_URL = 'https://api.warframe.market/v1/auctions/search';
export const RIVEN_SCOPE = 'rivens';

const HEADERS = { Accept: 'application/json', Language: 'en', Platform: 'pc', Crossplay: 'true' };

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

let weapons: { at: number; list: RivenWeapon[] } | null = null;
let attributes: { at: number; list: RivenAttribute[] } | null = null;
const TTL_MS = 12 * 3_600_000;

export async function getRivenWeapons(): Promise<RivenWeapon[]> {
  if (weapons && Date.now() - weapons.at < TTL_MS) return weapons.list;
  const r = await apiJson<{ data?: Json[] }>(`${V2}/riven/weapons`, { kind: 'stable', headers: HEADERS, scope: RIVEN_SCOPE });
  const list = (r.data?.data ?? [])
    .filter((w): w is Json & { slug: string } => typeof w.slug === 'string')
    .map((w): RivenWeapon => {
      const type = [w.rivenType, w.riven_type, w.type, w.group].find((t): t is string => typeof t === 'string' && t !== '');
      const disposition = num(w.disposition);
      return { slug: w.slug, name: (obj(obj(w.i18n)?.en)?.name as string | undefined) ?? w.slug, ...(type ? { type } : {}), ...(disposition !== null && disposition > 0 ? { disposition } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (list.length) weapons = { at: Date.now(), list };
  return list;
}

export async function getRivenAttributes(): Promise<RivenAttribute[]> {
  if (attributes && Date.now() - attributes.at < TTL_MS) return attributes.list;
  const r = await apiJson<{ data?: Json[] }>(`${V2}/riven/attributes`, { kind: 'stable', headers: HEADERS, scope: RIVEN_SCOPE });
  const list: RivenAttribute[] = [];
  for (const a of r.data?.data ?? []) {
    const slug = typeof a.slug === 'string' ? a.slug : null;
    if (!slug) continue;
    const name = (obj(obj(a.i18n)?.en)?.name as string | undefined) ?? slug;
    list.push({ slug, name, positiveOnly: a.positiveOnly === true, negativeOnly: a.negativeOnly === true });
  }
  if (list.length) attributes = { at: Date.now(), list };
  return list;
}

/** Test hook. */
export const resetRivenLists = (): void => {
  weapons = null;
  attributes = null;
};

/**
 * Reads the auctions payload tolerantly: the v1 shape is `payload.auctions[]`, and both spellings of the bonus flag (the old
 * spec misspells it `postive`) and snake or camel case are accepted. Closed, private and non-riven auctions are skipped.
 */
export function parseAuctions(body: unknown, weapon: string): RivenListing[] {
  const root = obj(body);
  const payload = obj(root?.payload);
  const rows = Array.isArray(payload?.auctions) ? payload.auctions : Array.isArray(root?.data) ? root.data : [];
  const out: RivenListing[] = [];
  for (const raw of rows) {
    const a = obj(raw);
    const item = obj(a?.item);
    if (!a || !item) continue;
    if (item.type !== undefined && item.type !== 'riven') continue;
    if (a.closed === true || a.private === true) continue;
    const id = typeof a.id === 'string' ? a.id : null;
    const price = num(a.buyout_price ?? a.buyoutPrice) ?? num(a.starting_price ?? a.startingPrice);
    if (!id || price === null || price <= 0) continue;
    const stats: RivenStat[] = [];
    for (const s of Array.isArray(item.attributes) ? item.attributes : []) {
      const st = obj(s);
      const slug = typeof st?.url_name === 'string' ? st.url_name : typeof st?.slug === 'string' ? st.slug : null;
      if (!st || !slug) continue;
      stats.push({ slug, value: num(st.value), positive: (st.positive ?? st.postive) !== false });
    }
    if (stats.length < 2) continue;
    out.push({
      id,
      weapon,
      price,
      polarity: typeof item.polarity === 'string' ? item.polarity : '',
      rerolls: num(item.re_rolls ?? item.reRolls) ?? 0,
      stats,
    });
  }
  return out;
}

/**
 * One request: the weapon's listings, most expensive first (that is where the high-value rolls are). `background` marks the slow
 * crawl, which gets half the request budget; a person asking for a grade is not background. Returns the listings, newest read.
 */
export async function fetchListings(weapon: string, opts: { background: boolean; ttlMs: number }): Promise<RivenListing[]> {
  const url = `${AUCTIONS_URL}?type=riven&weapon_url_name=${encodeURIComponent(weapon)}&sort_by=price_desc`;
  const r = await apiJson<unknown>(url, { kind: 'live', ttlMs: opts.ttlMs, headers: HEADERS, background: opts.background, scope: RIVEN_SCOPE });
  if (r.data === null) return [];
  return parseAuctions(r.data, weapon);
}

/** How many listings one search returns at most (the weapon's full list is cut to this). */
export const PAGE_SIZE = 100;

/** The filtered search was refused as a bad request: it is not tried again for a while, and callers fall back to the stored listings. */
let filterUnsupportedUntil = 0;
const FILTER_RETRY_MS = 6 * 3_600_000;

/** Test hook. */
export const resetRivenFilter = (): void => {
  filterUnsupportedUntil = 0;
};

/**
 * What is for sale with exactly these bonus stats (and this curse, when given), cheapest first, asked of warframe.market itself with
 * its own filters. The stored listings are only a weapon's priciest, so prices read from them lean high; this one request, made when
 * someone grades a roll (cached for `ttlMs`, never stored), gives the real floor. Only listings that really carry all the stats are
 * kept, so a filter the market ignores can't make a wrong price look right. `complete` is true when fewer than a page came back, i.e.
 * that is everything for sale. Throws when the search can't be used; the caller falls back.
 */
export async function fetchComparable(weapon: string, positives: string[], negative: string | null, opts: { ttlMs: number }): Promise<{ listings: RivenListing[]; complete: boolean }> {
  if (Date.now() < filterUnsupportedUntil) throw new Error('the filtered riven search was refused earlier');
  const params = new URLSearchParams({ type: 'riven', weapon_url_name: weapon, sort_by: 'price_asc', buyout_policy: 'direct' });
  params.set('positive_stats', positives.join(','));
  if (negative) params.set('negative_stats', negative);
  try {
    const r = await apiJson<unknown>(`${AUCTIONS_URL}?${params.toString().replace(/%2C/g, ',')}`, { kind: 'live', ttlMs: opts.ttlMs, headers: HEADERS, scope: RIVEN_SCOPE });
    if (r.data === null) return { listings: [], complete: true };
    return { listings: parseAuctions(r.data, weapon), complete: auctionCount(r.data) < PAGE_SIZE };
  } catch (err) {
    if (err instanceof ApiHttpError && (err.status === 400 || err.status === 422)) filterUnsupportedUntil = Date.now() + FILTER_RETRY_MS;
    throw err;
  }
}

/** How many auctions the answer held before any were skipped. */
export function auctionCount(body: unknown): number {
  const root = obj(body);
  const payload = obj(root?.payload);
  const rows = Array.isArray(payload?.auctions) ? payload.auctions : Array.isArray(root?.data) ? root.data : [];
  return rows.length;
}
