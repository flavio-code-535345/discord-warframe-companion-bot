import { apiFetch } from './fetch.js';

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
}

interface ItemsResponse {
  data: { slug: string; i18n: { en?: { name: string } }; maxRank?: number }[];
}

interface TopOrdersResponse {
  data: { sell: MarketOrder[]; buy: MarketOrder[] };
}

async function getJson<T>(path: string, platform = 'pc'): Promise<T> {
  const res = await apiFetch(`${BASE}${path}`, { Accept: 'application/json', Language: 'en', Platform: platform, Crossplay: 'true' });
  if (res.status === 404) throw new Error('Item not found on warframe.market.');
  if (!res.ok) throw new Error(`warframe.market request failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

let index: { at: number; items: MarketItem[] } | null = null;
let indexInflight: Promise<MarketItem[]> | null = null;

export async function getItemIndex(): Promise<MarketItem[]> {
  if (index && Date.now() - index.at < ITEM_INDEX_TTL_MS) return index.items;
  indexInflight ??= getJson<ItemsResponse>('/items')
    .then((r) => {
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

/** Cheapest sellers and highest buyers who are currently online or in game. */
export async function priceCheck(query: string, platform = 'pc', limit = 5): Promise<PriceCheck> {
  const item = await resolveItem(query);
  if (!item) throw new Error(`No tradable item matches "${query}".`);
  const { data } = await getJson<TopOrdersResponse>(`/orders/item/${encodeURIComponent(item.slug)}/top`, platform);
  const active = (o: MarketOrder) => o.user.status === 'ingame' || o.user.status === 'online';
  return {
    item,
    url: `https://warframe.market/items/${item.slug}`,
    sell: data.sell.filter(active).sort((a, b) => a.platinum - b.platinum).slice(0, limit),
    buy: data.buy.filter(active).sort((a, b) => b.platinum - a.platinum).slice(0, limit),
  };
}
