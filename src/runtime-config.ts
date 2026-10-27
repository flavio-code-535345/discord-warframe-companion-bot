import type { z } from 'zod';
import { type Config, EnvSchema } from './config.js';
import type { Store } from './db.js';

/**
 * Settings that used to need an environment variable and a redeploy, now editable in the admin panel (Config page).
 * The environment still works as the starting value: a panel value, when set, wins over it, and clearing the panel value
 * falls back to the environment (or the built-in default). Panel values live in `bot_meta` (`cfg_<NAME>` = `v:<text>`),
 * and are applied by writing into the one shared `config` object, so every `ctx.config.X` read sees them at once.
 *
 * Not here on purpose (they stay environment-only): tokens and secrets, where the bot listens, where its data lives, and
 * everything the panel's own login depends on, so the panel can never lock you out or leak a key.
 */

export type SettingKind = 'bool' | 'int' | 'text' | 'select' | 'ids';

export interface SettingDef {
  key: keyof Config & string;
  label: string;
  help: string;
  group: string;
  kind: SettingKind;
  options?: readonly string[];
  /** Read when the bot starts (Discord intents, the wiki index, rate limiters): a change is saved now and applies after a restart. */
  restart?: boolean;
  /** Only the panel owners (PANEL_OWNER_IDS) may change it. */
  ownerOnly?: boolean;
}

