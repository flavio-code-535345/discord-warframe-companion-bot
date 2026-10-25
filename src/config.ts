import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  DISCORD_TOKEN: z.string({ error: 'is required (bot token from the Discord Developer Portal)' }),
  DISCORD_GUILD_ID: z
    .string({ error: 'is required (ID of the clan Discord server)' })
    .regex(/^\d+$/, 'must be the numeric ID of the clan Discord server'),
  CLAN_NAME: z.string().default('The Rats Den 69'),
  BOT_NAME: z.string().min(2).max(32).default('Cephalon Ordis'),
  WARFRAME_PLATFORM: z.enum(['pc', 'ps4', 'xbox', 'switch', 'mobile']).default('pc'),
  DATA_DIR: z.string().default('./data'),
  WORLDSTATE_POLL_SECONDS: z.coerce.number().int().min(30).default(60),
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
  ENABLE_MESSAGE_CONTENT: bool.default(false),
  /** Keep a local searchable copy of the Warframe wiki so Ordis can answer most questions from it. */
  WIKI_INDEX: bool.default(true),
  /** Watchtower's HTTP API inside the stack, so an admin can trigger an update from the MCP without opening Portainer. */
  /** Optional free-tier LLM (any OpenAI-compatible API) that words wiki answers. Off without a key. */
  FREE_AI_KEY: z.string().min(8).optional(),
  FREE_AI_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  FREE_AI_MODEL: z.string().default('gemini-3.8-flash'),
  FREE_AI_DAILY_LIMIT: z.coerce.number().int().min(1).default(150),
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
