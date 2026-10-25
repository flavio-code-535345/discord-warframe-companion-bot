import type { Client } from 'discord.js';
import type { AskLimiter } from './ai/limits.js';
import type { OrdisBrain } from './ai/ordis.js';
import type { Config } from './config.js';
import type { Store } from './db.js';

/** Everything the Discord handlers, the notifier and the MCP tools share. */
export interface AppContext {
  config: Config;
  store: Store;
  client: Client;
  /** AI chat; null when ANTHROPIC_API_KEY isn't configured. */
  ai: { brain: OrdisBrain; limiter: AskLimiter } | null;
}
