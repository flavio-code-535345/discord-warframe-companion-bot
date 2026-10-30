import { AsyncLocalStorage } from 'node:async_hooks';
import { own } from '../own.js';

/**
 * Lets slow answer steps say what they are doing ("Searching the wiki", "Reading a wiki page"...) without every function
 * in between passing a callback along. `withStatus` scopes a listener to one answer; `reportStatus` is a no-op outside one.
 * The listener may also have a `queue` function: it hears where the answer stands in the line for the model (see queue.ts).
 */
export interface StatusListener {
  (status: string): void;
  /** 0 when it is the answer's turn (or there was no wait), 1 for next in line, 2 after that... */
  queue?: (position: number) => void;
}

const store = new AsyncLocalStorage<StatusListener>();

export const withStatus = <T>(listener: StatusListener | undefined, fn: () => Promise<T>): Promise<T> => (listener ? store.run(listener, fn) : fn());

export function reportQueue(position: number): void {
  try {
    store.getStore()?.queue?.(position);
  } catch {
    // A broken listener must never break an answer.
  }
}

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
  read_web_page: '📰 Reading a web page',
  calculate: '🧮 Doing the maths',
  get_time: '🕐 Checking the time',
  grade_riven: '🎲 Grading the riven',
  riven_top_rolls: '🎲 Checking what sells',
};

export const toolStatus = (tool: string): string => own(TOOL_STATUS, tool) ?? `🔧 Using ${tool}`;
