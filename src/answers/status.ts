import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Lets slow answer steps say what they are doing ("Searching the wiki", "Reading a wiki page"...) without every function
 * in between passing a callback along. `withStatus` scopes a listener to one answer; `reportStatus` is a no-op outside one.
 */
const store = new AsyncLocalStorage<(status: string) => void>();

export const withStatus = <T>(listener: ((status: string) => void) | undefined, fn: () => Promise<T>): Promise<T> => (listener ? store.run(listener, fn) : fn());

export function reportStatus(status: string): void {
  try {
    store.getStore()?.(status);
  } catch {
    // A broken listener must never break an answer.
  }
}

const TOOL_STATUS: Record<string, string> = {
  search_wiki: '🔎 Searching the wiki',
  read_wiki_page: '📖 Reading a wiki page',
  lookup_item: '🗂️ Looking up the item',
  search_drops: '📦 Checking the drop tables',
  price_check: '💰 Checking market prices',
  get_worldstate: '🌍 Checking the world state',
  get_fissures: '🌀 Checking the fissures',
  search_web: '🌐 Searching the web',
  get_clan_info: '🐀 Checking clan info',
};

export const toolStatus = (tool: string): string => TOOL_STATUS[tool] ?? `🔧 Using ${tool}`;
