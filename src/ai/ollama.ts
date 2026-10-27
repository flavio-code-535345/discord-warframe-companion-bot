import { UserError } from '../services/clan.js';

/**
 * Talking to the self-hosted Ollama behind LOCAL_AI_URL: its native API (the URL without the trailing /v1), a background
 * model download with progress, and the validation of model tags. Shared by the MCP tools and the /ai command.
 */

type Fetcher = typeof fetch;

export const ollamaBase = (url: string): string => url.replace(/\/+$/, '').replace(/\/v1$/, '');

/** A model tag such as gemma3:27b or hf.co/user/repo:Q4_K_M. */
export const MODEL_TAG = /^[\w.\-:/]{2,120}$/;
export const validModelTag = (tag: string): boolean => MODEL_TAG.test(tag) && !tag.includes('..');

/**
 * The model chosen with /ai model, which wins over LOCAL_AI_MODEL so it can be changed without redeploying. It is kept in
 * bot_meta and loaded at startup.
 */
export const LOCAL_MODEL_META = 'local_ai_model';
let chosenModel: string | null = null;

export const setChosenModel = (model: string | null): void => {
  chosenModel = model?.trim() || null;
};

/** The model the bot asks Ollama for: the one chosen with /ai model, else LOCAL_AI_MODEL. */
export const localModelOf = (config: { LOCAL_AI_MODEL?: string | undefined }): string | undefined => chosenModel ?? config.LOCAL_AI_MODEL;

export const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

export async function ollamaApi<T>(base: string, path: string, fetcher: Fetcher = fetch, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UserError(`Ollama at ${base} is not reachable: ${err instanceof Error ? err.message : err}. Is the machine awake, Ollama running with OLLAMA_HOST=0.0.0.0, and the bot on the same network?`);
  }
  if (!res.ok) throw new UserError(`Ollama answered HTTP ${res.status} for ${path}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

const capabilityCache = new Map<string, { at: number; capabilities: string[] }>();
const CAPABILITY_TTL_MS = 10 * 60_000;

/** What Ollama says a model can do ("completion", "vision", "tools", "thinking"...). Cached; [] when unknown. */
export async function modelCapabilities(base: string, model: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<string[]> {
  const hit = capabilityCache.get(model);
  if (hit && now - hit.at < CAPABILITY_TTL_MS) return hit.capabilities;
  try {
    const info = await ollamaApi<{ capabilities?: string[] }>(base, '/api/show', fetcher, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }, 8_000);
    const capabilities = info.capabilities ?? [];
    capabilityCache.set(model, { at: now, capabilities });
    return capabilities;
  } catch {
    return [];
  }
}

export const supportsThinking = async (base: string, model: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<boolean> =>
  (await modelCapabilities(base, model, fetcher, now)).includes('thinking');

/** Test hook. */
export const resetCapabilities = (): void => capabilityCache.clear();

export interface InstalledModel {
  name: string;
  size: number;
  parameters: string | null;
  quantization: string | null;
}

export async function listInstalled(base: string, fetcher: Fetcher = fetch): Promise<InstalledModel[]> {
  const tags = await ollamaApi<{ models: { name: string; size: number; details?: { parameter_size?: string; quantization_level?: string } }[] }>(base, '/api/tags', fetcher);
  return tags.models.map((m) => ({ name: m.name, size: m.size, parameters: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null }));
}

/**
 * Creates a variant of an installed model with other run parameters (the same weights, nothing is downloaded: it is a few
 * hundred bytes of settings on top). This is the API behind `ollama create` with a Modelfile of `FROM` plus `PARAMETER` lines.
 * `num_thread` is how many CPU threads generate tokens, `num_ctx` the context window.
 */
export async function createVariant(
  base: string,
  opts: { from: string; name: string; threads: number; context: number },
  fetcher: Fetcher = fetch,
): Promise<void> {
  const res = await ollamaApi<{ status?: string; error?: string }>(
    base,
    '/api/create',
    fetcher,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.name, from: opts.from, parameters: { num_thread: opts.threads, num_ctx: opts.context }, stream: false }),
    },
    60_000,
  );
  if (res.error) throw new UserError(`Ollama could not create ${opts.name}: ${res.error}`);
}

export interface PullState {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

let pull: PullState | null = null;

export const currentPull = (): PullState | null => pull;
export const pullRunning = (): boolean => pull !== null && !pull.finishedAt;

/** Test hook. */
export const resetPull = (): void => {
  pull = null;
};

export const pullProgress = (p: PullState): string | null => (p.total ? `${Math.round(((p.completed ?? 0) / p.total) * 100)}% (${gb(p.completed ?? 0)} of ${gb(p.total)})` : null);

/**
 * Starts the download in the background (pulls take minutes) and keeps its progress. Resolves when it has finished, which
 * callers may ignore. `onDone` runs with the final state either way.
 */
export function startPull(base: string, model: string, fetcher: Fetcher = fetch, onDone?: (state: PullState) => void): Promise<PullState> {
  const state: PullState = { model, status: 'starting', startedAt: Date.now() };
  pull = state;
  return (async () => {
    try {
      const res = await fetcher(`${base}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (msg.error) throw new Error(msg.error);
          state.status = msg.status ?? state.status;
          if (msg.total) {
            state.completed = msg.completed ?? 0;
            state.total = msg.total;
          }
        }
      }
      state.status = 'success';
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      state.status = 'failed';
    }
    state.finishedAt = Date.now();
    try {
      onDone?.(state);
    } catch {
      // A failing notification must not hide the result.
    }
    return state;
  })();
}