export const SETTINGS: SettingDef[] = [
  { key: 'WORLDSTATE_ENABLED', group: 'Warframe data', kind: 'bool', label: 'Live world state', help: 'Fetch alerts, fissures, cycles and the rest from the warframestat.us API (never from Digital Extremes directly).' },
  { key: 'WORLDSTATE_SMART_POLL', group: 'Warframe data', kind: 'bool', label: 'Smart polling', help: 'Refresh when something is due to change (alerts, sortie, Baro, daily deals, bounties...) instead of on a fixed timer. Fewer calls; new fissures and alerts can show up a little later. The poll interval below is the minimum gap.' },
  { key: 'WORLDSTATE_MAX_POLL_MINUTES', group: 'Warframe data', kind: 'int', label: 'Smart polling: longest wait (minutes)', help: 'The most time that passes without a refresh when smart polling is on. 5 to 720.' },
  { key: 'WORLDSTATE_URL', group: 'Warframe data', kind: 'text', label: 'World state relay URL', help: 'A warframestat.us-compatible endpoint (the parsed world state as JSON), instead of api.warframestat.us/<platform>. Empty = the public API.' },
  { key: 'WORLDSTATE_POLL_SECONDS', group: 'Warframe data', kind: 'int', label: 'World state poll interval (seconds)', help: 'Minimum time between calls to the feed. At least 60.' },
  { key: 'WARFRAME_PLATFORM', group: 'Warframe data', kind: 'select', options: ['pc', 'ps4', 'xbox', 'switch', 'mobile'], label: 'Platform', help: 'Which platform /price and Ordis look at on warframe.market, and which world state (pc, ps4, xbox, switch) is shown.' },

  { key: 'QUEUE_QUESTIONS_CONCURRENCY', group: 'Queues', kind: 'int', label: 'Questions answered at the same time', help: 'Questions that need the model wait in line; this many run at once (1 to 4). 1 suits a CPU model.' },
  { key: 'QUEUE_SCREENSHOTS_CONCURRENCY', group: 'Queues', kind: 'int', label: 'Screenshots read at the same time', help: 'Screenshots wait in line too (1 to 4).' },
  { key: 'QUEUE_MAX_WAITING', group: 'Queues', kind: 'int', label: 'Longest line', help: 'How many may wait in each queue (1 to 100). More than that are asked to try again later; one person can have 2 waiting.' },
  { key: 'API_MIN_INTERVAL_MS', group: 'API limits and cache', kind: 'int', label: 'Minimum gap between requests (ms)', help: 'Between two requests to the same host (warframestat.us, warframe.market, the wiki, DE). 0 to 10000.' },
  { key: 'API_RATE_LIMIT_PER_MINUTE', group: 'API limits and cache', kind: 'int', label: 'Requests per minute (all hosts)', help: 'Global cap. Background work (the wiki crawler) may only use half of it. 5 to 600.' },
  { key: 'API_COOLDOWN_MINUTES', group: 'API limits and cache', kind: 'int', label: 'Cooldown after a 403 (minutes)', help: 'A host that answers 403 is left completely alone this long. A 429 follows its Retry-After header instead.' },
  { key: 'API_MAX_RETRIES', group: 'API limits and cache', kind: 'int', label: 'Retries for temporary failures', help: 'Server errors and timeouts, with exponential backoff and jitter. 0 to 5.' },
  { key: 'API_PRICE_CACHE_SECONDS', group: 'API limits and cache', kind: 'int', label: 'Price cache (seconds)', help: 'How long a warframe.market price answer is reused. 10 to 3600.' },
  { key: 'API_STABLE_CACHE_HOURS', group: 'API limits and cache', kind: 'int', label: 'Item, drop and wiki cache (hours)', help: 'How long item stats, drop tables and live wiki answers are reused. 1 to 720.' },

  { key: 'CLAN_NAME', group: 'Identity', kind: 'text', label: 'Clan name', help: 'Used in answers and as the name the screenshot roles check against.' },
  { key: 'BOT_NAME', group: 'Identity', kind: 'text', label: 'Bot name', help: "The bot's Discord username and the name it uses for itself." },
  { key: 'OPERATOR_IDS', group: 'Operators', kind: 'ids', ownerOnly: true, label: 'Operator Discord IDs', help: 'Comma-separated user IDs that may give Ordis free-form instructions. Only panel owners can change this.' },

  { key: 'LOCAL_AI_URL', group: 'Local AI (Ollama)', kind: 'text', label: 'Ollama URL', help: 'OpenAI-compatible endpoint, e.g. http://192.168.178.45:11434/v1. Empty = no local model.' },
  { key: 'LOCAL_AI_MODEL', group: 'Local AI (Ollama)', kind: 'text', label: 'Default local model', help: 'Used unless a model was chosen on the AI page or with /ai model.' },
  { key: 'LOCAL_AI_TIMEOUT_SECONDS', group: 'Local AI (Ollama)', kind: 'int', label: 'Local model timeout (seconds)', help: 'How long one request to the local model may wait (5 to 300).' },

  { key: 'FREE_AI_URL', group: 'Free cloud AI', kind: 'text', label: 'Endpoint URL', help: 'Any OpenAI-compatible API. The key stays in the environment (FREE_AI_KEY).' },
  { key: 'FREE_AI_MODEL', group: 'Free cloud AI', kind: 'text', label: 'Model', help: 'The main cloud model.' },
  { key: 'FREE_AI_FALLBACK_MODEL', group: 'Free cloud AI', kind: 'text', label: 'Backup model', help: 'Tried when the main one is busy.' },
  { key: 'FREE_AI_DAILY_LIMIT', group: 'Free cloud AI', kind: 'int', label: 'Daily call limit', help: 'Calls per day before the cloud model is left alone.' },

  { key: 'SEARXNG_URL', group: 'Web search', kind: 'text', label: 'SearXNG URL', help: 'e.g. http://192.168.178.45:8888 (JSON format enabled). Empty = no web results.' },

  { key: 'ANSWER_REFRESH_ENABLED', group: 'Answer cache', kind: 'bool', label: 'Daily refresh', help: 'Research the most asked questions once a day and save verified answers.' },
  { key: 'ANSWER_REFRESH_MAX', group: 'Answer cache', kind: 'int', label: 'Questions per refresh', help: 'At most this many per run (1 to 30).' },
  { key: 'ANSWER_REFRESH_HOUR_UTC', group: 'Answer cache', kind: 'int', label: 'Refresh hour (UTC)', help: '0 to 23.' },

  { key: 'RIVEN_CRAWL_ENABLED', group: 'Riven analyzer', kind: 'bool', label: 'Slow background read', help: "Read warframe.market's riven listings one weapon at a time, so grades are ready. Off = listings are only read when someone asks for a grade." },
  { key: 'RIVEN_CRAWL_INTERVAL_SECONDS', group: 'Riven analyzer', kind: 'int', label: 'Seconds between weapons', help: 'One request per weapon (about 420 weapons). 10 to 3600; the default of 45 reads them all in about five hours.' },
  { key: 'RIVEN_REFRESH_DAYS', group: 'Riven analyzer', kind: 'int', label: 'Read each weapon again after (days)', help: '1 to 30.' },
  { key: 'RIVEN_HIGH_PRICE', group: 'Riven analyzer', kind: 'int', label: 'High-value price line (platinum)', help: 'Rivens listed at or above this count as high value when grading (50 to 100000).' },

  { key: 'AI_MODEL', group: 'Claude chat (needs ANTHROPIC_API_KEY)', kind: 'text', label: 'Claude model', help: 'Only used when an Anthropic key is set.' },
  { key: 'AI_EFFORT', group: 'Claude chat (needs ANTHROPIC_API_KEY)', kind: 'select', options: ['low', 'medium', 'high'], label: 'Claude effort', help: 'Reasoning effort.' },
  { key: 'AI_WEB_SEARCH', group: 'Claude chat (needs ANTHROPIC_API_KEY)', kind: 'bool', label: 'Claude web search', help: "Let Claude use its web search tool on Warframe sites." },
  { key: 'AI_USER_HOURLY_LIMIT', group: 'Claude chat (needs ANTHROPIC_API_KEY)', kind: 'int', restart: true, label: 'Questions per member per hour', help: 'Rate limit.' },
  { key: 'AI_DAILY_LIMIT', group: 'Claude chat (needs ANTHROPIC_API_KEY)', kind: 'int', restart: true, label: 'Questions per day', help: 'Rate limit for the whole server.' },

  { key: 'ENABLE_MESSAGE_CONTENT', group: 'Needs a restart', kind: 'bool', restart: true, label: 'Read message content', help: 'Lets Ordis read the chat channel, screenshots and sticky/audit text. Also needs the Message Content intent in the Developer Portal.' },
  { key: 'ENABLE_MEMBER_LOGGING', group: 'Needs a restart', kind: 'bool', restart: true, label: 'Log member joins and leaves', help: 'Needs the Server Members intent in the Developer Portal.' },
  { key: 'ENABLE_WELCOME', group: 'Needs a restart', kind: 'bool', restart: true, label: 'Welcome messages', help: 'Needs the Server Members intent in the Developer Portal.' },
  { key: 'WIKI_INDEX', group: 'Needs a restart', kind: 'bool', restart: true, label: 'Local wiki copy', help: 'Keep a searchable copy of the Warframe wiki.' },
];

