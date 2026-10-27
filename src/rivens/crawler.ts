import type { AppContext } from '../context.js';
import { ApiBlockedError, api } from '../warframe/fetch.js';
import { RIVEN_SCOPE, fetchListings, getRivenWeapons } from './market.js';
import type { RivenCrawlRow, RivenWeapon } from './types.js';

/**
 * The slow, polite background read of warframe.market's riven listings: ONE request per interval (45 s by default, so a full pass over
 * the ~420 weapons takes about five hours and repeats every few days), nothing at all while the host has asked us to back off, and a
 * long pause after repeated failures. It runs as background work in its own `rivens` API scope, so it can't slow down or block /price.
 */

/** A weapon whose read just failed is left alone this long. */
const RETRY_AFTER_FAILURE_MS = 6 * 3_600_000;
/** After this many failures in a row (different weapons) the whole crawl rests. */
const MAX_FAILURES = 3;
const REST_MS = 3_600_000;
const FIRST_DELAY_MS = 3 * 60_000;

/** The next weapon to read: never-read ones first (in list order), then the one read longest ago that is due; null when nothing is due. */
export function pickWeapon(weapons: RivenWeapon[], rows: RivenCrawlRow[], now: number, refreshMs: number, retryMs = RETRY_AFTER_FAILURE_MS): RivenWeapon | null {
  const byWeapon = new Map(rows.map((r) => [r.weapon, r]));
  let best: { w: RivenWeapon; key: number } | null = null;
  for (const w of weapons) {
    const row = byWeapon.get(w.slug);
    let key: number;
    if (!row) key = -1;
    else {
      if (now - row.attemptedAt < retryMs) continue;
      if (row.fetchedAt !== null && now - row.fetchedAt < refreshMs) continue;
      key = row.fetchedAt ?? 0;
    }
    if (!best || key < best.key) best = { w, key };
  }
  return best?.w ?? null;
}

export type TickResult = 'read' | 'idle' | 'off' | 'paused' | 'failed';

export class RivenCrawler {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private pausedUntil = 0;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.schedule(FIRST_DELAY_MS);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err) => console.warn('[riven] crawl step failed:', err))
        .finally(() => this.schedule(Math.max(10, this.ctx.config.RIVEN_CRAWL_INTERVAL_SECONDS) * 1000));
    }, ms);
    this.timer.unref();
  }

  async tick(now = Date.now()): Promise<TickResult> {
    const { config, store } = this.ctx;
    if (!config.RIVEN_CRAWL_ENABLED) return 'off';
    const waitFor = Math.max(this.pausedUntil - now, api.blockedFor(`api.warframe.market#${RIVEN_SCOPE}`));
    if (waitFor > 0) return 'paused';
    let weapons: RivenWeapon[];
    try {
      weapons = await getRivenWeapons();
    } catch (err) {
      return this.failed(err, now);
    }
    const next = pickWeapon(weapons, store.rivenCrawlRows(), now, config.RIVEN_REFRESH_DAYS * 86_400_000);
    if (!next) return 'idle';
    try {
      const listings = await fetchListings(next.slug, { background: true, ttlMs: 60_000 });
      store.replaceRivenListings(next.slug, listings, now);
      this.failures = 0;
      return 'read';
    } catch (err) {
      store.markRivenFailure(next.slug, err instanceof Error ? err.message : String(err), now);
      return this.failed(err, now);
    }
  }

  private failed(err: unknown, now: number): TickResult {
    if (err instanceof ApiBlockedError) {
      this.pausedUntil = err.until;
    } else if (++this.failures >= MAX_FAILURES) {
      this.failures = 0;
      this.pausedUntil = now + REST_MS;
      console.warn(`[riven] ${MAX_FAILURES} reads failed in a row; resting for an hour. Last error: ${err instanceof Error ? err.message : err}`);
    }
    return 'failed';
  }
}
