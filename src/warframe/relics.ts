import { apiJson } from './fetch.js';
import { relicBaseName } from './items.js';

/**
 * What relics are worth, without a single warframe.market request: WFInfo's price list (served by warframestat.us, one average per
 * prime part and set, computed from warframe.market's trade statistics and updated daily) and WFInfo's relic table (each relic's six
 * rewards, whether it is vaulted, and the ducats of every prime part). Two requests every 6 hours, kept in the API cache, so a restart
 * asks nothing. A relic's value is the plat its rewards trade for, weighted by the chance of each at a refinement: opened alone, or in a
 * radshare (four players open the same relic and everyone takes the best of the four rewards shown).
 */

const WFINFO = 'https://api.warframestat.us/wfinfo';
const BOOK_TTL_MS = 6 * 3_600_000;
/** How long one built book is reused before the (cached) data is read again. */
const MEMO_MS = 10 * 60_000;

export const REFINEMENTS = ['Intact', 'Exceptional', 'Flawless', 'Radiant'] as const;
export type Refinement = (typeof REFINEMENTS)[number];
export type Rarity = 'Common' | 'Uncommon' | 'Rare';
export type Squad = 'solo' | 'radshare';
export type VaultFilter = 'exclude' | 'include' | 'only';

/** The relic tiers in the price table, in the game's order. */
export const RELIC_TIERS = ['Lith', 'Meso', 'Neo', 'Axi', 'Vanguard'] as const;

/** The chance of one uncommon and of the rare reward at each refinement; the three commons share what is left. */
const UNCOMMON_RARE: Record<Refinement, readonly [number, number]> = {
  Intact: [0.11, 0.02],
  Exceptional: [0.13, 0.04],
  Flawless: [0.17, 0.06],
  Radiant: [0.2, 0.1],
};

/** The chance of one reward of a rarity at a refinement: a relic holds 3 common, 2 uncommon and 1 rare reward. */
export function slotChance(refinement: Refinement, rarity: Rarity): number {
  const [u, r] = UNCOMMON_RARE[refinement];
  return rarity === 'Rare' ? r : rarity === 'Uncommon' ? u : (1 - 2 * u - r) / 3;
}

/** Void Traces it takes to bring an Intact relic to each refinement. */
export const TRACES: Record<Refinement, number> = { Intact: 0, Exceptional: 25, Flawless: 50, Radiant: 100 };

export interface BookReward {
  item: string;
  rarity: Rarity;
  /** The plat it trades for (WFInfo's average); 0 for Forma and the other rewards that are not traded; null when the list has no price. */
  plat: number | null;
  ducats: number;
  /** How many traded on the last full day: a hint of how easy it is to sell. */
  volume: number;
}

export interface BookRelic {
  tier: string;
  code: string;
  /** "Axi A1". */
  name: string;
  vaulted: boolean;
  rewards: BookReward[];
  /** False when the table lacks one of its rewards (a brand-new relic): its value leaves that reward out. */
  complete: boolean;
}

export interface RelicBook {
  /** By lower-case name ("axi a1"). */
  relics: Map<string, BookRelic>;
  /** Plat and daily volume by lower-case item name: the parts and the sets. */
  prices: Map<string, { plat: number; volume: number }>;
  /** When the older of the two lists was read. */
  fetchedAt: number;
  /** True when one of them came from the cache because warframestat.us could not be read. */
  stale: boolean;
}

export interface WfinfoPrice {
  name: string;
  yesterday_vol?: string | number;
  today_vol?: string | number;
  custom_avg?: string | number;
}

export interface WfinfoTable {
  relics?: Record<string, Record<string, Record<string, unknown>>>;
  eqmt?: Record<string, { parts?: Record<string, { ducats?: number }> }>;
  ignored_items?: Record<string, unknown>;
}

const SLOTS: readonly (readonly [string, Rarity])[] = [
  ['common1', 'Common'],
  ['common2', 'Common'],
  ['common3', 'Common'],
  ['uncommon1', 'Uncommon'],
  ['uncommon2', 'Uncommon'],
  ['rare1', 'Rare'],
];

const lower = (s: string) => s.trim().toLowerCase();

/** An item's price: the list names Warframe parts "… Systems Blueprint" where the relic table says "… Systems". */
export function priceOf(prices: RelicBook['prices'], item: string): { plat: number; volume: number } | null {
  const name = lower(item);
  return prices.get(name) ?? prices.get(`${name} blueprint`) ?? (name.endsWith(' blueprint') ? (prices.get(name.slice(0, -' blueprint'.length)) ?? null) : null);
}

