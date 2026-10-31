import { localAvailable } from './local.js';
import type { AppContext } from '../context.js';
import { UserError } from '../services/clan.js';
import {
  LOCAL_MODEL_META,
  type InstalledModel,
  type PullState,
  createVariant,
  currentPull,
  gb,
  listInstalled,
  localModelOf,
  ollamaApi,
  ollamaBase,
  pullProgress,
  pullRunning,
  setChosenModel,
  startPull,
  supportsThinking,
  validModelTag,
} from './ollama.js';
import { type AiToggle, TOGGLES, TOGGLE_KEYS, aiToggle, setAiToggle } from './settings.js';

/**
 * Everything staff can do to the AI setup, in one place. The /ai command, the admin panel's AI page and the MCP tools all
 * call these, so each surface does exactly the same thing and shows the same state.
 */

/** The value that clears the model choice, so LOCAL_AI_MODEL from the stack applies again. */
export const DEFAULT_MODEL_CHOICE = '-';

export interface AiOverview {
  /** LOCAL_AI_URL is set. */
  configured: boolean;
  reachable: boolean;
  error: string | null;
  version: string | null;
  /** The model in use, and whether it was chosen at runtime (rather than LOCAL_AI_MODEL). */
  model: string | null;
  chosen: boolean;
  defaultModel: string | null;
  skippedAfterFailure: boolean;
  thinkingCapable: boolean | null;
  installed: InstalledModel[];
  loaded: { name: string; size: number }[];
  download: (PullState & { progress: string | null }) | null;
  toggles: { key: AiToggle; label: string; help: string; on: boolean }[];
  webSearch: { configured: boolean; host: string | null };
}

export function requireBase(ctx: AppContext): string {
  if (!ctx.config.LOCAL_AI_URL) throw new UserError("No local AI server is set up: add LOCAL_AI_URL to the bot's settings first.");
  return ollamaBase(ctx.config.LOCAL_AI_URL);
}

export async function aiOverview(ctx: AppContext, fetcher: typeof fetch = fetch): Promise<AiOverview> {
  const { config } = ctx;
  const toggles = TOGGLE_KEYS.map((key) => ({ key, label: TOGGLES[key].label, help: TOGGLES[key].help, on: aiToggle(key) }));
  const pull = currentPull();
  const base: AiOverview = {
    configured: Boolean(config.LOCAL_AI_URL),
    reachable: false,
    error: null,
    version: null,
    model: localModelOf(config) ?? null,
    chosen: Boolean(localModelOf(config) && localModelOf(config) !== config.LOCAL_AI_MODEL),
    defaultModel: config.LOCAL_AI_MODEL ?? null,
    skippedAfterFailure: !localAvailable(),
    thinkingCapable: null,
    installed: [],
    loaded: [],
    download: pull && { ...pull, progress: pullProgress(pull) },
    toggles,
    webSearch: { configured: Boolean(config.SEARXNG_URL), host: config.SEARXNG_URL ? new URL(config.SEARXNG_URL).host : null },
  };
  if (!config.LOCAL_AI_URL) return base;
  const url = ollamaBase(config.LOCAL_AI_URL);
  try {
    const [version, installed, running] = await Promise.all([
      ollamaApi<{ version: string }>(url, '/api/version', fetcher),
      listInstalled(url, fetcher),
      ollamaApi<{ models: { name: string; size: number }[] }>(url, '/api/ps', fetcher),
    ]);
    base.reachable = true;
    base.version = version.version;
    base.installed = installed;
    base.loaded = running.models.map((m) => ({ name: m.name, size: m.size }));
    if (base.model) base.thinkingCapable = await supportsThinking(url, base.model, fetcher);
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
  }
  return base;
}

/** Chooses an installed model (or "-" for the stack's default). Returns a message for the user. */
export async function chooseModel(ctx: AppContext, name: string, fetcher: typeof fetch = fetch): Promise<string> {
  const base = requireBase(ctx);
  const wanted = name.trim();
  if (wanted === DEFAULT_MODEL_CHOICE || wanted === '') {
    setChosenModel(null);
    ctx.store.setMeta(LOCAL_MODEL_META, '');
    return `Back to the bot's own setting: ${ctx.config.LOCAL_AI_MODEL ?? 'none'}.`;
  }
  const installed = await listInstalled(base, fetcher);
  const match = installed.find((m) => m.name === wanted || m.name === `${wanted}:latest`);
  if (!match) throw new UserError(`"${wanted}" is not installed on the AI server. Installed: ${installed.map((m) => m.name).join(', ') || 'nothing'}. Install it first (/ai install), or make a copy of the current model with a CPU setting (/ai tune).`);
  setChosenModel(match.name);
  ctx.store.setMeta(LOCAL_MODEL_META, match.name);
  return `Ordis now answers with ${match.name} (${gb(match.size)}${match.parameters ? `, ${match.parameters}` : ''}). The first answer after a switch is slower while it loads into memory.`;
}

export interface TuneOptions {
  /** CPU threads for generating tokens: the number of performance cores is a good start (6 on an i9-13900HK). */
  threads: number;
  /** Context window in tokens (the bot's prompts fit in 4096). */
  context?: number | undefined;
  /** Name of the new model; default `ordis-t<threads>`. */
  name?: string | undefined;
  /** The installed model to copy the weights from; default the model in use. */
  from?: string | undefined;
  /** Switch the bot to the new model right away. */
  use?: boolean | undefined;
}

