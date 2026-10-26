import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { UserError } from '../services/clan.js';
import { READ_ONLY, tool } from './util.js';

/**
 * Manage the self-hosted Ollama behind LOCAL_AI_URL (registered only when it is set): see what is installed and loaded,
 * pull a model, and time a test answer. Ollama's own API is the base URL without the trailing /v1.
 */

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

export const ollamaBase = (url: string): string => url.replace(/\/+$/, '').replace(/\/v1$/, '');

interface PullState {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

let pull: PullState | null = null;

type Fetcher = typeof fetch;

async function api<T>(base: string, path: string, fetcher: Fetcher, init?: RequestInit, timeoutMs = 10_000): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new UserError(`Ollama at ${base} is not reachable: ${err instanceof Error ? err.message : err}. Is the machine awake, Ollama running with OLLAMA_HOST=0.0.0.0, and the bot on the same network (Tailscale)?`);
  }
  if (!res.ok) throw new UserError(`Ollama answered HTTP ${res.status} for ${path}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

/** Starts the download in the background (pulls take minutes) and keeps its progress for ollama_status. */
function startPull(base: string, model: string, fetcher: Fetcher): void {
  const state: PullState = { model, status: 'starting', startedAt: Date.now() };
  pull = state;
  void (async () => {
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
  })();
}

export function registerOllamaTools(server: McpServer, ctx: AppContext, fetcher: Fetcher = fetch): void {
  const url = ctx.config.LOCAL_AI_URL;
  if (!url) return;
  const base = ollamaBase(url);

  server.registerTool(
    'ollama_status',
    {
      title: 'Ollama status',
      description: 'Shows whether the self-hosted Ollama is reachable, its version, the installed models, which are loaded in memory, the model the bot uses and any download in progress.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(async () => {
      const [version, tags, running] = await Promise.all([
        api<{ version: string }>(base, '/api/version', fetcher),
        api<{ models: { name: string; size: number; details?: { parameter_size?: string; quantization_level?: string } }[] }>(base, '/api/tags', fetcher),
        api<{ models: { name: string; size: number; expires_at?: string }[] }>(base, '/api/ps', fetcher),
      ]);
      const wanted = ctx.config.LOCAL_AI_MODEL ?? null;
      const installed = tags.models.map((m) => m.name);
      return {
        reachable: true,
        url: base,
        version: version.version,
        botModel: wanted,
        botModelInstalled: wanted ? installed.some((n) => n === wanted || n === `${wanted}:latest`) : null,
        installed: tags.models.map((m) => ({ name: m.name, size: gb(m.size), parameters: m.details?.parameter_size ?? null, quantization: m.details?.quantization_level ?? null })),
        loaded: running.models.map((m) => ({ name: m.name, memory: gb(m.size), unloadsAt: m.expires_at ?? null })),
        download: pull && {
          model: pull.model,
          status: pull.status,
          progress: pull.total ? `${Math.round(((pull.completed ?? 0) / pull.total) * 100)}% (${gb(pull.completed ?? 0)} of ${gb(pull.total)})` : null,
          error: pull.error ?? null,
          finished: pull.finishedAt ? new Date(pull.finishedAt).toISOString() : false,
        },
      };
    }),
  );

  server.registerTool(
    'ollama_pull',
    {
      title: 'Download an Ollama model',
      description: 'Starts downloading a model onto the Ollama host (e.g. the exact tag from ollama.com/library). It runs in the background; follow it with ollama_status. Only one download at a time.',
      inputSchema: { model: z.string().min(2).max(120).regex(/^[\w.\-:/]+$/, 'A model tag such as gemma3:27b').describe('Model tag') },
      annotations: WRITE,
    },
    tool(async ({ model }) => {
      if (pull && !pull.finishedAt) throw new UserError(`Already downloading ${pull.model}; check ollama_status.`);
      await api(base, '/api/version', fetcher);
      startPull(base, model, fetcher);
      return { started: model, next: 'Call ollama_status to follow the progress, then set LOCAL_AI_MODEL to this tag.' };
    }),
  );

  server.registerTool(
    'ollama_test',
    {
      title: 'Test the local model',
      description: 'Sends one short prompt to the model the bot uses through the same OpenAI-compatible endpoint and reports the answer and how long it took (the first call after idle also includes loading the model).',
      inputSchema: { prompt: z.string().min(1).max(500).default('Say hello in one short sentence.') },
      annotations: READ_ONLY,
    },
    tool(async ({ prompt }) => {
      const model = ctx.config.LOCAL_AI_MODEL;
      if (!model) throw new UserError('LOCAL_AI_MODEL is not set on the bot.');
      const t0 = Date.now();
      const data = await api<{ choices?: { message?: { content?: string } }[]; usage?: { completion_tokens?: number } }>(
        url.replace(/\/+$/, ''),
        '/chat/completions',
        fetcher,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.config.LOCAL_AI_KEY || 'ollama'}` }, body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }) },
        ctx.config.LOCAL_AI_TIMEOUT_SECONDS * 1000,
      );
      const ms = Date.now() - t0;
      const tokens = data.usage?.completion_tokens ?? null;
      return { model, seconds: Number((ms / 1000).toFixed(1)), tokensPerSecond: tokens ? Number((tokens / (ms / 1000)).toFixed(1)) : null, answer: data.choices?.[0]?.message?.content?.trim() ?? null };
    }),
  );
}