/** Environment variables that stay environment-only, and why (shown on the Config page). */
export const ENV_ONLY: { names: string[]; why: string }[] = [
  { names: ['DISCORD_TOKEN', 'ANTHROPIC_API_KEY', 'FREE_AI_KEY', 'LOCAL_AI_KEY', 'MCP_AUTH_TOKEN', 'WATCHTOWER_TOKEN', 'DISCORD_CLIENT_SECRET'], why: 'Secrets: never stored in the database or shown in the panel.' },
  { names: ['DISCORD_GUILD_ID', 'DATA_DIR', 'HTTP_HOST', 'HTTP_PORT'], why: 'Needed before the bot (and its database) can start.' },
  { names: ['PUBLIC_URL', 'PANEL_OWNER_IDS'], why: 'The panel login depends on them; a wrong value here could lock you out.' },
  { names: ['MCP_ALLOWED_HOSTS', 'WATCHTOWER_URL', 'ALLOW_CODE_EDIT'], why: 'Security and infrastructure switches (ALLOW_CODE_EDIT lets the MCP patch the bot\'s code): deliberately not changeable from a web page.' },
];

const byKey = new Map(SETTINGS.map((s) => [s.key, s]));
export const settingDef = (key: string): SettingDef | undefined => byKey.get(key as SettingDef['key']);

const META = (key: string) => `cfg_${key}`;
const schemaOf = (key: string): z.ZodType => (EnvSchema.shape as Record<string, z.ZodType>)[key]!;

/** The default when neither the panel nor the environment sets it (undefined for optional settings). */
export const defaultOf = (key: string): unknown => {
  const r = schemaOf(key).safeParse(undefined);
  return r.success ? r.data : undefined;
};
export const hasDefault = (key: string): boolean => defaultOf(key) !== undefined;

export const show = (v: unknown): string => (Array.isArray(v) ? v.join(',') : v === undefined || v === null ? '' : String(v));

let base: Record<string, unknown> | null = null;
let booted: Record<string, string> = {};
let hook: ((key: string) => void) | null = null;

/** Called after a setting changed (and was applied), e.g. to re-configure the world state client. */
export const onSettingChange = (fn: (key: string) => void): void => {
  hook = fn;
};