/**
 * Creates a copy of an installed model with a fixed CPU thread count and context size (see `createVariant`), so the setting
 * can be tried without shell access to the AI server. Returns a message for the user.
 */
export async function tuneModel(ctx: AppContext, opts: TuneOptions, fetcher: typeof fetch = fetch): Promise<string> {
  const base = requireBase(ctx);
  const threads = Math.trunc(opts.threads);
  const context = Math.trunc(opts.context ?? 4096);
  if (!(threads >= 1 && threads <= 64)) throw new UserError('Threads must be between 1 and 64.');
  if (!(context >= 512 && context <= 131_072)) throw new UserError('Context must be between 512 and 131072 tokens.');
  const name = (opts.name?.trim() || `ordis-t${threads}`).toLowerCase();
  if (!validModelTag(name)) throw new UserError('That is not a usable model name. Use letters, digits, dashes, e.g. ordis-t6.');
  const from = opts.from?.trim() || localModelOf(ctx.config);
  if (!from) throw new UserError('No model is chosen and LOCAL_AI_MODEL is not set: say which installed model to copy.');
  const installed = await listInstalled(base, fetcher);
  const source = installed.find((m) => m.name === from || m.name === `${from}:latest`);
  if (!source) throw new UserError(`"${from}" is not installed on the AI server. Installed: ${installed.map((m) => m.name).join(', ') || 'nothing'}.`);
  await createVariant(base, { from: source.name, name, threads, context }, fetcher);
  const made = `Created ${name} from ${source.name} with ${threads} threads and a ${context}-token context.`;
  if (opts.use) return `${made} ${await chooseModel(ctx, name, fetcher)}`;
  return `${made} Switch to it with /ai model name:${name}, then test the speed.`;
}

/** Starts a background download. `onDone` runs when it has finished or failed. */
export async function installModel(ctx: AppContext, tag: string, onDone?: (state: PullState) => void, fetcher: typeof fetch = fetch): Promise<string> {
  const base = requireBase(ctx);
  const wanted = tag.trim();
  if (!validModelTag(wanted)) throw new UserError('That is not a model tag. Use something like gemma3:27b or hf.co/user/repo:Q4_K_M.');
  const running = currentPull();
  if (pullRunning() && running) throw new UserError(`Already downloading ${running.model} (${pullProgress(running) ?? running.status}). Wait for it to finish.`);
  await ollamaApi(base, '/api/version', fetcher); // fail now, with a clear message, if the server is unreachable
  void startPull(base, wanted, fetcher, onDone);
  return `Downloading ${wanted} in the background. The AI page and /ai status show the progress.`;
}

/** Flips one switch. Returns a message, with a warning when the switch can't do anything right now. */
export async function setToggle(ctx: AppContext, feature: AiToggle, on: boolean, fetcher: typeof fetch = fetch): Promise<string> {
  setAiToggle(ctx.store, feature, on);
  let note = '';
  if (feature === 'thinking' && on && ctx.config.LOCAL_AI_URL) {
    const model = localModelOf(ctx.config);
    if (model && !(await supportsThinking(ollamaBase(ctx.config.LOCAL_AI_URL), model, fetcher))) {
      note = ` Note: ${model} does not support thinking, so this has no effect until you choose a model that does.`;
    }
  }
  if (feature === 'websearch' && on && !ctx.config.SEARXNG_URL) note = ' Note: SEARXNG_URL is not set on the bot, so there is nothing to search yet.';
  if (feature === 'local' && on && !ctx.config.LOCAL_AI_URL) note = ' Note: LOCAL_AI_URL is not set on the bot.';
  return `${TOGGLES[feature].label} is now ${on ? 'on' : 'off'}.${note}`;
}

/** One short question to the model in use, with the same settings the bot answers with. */
export async function testModel(ctx: AppContext, prompt = 'Say hello in one short sentence.', fetcher: typeof fetch = fetch): Promise<{ model: string; seconds: number; tokensPerSecond: number | null; answer: string | null; thinking: boolean }> {
  const base = requireBase(ctx);
  const model = localModelOf(ctx.config);
  if (!model) throw new UserError('No model is chosen and LOCAL_AI_MODEL is not set.');
  const thinking = aiToggle('thinking') && (await supportsThinking(base, model, fetcher));
  const t0 = Date.now();
  const data = await ollamaApi<{ choices?: { message?: { content?: string } }[]; usage?: { completion_tokens?: number } }>(
    ctx.config.LOCAL_AI_URL!.replace(/\/+$/, ''),
    '/chat/completions',
    fetcher,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.config.LOCAL_AI_KEY || 'ollama'}` },
      body: JSON.stringify({ model, max_tokens: thinking ? 1500 : 300, reasoning_effort: thinking ? 'low' : 'none', messages: [{ role: 'user', content: prompt }] }),
    },
    ctx.config.LOCAL_AI_TIMEOUT_SECONDS * 1000,
  );
  const ms = Date.now() - t0;
  const tokens = data.usage?.completion_tokens ?? null;
  return { model, seconds: Number((ms / 1000).toFixed(1)), tokensPerSecond: tokens ? Number((tokens / (ms / 1000)).toFixed(1)) : null, answer: data.choices?.[0]?.message?.content?.trim() ?? null, thinking };
}