/** Builds the book from WFInfo's two lists (pure). */
export function buildRelicBook(table: WfinfoTable, list: WfinfoPrice[], fetchedAt = Date.now(), stale = false): RelicBook {
  const prices = new Map<string, { plat: number; volume: number }>();
  for (const p of list) {
    const plat = Number(p.custom_avg);
    if (typeof p.name !== 'string' || !Number.isFinite(plat) || plat <= 0) continue;
    const volume = Number(p.yesterday_vol);
    prices.set(lower(p.name), { plat, volume: Number.isFinite(volume) ? volume : 0 });
  }
  // Forma, the Exilus Adapter, Kuva and the like: rewards nobody pays plat for.
  const untraded = new Set(Object.keys(table.ignored_items ?? {}).map(lower));
  const ducats = new Map<string, number>();
  for (const set of Object.values(table.eqmt ?? {})) {
    for (const [part, info] of Object.entries(set.parts ?? {})) if (typeof info?.ducats === 'number') ducats.set(lower(part), info.ducats);
  }

  const relics = new Map<string, BookRelic>();
  for (const [tier, byCode] of Object.entries(table.relics ?? {})) {
    for (const [code, entry] of Object.entries(byCode ?? {})) {
      const rewards: BookReward[] = [];
      for (const [slot, rarity] of SLOTS) {
        const item = entry[slot];
        if (typeof item !== 'string' || !item.trim()) continue;
        const price = untraded.has(lower(item)) ? { plat: 0, volume: 0 } : priceOf(prices, item);
        rewards.push({ item, rarity, plat: price ? price.plat : null, ducats: ducats.get(lower(item)) ?? 0, volume: price?.volume ?? 0 });
      }
      const name = `${tier} ${code}`;
      relics.set(lower(name), { tier, code, name, vaulted: entry.vaulted === true, rewards, complete: rewards.length === SLOTS.length });
    }
  }
  return { relics, prices, fetchedAt, stale };
}

export interface RelicValue {
  /** Expected plat from opening one relic alone. */
  solo: number;
  /** Expected plat per player in a radshare: the best of four rewards. */
  radshare: number;
  /** Expected ducats from opening one alone. */
  ducats: number;
  /** The reward that trades for the most. */
  best: BookReward | null;
}

/** What a relic is worth at a refinement (pure). A reward without a price counts as worth nothing. */
export function relicValue(relic: BookRelic, refinement: Refinement): RelicValue {
  const draws = relic.rewards.map((r) => ({ v: r.plat ?? 0, p: slotChance(refinement, r.rarity), d: r.ducats }));
  const solo = draws.reduce((s, x) => s + x.v * x.p, 0);
  const ducats = draws.reduce((s, x) => s + x.d * x.p, 0);
  // E[max of four draws] = Σ v_j (F(v_j)^4 − F(v_j−1)^4), over the rewards from cheapest to dearest. A reward the table lacks is worth
  // nothing, so its chance sits below the cheapest.
  const known = draws.reduce((s, x) => s + x.p, 0);
  let below = Math.max(0, 1 - known);
  let radshare = 0;
  for (const x of [...draws].sort((a, b) => a.v - b.v)) {
    const upTo = below + x.p;
    radshare += x.v * (upTo ** 4 - below ** 4);
    below = upTo;
  }
  const best = relic.rewards.reduce<BookReward | null>((b, r) => ((r.plat ?? 0) > (b?.plat ?? 0) ? r : b), null);
  return { solo, radshare, ducats, best };
}

/** The value a squad gets: alone, or per player in a radshare. */
export const valueFor = (v: RelicValue, squad: Squad): number => (squad === 'radshare' ? v.radshare : v.solo);

/** A relic by name ("Axi A1", "axi a1 radiant", "Axi A1 Relic"); Vanguard relics by their full name. */
export function findRelic(book: RelicBook, name: string): BookRelic | null {
  const base = relicBaseName(name) ?? name.trim().replace(/\s+relic$/i, '');
  return book.relics.get(lower(base)) ?? null;
}

export interface RankedRelic {
  relic: BookRelic;
  value: RelicValue;
}

/** The relics worth the most at a refinement, for a solo run or a radshare (pure). */
export function bestRelics(book: RelicBook, opts: { refinement: Refinement; squad: Squad; vaulted: VaultFilter; tier?: string | null; limit?: number }): RankedRelic[] {
  const tier = opts.tier ? lower(opts.tier) : null;
  return [...book.relics.values()]
    .filter((r) => (opts.vaulted === 'exclude' ? !r.vaulted : opts.vaulted === 'only' ? r.vaulted : true))
    .filter((r) => !tier || lower(r.tier) === tier)
    .map((relic) => ({ relic, value: relicValue(relic, opts.refinement) }))
    .sort((a, b) => valueFor(b.value, opts.squad) - valueFor(a.value, opts.squad) || a.relic.name.localeCompare(b.relic.name))
    .slice(0, opts.limit ?? 10);
}

let memo: { at: number; book: RelicBook } | null = null;
let inflight: Promise<RelicBook> | null = null;

/** The book, read through the API cache (WFInfo's lists are refreshed every 6 hours; stale ones are served when the source is down). */
export function loadRelicBook(opts: { background?: boolean } = {}): Promise<RelicBook> {
  if (memo && Date.now() - memo.at < MEMO_MS) return Promise.resolve(memo.book);
  const read = { kind: 'stable' as const, ttlMs: BOOK_TTL_MS, ...(opts.background ? { background: true } : {}) };
  inflight ??= Promise.all([apiJson<WfinfoTable>(`${WFINFO}/filtered_items`, read), apiJson<WfinfoPrice[]>(`${WFINFO}/prices`, read)])
    .then(([table, list]) => {
      if (!table.data?.relics || !Array.isArray(list.data)) throw new Error('The relic price list could not be read.');
      const book = buildRelicBook(table.data, list.data, Date.now() - Math.max(table.ageMs, list.ageMs), table.stale || list.stale);
      memo = { at: Date.now(), book };
      return book;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** What the book holds right now, without reading anything (for get_bot_health). */
export function relicBookState(): { relics: number; prices: number; fetchedAt: number; stale: boolean } | null {
  return memo ? { relics: memo.book.relics.size, prices: memo.book.prices.size, fetchedAt: memo.book.fetchedAt, stale: memo.book.stale } : null;
}

/** Test hook. */
export function resetRelicBook(): void {
  memo = null;
  inflight = null;
}
