import type { Client } from 'discord.js';
import type { Config } from './config.js';
import type { Store } from './db.js';

/** Everything the Discord handlers, the notifier and the MCP tools share. */
export interface AppContext {
  config: Config;
  store: Store;
  client: Client;
}
