import { toMs } from '../time.js';
import { ApiBlockedError, ApiBusyError } from './fetch.js';
import { getItemIndex, marketPrice, topOrders } from './market.js';
import { type WorldState, getWorldState, isBaroHere, worldStateEnabled } from './worldstate.js';

/**
 * What Baro Ki'Teer's stock trades for on warframe.market, for the traders board's plat per ducat. While he is at a relay the
 * `baro-prices` job reads one item's top orders every 20 seconds as background work (a mod at rank 0, since Baro sells them unranked),
 * so a visit of 30 items is priced within about ten minutes and read again every 6 hours. An item warframe.market doesn't list under
 * exactly that name (cosmetics, the Void Surplus) is skipped. The prices of the current visit are kept in bot_meta (`baro_prices`), so a
 * restart reads nothing again; between visits the job sleeps until he lands.
 */

const META = 'baro_prices';
/** How often an item is read again during a visit (Baro stays 48 hours). */
const REFRESH_MS = 6 * 3_600_000;
/** When a read failed: the next try. */
const RETRY_MS = 30 * 60_000;
/** One read every this long while something has no price. */
export const BARO_PRICE_MS = 20_000;
/** The longest the job sleeps (Baro away, or everything priced). */
const IDLE_MS = 30 * 60_000;

interface Priced {
  plat: number | null;
  at: number;
}

interface BaroPrices {
  /** The visit (Baro's activation time) these prices belong to. */
  visit: number;
  /** By lower-case item name. */
  items: Record<string, Priced>;
}

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

function readPrices(store: MetaStore): BaroPrices | null {
  try {
    const v = JSON.parse(store.getMeta(META) || 'null') as BaroPrices | null;
    return v && typeof v.visit === 'number' && v.items && typeof v.items === 'object' ? v : null;
  } catch {
    return null;
  }
}

const clampDelay = (ms: number) => Math.min(IDLE_MS, Math.max(BARO_PRICE_MS, ms));

/**
 * One step of the `baro-prices` job: reads the price of the next item of Baro's stock that has none yet or an old one. Returns the delay
 * until the next step: 20 seconds while there is more to read, else until the next refresh or his next visit (at most 30 minutes).
 */
export async function priceBaroStock(ctx: { store: MetaStore; config: { WARFRAME_PLATFORM: string } }, now = Date.now()): Promise<number> {
  if (!worldStateEnabled()) return IDLE_MS;
  const ws = await getWorldState().catch(() => null);
  const t = ws?.voidTrader;
  if (!ws || !t || !isBaroHere(ws, now)) return clampDelay(t ? toMs(t.activation) - now : IDLE_MS);

  const visit = toMs(t.activation);
  const saved = readPrices(ctx.store);
  const prices: BaroPrices = saved?.visit === visit ? saved : { visit, items: {} };
  const byName = new Map((await getItemIndex()).map((i) => [i.name.toLowerCase(), i]));
  const save = () => ctx.store.setMeta(META, JSON.stringify(prices));

  for (const entry of t.inventory) {
    const name = entry.item.toLowerCase();
    const known = prices.items[name];
    if (known && now - known.at < REFRESH_MS) continue;
    const item = byName.get(name);
    if (!item) {
      prices.items[name] = { plat: null, at: now };
      continue;
    }
    try {
      const orders = await topOrders(item.slug, { platform: ctx.config.WARFRAME_PLATFORM, ...(item.maxRank ? { rank: 0 } : {}), background: true, scope: 'baro' });
      prices.items[name] = { plat: marketPrice(orders.sell), at: now };
    } catch (err) {
      // The request budget is full or the market asked us to wait: nothing is recorded, the same item comes up again later.
      if (err instanceof ApiBusyError || err instanceof ApiBlockedError) {
        save();
        return err instanceof ApiBlockedError ? clampDelay(err.until - now) : 60_000;
      }
      // Anything else: this item is tried again in half an hour, and the failure shows in the job's health.
      prices.items[name] = { plat: known?.plat ?? null, at: now - REFRESH_MS + RETRY_MS };
      save();
      throw err;
    }
    save();
    return BARO_PRICE_MS;
  }
  save();
  const nextDue = Math.min(...Object.values(prices.items).map((p) => p.at + REFRESH_MS)) - now;
  return clampDelay(Number.isFinite(nextDue) ? nextDue : IDLE_MS);
}

/** Plat per Baro item (by name, any case) for his current visit, or null before anything is priced. */
export function baroPriceLookup(store: MetaStore, ws: WorldState | null): ((item: string) => number | null) | null {
  const t = ws?.voidTrader;
  if (!t) return null;
  const saved = readPrices(store);
  if (!saved || saved.visit !== toMs(t.activation)) return null;
  return (item) => saved.items[item.toLowerCase()]?.plat ?? null;
}

/** For get_bot_health: how much of the current visit is priced. */
export function baroPriceState(store: MetaStore): { visit: number; items: number; priced: number } | null {
  const saved = readPrices(store);
  if (!saved) return null;
  const all = Object.values(saved.items);
  return { visit: saved.visit, items: all.length, priced: all.filter((p) => p.plat !== null).length };
}
