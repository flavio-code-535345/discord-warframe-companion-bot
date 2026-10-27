import { apiJson } from '../warframe/fetch.js';
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
  const r = await apiJson<{ data?: { slug?: string; i18n?: { en?: { name?: string } } }[] }>(`${V2}/riven/weapons`, { kind: 'stable', headers: HEADERS, scope: RIVEN_SCOPE });
  const list = (r.data?.data ?? [])
    .filter((w): w is { slug: string; i18n?: { en?: { name?: string } } } => typeof w.slug === 'string')
    .map((w) => ({ slug: w.slug, name: w.i18n?.en?.name ?? w.slug }))
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
