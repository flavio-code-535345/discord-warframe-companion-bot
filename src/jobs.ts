import type { AppContext } from './context.js';
import { BACKUP_CHECK_MS, backupIfDue } from './backup/service.js';
import { postBirthdays } from './birthdays/service.js';
import { refreshEmojis } from './discord/app-emojis.js';
import { eventsJob, newsJob, worldStateJob } from './discord/notifier.js';
import { PRICE_CHECK_MS, checkPriceTrackers } from './discord/price-alerts.js';
import { updatePromoCodes } from './discord/promo-codes.js';
import { endDueGiveaways } from './giveaways/service.js';
import { VOICE_XP_MS, awardVoiceXp } from './leveling/service.js';
import { SWEEP_INTERVAL_MS, sweepVoice } from './lfg/voice.js';
import { RIVEN_FIRST_MS, type RivenCrawler } from './rivens/crawler.js';
import { Scheduler } from './scheduler.js';
import { WIKI_CHECK_MS, WIKI_FIRST_MS, type WikiCrawler } from './wiki/crawler.js';

const MIN = 60_000;

/** Every background job of the bot; `get_bot_health` and the admin panel read `jobs.stats()`. */
export const jobs = new Scheduler();

/**
 * Registers the jobs once; `jobs.start()` (at ClientReady) plans them and `jobs.stop()` (at shutdown) clears them. Each job is its own
 * failure: a broken birthday post never holds up the world state, and the error shows in the job's stats.
 */
export function registerJobs(ctx: AppContext, parts: { rivenCrawler: RivenCrawler; wikiCrawler: WikiCrawler | null }): Scheduler {
  jobs
    // Reminders don't depend on the world state, so they still go out when its source is down.
    .every('events', MIN, () => eventsJob(ctx))
    .every('giveaways', MIN, () => endDueGiveaways(ctx))
    .every('birthdays', 5 * MIN, () => postBirthdays(ctx), { firstMs: MIN })
    .every('promo-codes', MIN, () => updatePromoCodes(ctx), { firstMs: MIN })
    .every('news', MIN, () => newsJob(ctx), { firstMs: 30_000 })
    .every('price-alerts', PRICE_CHECK_MS, () => checkPriceTrackers(ctx), { firstMs: 2 * MIN })
    .every('world-state', MIN, () => worldStateJob(ctx), { firstMs: 5_000 })
    .every('squad-voice', SWEEP_INTERVAL_MS, () => sweepVoice(ctx), { firstMs: SWEEP_INTERVAL_MS })
    .every('voice-xp', VOICE_XP_MS, () => awardVoiceXp(ctx), { firstMs: VOICE_XP_MS })
    // Give the gateway a minute to settle before the first backup check.
    .every('backups', BACKUP_CHECK_MS, () => backupIfDue(ctx), { firstMs: MIN })
    .every('emojis', 30 * MIN, () => refreshEmojis(ctx), { firstMs: 2_000 })
    // One weapon per interval; the setting can change at runtime, so the job says how long to wait after each read.
    .every(
      'riven-crawl',
      parts.rivenCrawler.intervalMs,
      async () => {
        await parts.rivenCrawler.tick();
        return parts.rivenCrawler.intervalMs;
      },
      { firstMs: RIVEN_FIRST_MS },
    );
  const wiki = parts.wikiCrawler;
  if (wiki) jobs.every('wiki-index', WIKI_CHECK_MS, () => wiki.maybeRefresh(), { firstMs: WIKI_FIRST_MS });
  return jobs;
}
