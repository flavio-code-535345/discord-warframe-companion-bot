import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { installModel, testModel, tuneModel } from '../ai/control.js';
import { currentPull, gb, listInstalled, localModelOf, ollamaApi, ollamaBase, pullProgress, validModelTag } from '../ai/ollama.js';
import type { AppContext } from '../context.js';
import { READ_ONLY, tool } from './util.js';

/**
 * Manage the self-hosted Ollama behind LOCAL_AI_URL (registered only when it is set): see what is installed and loaded,
 * pull a model, and time a test answer. Ollama's own API is the base URL without the trailing /v1. Staff can do the same
 * from Discord with /ai.
 */

export { ollamaBase };

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

type Fetcher = typeof fetch;

export function registerOllamaTools(server: McpServer, ctx: AppContext, fetcher: Fetcher = fetch): void {
  const url = ctx.config.LOCAL_AI_URL;
  if (!url) return;
  const base = ollamaBase(url);

  server.registerTool(
    'ollama_status',
    {
      title: 'Ollama status',
      description: 'Shows whether the self-hosted Ollama is reachable, its version, the installed models, which are loaded in memory, the model the bot uses (the one chosen with /ai model, else LOCAL_AI_MODEL) and any download in progress.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(async () => {
      const [version, installed, running] = await Promise.all([
        ollamaApi<{ version: string }>(base, '/api/version', fetcher),
        listInstalled(base, fetcher),
        ollamaApi<{ models: { name: string; size: number; expires_at?: string }[] }>(base, '/api/ps', fetcher),
      ]);
      const wanted = localModelOf(ctx.config) ?? null;
      const pull = currentPull();
      return {
        reachable: true,
        url: base,
        version: version.version,
        botModel: wanted,
        botModelInstalled: wanted ? installed.some((m) => m.name === wanted || m.name === `${wanted}:latest`) : null,
        installed: installed.map((m) => ({ name: m.name, size: gb(m.size), parameters: m.parameters, quantization: m.quantization })),
        loaded: running.models.map((m) => ({ name: m.name, memory: gb(m.size), unloadsAt: m.expires_at ?? null })),
        download: pull && {
          model: pull.model,
          status: pull.status,
          progress: pullProgress(pull),
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
      description: 'Starts downloading a model onto the Ollama host (e.g. the exact tag from ollama.com/library, or hf.co/user/repo:quant). It runs in the background; follow it with ollama_status. Only one download at a time.',
      inputSchema: { model: z.string().min(2).max(120).refine(validModelTag, 'A model tag such as gemma3:27b').describe('Model tag') },
      annotations: WRITE,
    },
    tool(async ({ model }) => {
      await installModel(ctx, model, undefined, fetcher);
      return { started: model, next: 'Call ollama_status to follow the progress, then choose it with /ai model in Discord.' };
    }),
  );

  server.registerTool(
    'ollama_tune',
    {
      title: 'Create a CPU-tuned copy of a model',
      description:
        'Creates a copy of an installed Ollama model with a fixed CPU thread count (num_thread) and context size (num_ctx): same weights, nothing is downloaded. Use it to try thread counts (e.g. 6 for the performance cores of an i9-13900HK), switch to a copy with choose_ai_model, and time it with ollama_test. Names default to ordis-t<threads>.',
      inputSchema: {
        threads: z.number().int().min(1).max(64).describe('CPU threads that generate tokens'),
        context: z.number().int().min(512).max(131072).default(4096).describe('Context window in tokens'),
        name: z.string().min(2).max(60).refine(validModelTag, 'A model name such as ordis-t6').optional().describe('Name of the copy (default ordis-t<threads>)'),
        from: z.string().min(2).max(120).refine(validModelTag, 'An installed model tag').optional().describe('Installed model to copy (default: the model in use)'),
      },
      annotations: WRITE,
    },
    tool(async ({ threads, context, name, from }) => ({ message: await tuneModel(ctx, { threads, context, name, from }, fetcher) })),
  );

  server.registerTool(
    'ollama_test',
    {
      title: 'Test the local model',
      description: 'Sends one short prompt to the model the bot uses through the same OpenAI-compatible endpoint and reports the answer and how long it took (the first call after idle also includes loading the model).',
      inputSchema: { prompt: z.string().min(1).max(500).default('Say hello in one short sentence.') },
      annotations: READ_ONLY,
    },
    tool(async ({ prompt }) => testModel(ctx, prompt, fetcher)),
  );
}
