import { type CacheKind, apiJson } from './fetch.js';

// warframe.market v2 API. v1 has been retired and answers 403 "Deprecated".
const BASE = 'https://api.warframe.market/v2';
const ITEM_INDEX_TTL_MS = 12 * 60 * 60 * 1000;

export interface MarketItem {
  slug: string;
  name: string;
  maxRank?: number;
}

export interface MarketOrder {
  platinum: number;
  quantity: number;
  rank?: number;
  user: { ingameName: string; status: 'ingame' | 'online' | 'offline' | string; reputation: number };
}

export interface PriceCheck {
  item: MarketItem;
  url: string;
  sell: MarketOrder[];
  buy: MarketOrder[];
  /** Set when the prices come from the cache because warframe.market could not be used: they may be outdated (age in ms). */
  staleMs?: number;
}

interface ItemsResponse {
  data: { slug: string; i18n: { en?: { name: string } }; maxRank?: number }[];
}

interface TopOrdersResponse {
  data: { sell: MarketOrder[]; buy: MarketOrder[] };
}

async function getJson<T>(path: string, kind: CacheKind, platform = 'pc', opts: { background?: boolean; scope?: string } = {}): Promise<{ data: T; stale: boolean; ageMs: number }> {
  const r = await apiJson<T>(`${BASE}${path}`, { kind, headers: { Accept: 'application/json', Language: 'en', Platform: platform, Crossplay: 'true' }, ...opts });
  if (r.data === null) throw new Error('Item not found on warframe.market.');
  return { data: r.data, stale: r.stale, ageMs: r.ageMs };
}

let index: { at: number; items: MarketItem[] } | null = null;
let indexInflight: Promise<MarketItem[]> | null = null;

export async function getItemIndex(): Promise<MarketItem[]> {
  if (index && Date.now() - index.at < ITEM_INDEX_TTL_MS) return index.items;
  indexInflight ??= getJson<ItemsResponse>('/items', 'stable')
    .then(({ data: r }) => {
      const items = r.data
        .filter((i) => i.i18n.en?.name)
        .map((i) => ({ slug: i.slug, name: i.i18n.en!.name, maxRank: i.maxRank }))
        .sort((a, b) => a.name.localeCompare(b.name));
      index = { at: Date.now(), items };
      return items;
    })
    .finally(() => {
      indexInflight = null;
    });
  return indexInflight;
}

/** Ranks items for autocomplete: exact name, then prefix, then word-prefix, then substring matches. */
export function searchItems(items: MarketItem[], query: string, limit = 25): MarketItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: { item: MarketItem; score: number }[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    let score = -1;
    if (name === q || item.slug === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
    else if (name.includes(q)) score = 3;
    if (score >= 0) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.item.name.length - b.item.name.length)
    .slice(0, limit)
    .map((s) => s.item);
}

export async function resolveItem(query: string): Promise<MarketItem | null> {
  return searchItems(await getItemIndex(), query, 1)[0] ?? null;
}

const active = (o: MarketOrder) => o.user.status === 'ingame' || o.user.status === 'online';

/**
 * The orders warframe.market shows first for an item: its cheapest sellers and best buyers who are online, of one rank when `rank` is
 * given (a mod's unranked price). Prices move, so they have their own short lifetime; everyone asking in that time shares one request.
 */
export async function topOrders(slug: string, opts: { platform?: string; rank?: number; background?: boolean; scope?: string } = {}): Promise<{ sell: MarketOrder[]; buy: MarketOrder[]; stale: boolean; ageMs: number }> {
  const query = opts.rank === undefined ? '' : `?rank=${opts.rank}`;
  const send = { ...(opts.background ? { background: true } : {}), ...(opts.scope ? { scope: opts.scope } : {}) };
  const { data: orders, stale, ageMs } = await getJson<TopOrdersResponse>(`/orders/item/${encodeURIComponent(slug)}/top${query}`, 'price', opts.platform ?? 'pc', send);
  return {
    sell: orders.data.sell.filter(active).sort((a, b) => a.platinum - b.platinum),
    buy: orders.data.buy.filter(active).sort((a, b) => b.platinum - a.platinum),
    stale,
    ageMs,
  };
}

/**
 * What an item sells for: the median of its five cheapest online sellers, so one seller far below (or above) the rest doesn't set the
 * price. Null without sellers.
 */
export function marketPrice(sell: readonly MarketOrder[]): number | null {
  const prices = sell.map((o) => o.platinum).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b).slice(0, 5);
  if (!prices.length) return null;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 ? prices[mid]! : Math.round((prices[mid - 1]! + prices[mid]!) / 2);
}

/** Cheapest sellers and highest buyers who are currently online or in game. */
export async function priceCheck(query: string, platform = 'pc', limit = 5): Promise<PriceCheck> {
  const item = await resolveItem(query);
  if (!item) throw new Error(`No tradable item matches "${query}".`);
  const { sell, buy, stale, ageMs } = await topOrders(item.slug, { platform });
  return {
    item,
    url: `https://warframe.market/items/${item.slug}`,
    sell: sell.slice(0, limit),
    buy: buy.slice(0, limit),
    ...(stale ? { staleMs: ageMs } : {}),
  };
}