/** What the panel stored: undefined when nothing, '' when the setting was explicitly cleared. */
function stored(store: Pick<Store, 'getMeta'>, key: string): string | undefined {
  const v = store.getMeta(META(key));
  return v?.startsWith('v:') ? v.slice(2) : undefined;
}

/** Parses text the way the environment is parsed. */
export function parseSetting(key: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const def = settingDef(key);
  if (!def) return { ok: false, error: 'Unknown setting.' };
  const r = schemaOf(key).safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: `${def.label}: ${r.error.issues[0]?.message ?? 'invalid value'}` };
}

function effective(key: string, store: Pick<Store, 'getMeta'>): unknown {
  const raw = stored(store, key);
  if (raw === undefined) return base![key];
  if (raw === '') return hasDefault(key) ? base![key] : undefined;
  const r = parseSetting(key, raw);
  return r.ok ? r.value : base![key];
}

function put(config: Config, key: string, value: unknown): void {
  if (value === undefined) delete (config as Record<string, unknown>)[key];
  else (config as Record<string, unknown>)[key] = value;
}

/**
 * Takes the environment values as the base and applies the panel's values on top, in place. Call once at startup, after the
 * store exists and before anything reads the settings. Safe to call again.
 */
export function initRuntimeConfig(config: Config, store: Pick<Store, 'getMeta'>): void {
  base ??= { ...config };
  for (const def of SETTINGS) put(config, def.key, effective(def.key, store));
  booted = Object.fromEntries(SETTINGS.filter((d) => d.restart).map((d) => [d.key, show((config as Record<string, unknown>)[d.key])]));
}

export interface SettingState {
  def: SettingDef;
  /** The value in force, as text. */
  value: string;
  source: 'panel' | 'environment' | 'default';
  /** The value without the panel's override (environment or default), as text. */
  fallback: string;
  /** This setting changed since the bot started and needs a restart to take effect. */
  pendingRestart: boolean;
}

export function settingStates(config: Config, store: Pick<Store, 'getMeta'>, env: NodeJS.ProcessEnv = process.env): SettingState[] {
  base ??= { ...config };
  return SETTINGS.map((def) => {
    const panel = stored(store, def.key) !== undefined;
    const value = show(effective(def.key, store));
    return {
      def,
      value,
      source: panel ? 'panel' : env[def.key] ? 'environment' : 'default',
      fallback: show(base![def.key]),
      pendingRestart: Boolean(def.restart) && booted[def.key] !== undefined && value !== booted[def.key],
    };
  });
}

/** Saves a panel value ('' = clear it: back to the default for settings that have one, else off). Validates first; returns an error text or null. */
export function setSetting(config: Config, store: Pick<Store, 'getMeta' | 'setMeta'>, key: string, raw: string): string | null {
  const def = settingDef(key);
  if (!def) return 'Unknown setting.';
  const text = raw.trim();
  if (text === '' && hasDefault(key)) {
    resetSetting(config, store, key);
    return null;
  }
  if (text !== '') {
    const r = parseSetting(key, text);
    if (!r.ok) return r.error;
  }
  base ??= { ...config };
  store.setMeta(META(key), `v:${text}`);
  put(config, key, effective(key, store));
  hook?.(key);
  return null;
}

/** Removes the panel value: the environment (or default) applies again. */
export function resetSetting(config: Config, store: Pick<Store, 'getMeta' | 'setMeta'>, key: string): void {
  base ??= { ...config };
  store.setMeta(META(key), '');
  put(config, key, effective(key, store));
  hook?.(key);
}

/** Stores every value the environment currently sets as a panel value, so those variables can be removed from the stack. Returns the names. */
export function adoptEnvironment(config: Config, store: Pick<Store, 'getMeta' | 'setMeta'>, env: NodeJS.ProcessEnv = process.env): string[] {
  base ??= { ...config };
  const adopted: string[] = [];
  for (const def of SETTINGS) {
    if (!env[def.key] || stored(store, def.key) !== undefined) continue;
    store.setMeta(META(def.key), `v:${show(base[def.key])}`);
    adopted.push(def.key);
  }
  return adopted;
}

/** Test hook. */
export function resetRuntimeConfig(): void {
  base = null;
  booted = {};
  hook = null;
}
