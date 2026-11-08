import { join } from 'node:path';
import { configureWorldState } from './warframe/worldstate.js';
import { reportStart, reportStop } from './lifecycle.js';
import { RivenCrawler } from './rivens/crawler.js';
import { WikiCrawler } from './wiki/crawler.js';
import { WikiIndex, setWikiIndex } from './wiki/index.js';
import { onRestart } from './selfupdate.js';
import { loadConfig } from './config.js';
import { initRuntimeConfig, onSettingChange } from './runtime-config.js';
import { configureApi } from './warframe/fetch.js';
import { screenshotQueue } from './queue.js';
import { syncIdentity } from './discord/identity.js';
import type { AppContext } from './context.js';
import { Store } from './db.js';
import { attachHandlers, createClient } from './discord/bot.js';
import { attachAuditLogging } from './logging/service.js';
import { registerJobs } from './jobs.js';
import { startHttpServer } from './http.js';
import { getItemIndex } from './warframe/market.js';

const config = loadConfig();
const store = new Store(join(config.DATA_DIR, 'bot.db'));
// Values saved on the panel's Config page win over the environment (src/runtime-config.ts); apply them before anything reads the config.
initRuntimeConfig(config, store);
const applyApiConfig = () =>
  configureApi({
    store,
    limits: {
      minIntervalMs: config.API_MIN_INTERVAL_MS,
      perMinute: config.API_RATE_LIMIT_PER_MINUTE,
      cooldownMs: config.API_COOLDOWN_MINUTES * 60_000,
      maxRetries: config.API_MAX_RETRIES,
      priceTtlMs: config.API_PRICE_CACHE_SECONDS * 1000,
      stableTtlMs: config.API_STABLE_CACHE_HOURS * 3_600_000,
    },
  });
applyApiConfig();
const applyQueueConfig = () => {
  screenshotQueue.configure({ concurrency: config.QUEUE_SCREENSHOTS_CONCURRENCY, maxWaiting: config.QUEUE_MAX_WAITING });
};
applyQueueConfig();
const client = createClient(config);
const applyWorldState = () =>
  configureWorldState({
    url: config.WORLDSTATE_URL,
    platform: config.WARFRAME_PLATFORM,
    enabled: config.WORLDSTATE_ENABLED,
    intervalSeconds: config.WORLDSTATE_POLL_SECONDS,
    smartPoll: config.WORLDSTATE_SMART_POLL,
    maxPollMinutes: config.WORLDSTATE_MAX_POLL_MINUTES,
    store,
    cacheFile: join(config.DATA_DIR, 'worldstate.cache'),
  });
applyWorldState();
const ctx: AppContext = { config, store, client };
// A few settings need more than a changed value when they change at runtime.
onSettingChange((key) => {
  if (key.startsWith('API_')) applyApiConfig();
  if (key.startsWith('QUEUE_')) applyQueueConfig();
  if (key.startsWith('WORLDSTATE_') || key === 'WARFRAME_PLATFORM') applyWorldState();
  if (key === 'BOT_NAME' && client.isReady()) void syncIdentity(ctx).catch((err) => console.warn('[identity] could not update the bot name:', err));
});

attachHandlers(ctx);
attachAuditLogging(ctx);
// The wiki index lives in its own file: it is big, rebuildable, and must not bloat the main database or backups.
const wikiIndex = config.WIKI_INDEX ? new WikiIndex(join(config.DATA_DIR, 'wiki.db')) : null;
setWikiIndex(wikiIndex);
// Every recurring task is a job of one scheduler (src/jobs.ts), started once Discord is ready.
const jobs = registerJobs(ctx, { rivenCrawler: new RivenCrawler(ctx), wikiCrawler: wikiIndex ? new WikiCrawler(wikiIndex) : null });
client.once('clientReady', () => {
  jobs.start();
  void reportStart(ctx);
});

const http = startHttpServer(ctx);
// Warm the market item index so the first /price autocomplete answers within Discord's 3s limit.
getItemIndex().catch((err) => console.warn('[market] could not preload item index:', err));

try {
  await client.login(config.DISCORD_TOKEN);
} catch (err) {
  console.error('[discord] login failed — check DISCORD_TOKEN (and the Server Members intent if ENABLE_WELCOME=true):', err);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[app] ${signal} received, shutting down`);
  await reportStop(ctx, signal);
  jobs.stop();
  http.close();
  await client.destroy();
  store.close();
  wikiIndex?.close();
  process.exit(0);
}
// A restart from the panel or the MCP goes through the same shutdown, so it is reported as a stop and the next start is not taken for a crash.
onRestart(() => shutdown('restart request'));
// A stray failure in a background task (an OCR worker, a Discord call) must not take the whole bot down.
process.on('unhandledRejection', (reason) => console.error('[process] unhandled rejection:', reason));
process.on('uncaughtException', (err) => console.error('[process] uncaught exception:', err));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
