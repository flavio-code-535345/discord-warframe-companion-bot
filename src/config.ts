import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

export const EnvSchema = z.object({
  DISCORD_TOKEN: z.string({ error: 'is required (bot token from the Discord Developer Portal)' }),
  DISCORD_GUILD_ID: z
    .string({ error: 'is required (ID of the clan Discord server)' })
    .regex(/^\d+$/, 'must be the numeric ID of the clan Discord server'),
  CLAN_NAME: z.string().default('The Rats Den 69'),
  BOT_NAME: z.string().min(2).max(32).default('Cephalon Ordis'),
  WARFRAME_PLATFORM: z.enum(['pc', 'ps4', 'xbox', 'switch', 'mobile']).default('pc'),
  DATA_DIR: z.string().default('./data'),
  /** Fetch the live world state (from warframestat.us) at all. Off by default; alerts, fissures and the world tiles are paused while it is off. */
  WORLDSTATE_ENABLED: bool.default(false),
  /** A warframestat.us-compatible world state endpoint to read instead of api.warframestat.us/<platform>, e.g. a self-hosted one. */
  WORLDSTATE_URL: z.string().url().optional(),
  /** Minimum seconds between calls to the worldstate feed (everything shares one cached copy). */
  /** Refresh when something in the world state is due to change instead of on a fixed timer (see nextRefreshDelay in warframe/worldstate.ts). */
  WORLDSTATE_SMART_POLL: bool.default(false),
  /** The longest the world state is left without a refresh when smart polling is on. */
  WORLDSTATE_MAX_POLL_MINUTES: z.coerce.number().int().min(5).max(720).default(30),
  WORLDSTATE_POLL_SECONDS: z.coerce.number().int().min(60).default(600),
  ENABLE_WELCOME: bool.default(false),
  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_AUTH_TOKEN: z.string().min(24, 'MCP_AUTH_TOKEN must be at least 24 characters').optional(),
  // AI chat (Ordis answering questions). Disabled when no API key is set.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_WEB_SEARCH: bool.default(true),
  AI_USER_HOURLY_LIMIT: z.coerce.number().int().min(1).default(20),
  AI_DAILY_LIMIT: z.coerce.number().int().min(1).default(300),
  /** Lets Ordis read every message in the /setup chat channel; needs the privileged Message Content intent. */
  /** Switch on the Server Members intent just for the audit log (joins and leaves). Also enable it in the Developer Portal. */
  ENABLE_MEMBER_LOGGING: bool.default(false),
  ENABLE_MESSAGE_CONTENT: bool.default(false),
  /** Keep a local searchable copy of the Warframe wiki so Ordis can answer most questions from it. */
  WIKI_INDEX: bool.default(true),
  /** Watchtower's HTTP API inside the stack, so an admin can trigger an update from the MCP without opening Portainer. */
  /** Optional free-tier LLM (any OpenAI-compatible API) that words wiki answers. Off without a key. */
  FREE_AI_KEY: z.string().min(8).optional(),
  FREE_AI_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  FREE_AI_MODEL: z.string().default('gemini-flash-latest'),
  FREE_AI_FALLBACK_MODEL: z.string().default('gemini-3.5-flash-lite'),
  FREE_AI_DAILY_LIMIT: z.coerce.number().int().min(1).default(150),
  /** Self-hosted Ollama (OpenAI-compatible, e.g. http://100.64.0.1:11434/v1), tried before the free cloud endpoint. */
  LOCAL_AI_URL: z.string().url().optional(),
  LOCAL_AI_MODEL: z.string().optional(),
  LOCAL_AI_KEY: z.string().optional(),
  LOCAL_AI_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(300).default(60),
  /** Lets the MCP patch the bot's compiled code live (overlay in the data volume). Remote code execution for whoever holds MCP_AUTH_TOKEN: off by default. */
  ALLOW_CODE_EDIT: bool.default(false),
  WATCHTOWER_URL: z.string().url().optional(),
  WATCHTOWER_TOKEN: z.string().min(8).optional(),
  // Web admin panel (/admin): Discord login, whitelisted admins only. Off until both are set.
  DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  PUBLIC_URL: z
    .string()
    .url()
    .optional()
    .transform((v) => v?.replace(/\/+$/, '')),
  /** Always-admins who can't be removed from the panel; others are added in the panel itself. */
  PANEL_OWNER_IDS: z
    .string()
    .default('603293720061935626')
    .transform((v) => v.split(',').map((s) => s.trim()).filter((s) => /^\d{15,22}$/.test(s))),
  /** Discord IDs of the two clan owners ("Legion" and "Tumba"): the only people Ordis takes free-form instructions from (answers/operator.ts). */
  OPERATOR_IDS: z
    .string()
    .default('220147375786688512,603293720061935626')
    .transform((v) => v.split(',').map((s) => s.trim()).filter((s) => /^\d{15,22}$/.test(s))),
  /** Daily refresh of the saved answers to frequently asked questions (answers/cache.ts): on/off, how many questions per run, and the UTC hour it runs. */
  ANSWER_REFRESH_ENABLED: bool.default(true),
  ANSWER_REFRESH_MAX: z.coerce.number().int().min(1).max(30).default(8),
  ANSWER_REFRESH_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(4),
  /** Third-party API etiquette (warframe/fetch.ts): the gap between requests to one host, a global cap, the pause after a 403, retries, and cache lifetimes. */
  API_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(10_000).default(500),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(5).max(600).default(60),
  API_COOLDOWN_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  API_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  API_PRICE_CACHE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  API_STABLE_CACHE_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Queues for the slow jobs (queue.ts): model answers and screenshot reads each run this many at a time, the rest wait in order. */
  QUEUE_QUESTIONS_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  QUEUE_SCREENSHOTS_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** How many may wait in each queue; beyond that people are asked to try again later. */
  QUEUE_MAX_WAITING: z.coerce.number().int().min(1).max(100).default(20),
  /** A self-hosted SearXNG (JSON format enabled), e.g. http://192.168.178.45:8888: adds fresh Warframe web results to answers. */
  SEARXNG_URL: z.string().url().optional(),
  MCP_ALLOWED_HOSTS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((h) => h.trim()).filter(Boolean) : undefined)),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (common in .env templates and compose files) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
