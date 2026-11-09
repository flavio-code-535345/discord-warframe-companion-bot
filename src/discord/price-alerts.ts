import type { AppContext } from '../context.js';
import { type TrackerSpec, parseSpec, priceDecision } from '../trackers.js';
import { priceCheck } from '../warframe/market.js';
import { priceDm, sendDm } from './dm.js';
import { brandIcon } from './identity.js';

/**
 * Price trackers (/track price): every half hour the cheapest online seller of each tracked item is read from warframe.market (one
 * request per item, shared by everyone tracking it, through the shared API client) and the member is DM'd once when it is at or below
 * their limit. Whether a tracker has already alerted is kept in bot_meta (`price_alert:<trackerId>`).
 */

export const PRICE_CHECK_MS = 30 * 60_000;
/** At most this many different items are read per round, so a long list can't flood warframe.market. */
const MAX_ITEMS_PER_ROUND = 30;
const alertKey = (id: number) => `price_alert:${id}`;

type PriceSpec = Extract<TrackerSpec, { kind: 'price' }>;

export async function checkPriceTrackers(ctx: AppContext): Promise<void> {
  const { store, config } = ctx;
  const trackers = store
    .listTrackers(config.DISCORD_GUILD_ID)
    .map((t) => ({ t, spec: parseSpec(t.spec) }))
    .filter((x): x is { t: typeof x.t; spec: PriceSpec } => x.spec?.kind === 'price');
  if (!trackers.length) return;
  const slugs = [...new Set(trackers.map((x) => x.spec.slug))].slice(0, MAX_ITEMS_PER_ROUND);
  const cheapest = new Map<string, { price: number | null; seller: string | null; url: string }>();
  for (const slug of slugs) {
    try {
      const r = await priceCheck(slug, config.WARFRAME_PLATFORM, 1);
      // Old (stale) prices are not good enough to send someone to buy.
      if (r.staleMs === undefined) cheapest.set(slug, { price: r.sell[0]?.platinum ?? null, seller: r.sell[0]?.user.ingameName ?? null, url: r.url });
    } catch (err) {
      console.warn(`[price-alerts] could not read ${slug}:`, (err as Error).message);
    }
  }
  for (const { t, spec } of trackers) {
    const now = cheapest.get(spec.slug);
    if (!now) continue;
    const decision = priceDecision(spec.below, now.price, store.getMeta(alertKey(t.id)) === '1');
    if (decision === 'reset') store.setMeta(alertKey(t.id), '');
    if (decision !== 'alert') continue;
    store.setMeta(alertKey(t.id), '1');
    const card = priceDm({ name: spec.name, price: now.price!, below: spec.below, seller: now.seller, url: now.url, trackerId: t.id }, brandIcon(ctx) ?? null);
    await sendDm(ctx, t.userId, card, 'a price alert');
  }
}
