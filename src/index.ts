import 'reflect-metadata';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { Store } from './db.js';
import { attachHandlers, createClient } from './discord/bot.js';
import { Notifier } from './discord/notifier.js';
import { startHttpServer } from './http.js';
import { getItemIndex } from './warframe/market.js';

const config = loadConfig();
const store = new Store(join(config.DATA_DIR, 'bot.db'));
const client = createClient(config.ENABLE_WELCOME);
const ctx: AppContext = { config, store, client };

attachHandlers(ctx);
const notifier = new Notifier(ctx);
client.once('clientReady', () => notifier.start());

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
  notifier.stop();
  http.close();
  await client.destroy();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
