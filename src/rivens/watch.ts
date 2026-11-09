import type { AppContext } from '../context.js';
import { rivenDm, sendDm } from '../discord/dm.js';
import { brandIcon } from '../discord/identity.js';
import type { Tracker } from '../db.js';
import { type TrackerSpec, parseSpec } from '../trackers.js';
import { ApiBlockedError, ApiBusyError } from '../warframe/fetch.js';
import { matchesFilter, unitsOf } from './find.js';
import { fetchComparable, getRivenAttributes, searchPageUrl } from './market.js';
import { attributeNames } from './service.js';
import type { RivenListing } from './types.js';

/**
 * The riven watch (/riven watch, a tracker of kind `riven`): every 5 minutes warframe.market is asked what is for sale for the watched
 * weapons and bonuses, and a member is DM'd about each riven that matches their watch and has not been seen before. Trackers that ask
 * for the same weapon, bonuses and curse share one search; at most MAX_SEARCHES_PER_ROUND are made a round (the ones that waited longest
 * first), as background work with half of the request budget, so many watches only make each one a little slower. What a tracker has
 * seen is kept in `seen_worldstate` (`riven:<trackerId>:<auctionId>`, refreshed while the riven stays listed); the rivens already for
 * sale when a watch starts are recorded without a DM (`riven_watch_seeded:<trackerId>`).
 */

export const RIVEN_WATCH_MS = 5 * 60_000;
/** Watches one member may have; each is a search every few minutes. */
export const MAX_RIVEN_WATCHES = 3;
const MAX_SEARCHES_PER_ROUND = 6;
/** A search the watch makes may be answered from the API client's cache for this long. */
const WATCH_TTL_MS = 60_000;

type RivenSpec = Extract<TrackerSpec, { kind: 'riven' }>;

const seenKey = (trackerId: number, auctionId: string) => `riven:${trackerId}:${auctionId}`;
const seededKey = (trackerId: number) => `riven_watch_seeded:${trackerId}`;
/** Watches that make the same request. The bonuses are sorted so "cc ms" and "ms cc" share it. */
const groupKey = (s: RivenSpec) => `${s.weapon}|${[...s.positives].sort().join(',')}|${s.negative ?? ''}`;

/** When each group was last searched (memory only: after a restart every group is simply due). */
const checkedAt = new Map<string, number>();

/** Test hook. */
export const resetRivenWatch = (): void => checkedAt.clear();

const asFilter = (s: RivenSpec) => ({ positives: s.positives, negative: s.negative ?? null, noCurse: s.noCurse === true, maxPrice: s.maxPrice });

/**
 * Records what a watch matches now. Returns the listings it had not seen before, cheapest first; for a watch that has never looked
 * (just created, or created while warframe.market could not be read) that is none, because those were already for sale.
 */
export function noteMatches(ctx: Pick<AppContext, 'store'>, trackerId: number, spec: RivenSpec, listings: RivenListing[]): RivenListing[] {
  const { store } = ctx;
  const fresh: RivenListing[] = [];
  for (const l of listings) {
    if (!matchesFilter(l, asFilter(spec))) continue;
    if (store.refreshSeen(seenKey(trackerId, l.id))) fresh.push(l);
  }
  if (!store.getMeta(seededKey(trackerId))) {
    store.setMeta(seededKey(trackerId), String(Date.now()));
    return [];
  }
  return fresh.sort((a, b) => a.price - b.price);
}

/** One round of the riven watch (the `riven-watch` job). */
export async function checkRivenWatches(ctx: AppContext, now = Date.now()): Promise<void> {
  const { store, config } = ctx;
  const watches = store
    .listTrackers(config.DISCORD_GUILD_ID)
    .map((t) => ({ t, spec: parseSpec(t.spec) }))
    .filter((x): x is { t: Tracker; spec: RivenSpec } => x.spec?.kind === 'riven');
  if (!watches.length) return;

  const groups = new Map<string, { spec: RivenSpec; watches: { t: Tracker; spec: RivenSpec }[] }>();
  for (const w of watches) {
    const key = groupKey(w.spec);
    const g = groups.get(key);
    if (g) g.watches.push(w);
    else groups.set(key, { spec: w.spec, watches: [w] });
  }
  const due = [...groups].sort(([a], [b]) => (checkedAt.get(a) ?? 0) - (checkedAt.get(b) ?? 0)).slice(0, MAX_SEARCHES_PER_ROUND);

  // Stat names for the DMs; without the list (warframe.market unreachable) the slugs are shown.
  const attrs = await getRivenAttributes().catch(() => []);
  const names = attributeNames(attrs);
  const units = unitsOf(attrs);

  let failure: unknown = null;
  for (const [key, group] of due) {
    const positives = [...group.spec.positives].sort();
    const negative = group.spec.negative ?? null;
    let listings: RivenListing[];
    try {
      listings = (await fetchComparable(group.spec.weapon, positives, negative, { ttlMs: WATCH_TTL_MS, background: true })).listings;
    } catch (err) {
      // The request budget is full or warframe.market asked for a pause: the next round tries again, nothing is wrong here.
      if (err instanceof ApiBusyError || err instanceof ApiBlockedError) break;
      // Anything else moves this search to the back of the line and ends the round; the job reports it.
      checkedAt.set(key, now);
      failure = err;
      break;
    }
    checkedAt.set(key, now);
    for (const { t, spec } of group.watches) {
      const fresh = noteMatches(ctx, t.id, spec, listings);
      if (!fresh.length) continue;
      const card = rivenDm(
        { weaponName: spec.weaponName, label: spec.label, maxPrice: spec.maxPrice, trackerId: t.id, listings: fresh, names, units, searchUrl: searchPageUrl(spec.weapon, spec.positives, spec.negative ?? null) },
        brandIcon(ctx) ?? null,
      );
      await sendDm(ctx, t.userId, card, 'a riven watch');
    }
  }
  if (failure) throw failure;
}
