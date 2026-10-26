import { localModelOf, modelCapabilities, ollamaBase } from '../ai/ollama.js';
import { aiToggle } from '../ai/settings.js';
import { LOCAL_COOLDOWN_MS, allow, localAvailable, markLocalDown } from '../answers/compose.js';
import type { AppContext } from '../context.js';
import { OPERATOR_NOTE, brain, buildSystemPrompt } from './brain.js';
import { type AgentTool, enabledTools, runTool } from './tools.js';
import { type AgentRun, newRun } from './traces.js';

/**
 * The agent loop. The model gets the system prompt (the editable one from the Brain page, plus the persona level), the
 * question and the enabled tools, and decides for itself which to call, how often, and when to stop. Each tool result goes
 * back to it until it writes the answer or runs out of steps (the last step has no tools, so it must answer).
 *
 * Two ways to call tools: the model's own function calling (OpenAI-style `tools`, supported by Ollama for models that
 * report the `tools` capability and by Gemini), or, for models without it, tool calls written as `<tool_call>` text that
 * this loop parses. The local model (Ollama) goes first, then the free cloud model, like every other answer.
 */

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface ParsedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  raw: unknown;
}

interface Endpoint {
  local: boolean;
  url: string;
  key: string;
  model: string;
  timeoutMs: number;
  thinking: boolean;
  mode: 'native' | 'text';
}

export interface AgentDeps {
  fetcher?: Fetcher;
  now?: number;
  /** Replaces the real tool set (tests). */
  tools?: AgentTool[];
  /** Fill in this run instead of creating one (the panel starts it first, so it can show it live). */
  run?: AgentRun;
}

const MAX_CALLS_PER_STEP = 4;
const TOTAL_BUDGET_MS = 4 * 60_000;

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

/** The tool catalogue for models without native function calling. */
function textProtocol(tools: AgentTool[]): string {
  const sig = (t: AgentTool) => {
    const req = new Set(t.parameters.required ?? []);
    return Object.keys(t.parameters.properties)
      .map((k) => `${k}${req.has(k) ? '' : '?'}`)
      .join(', ');
  };
  return [
    'You can use tools. To use one, reply with ONLY one or more blocks of this form and nothing else:',
    '<tool_call>{"name": "search_wiki", "arguments": {"query": "archon shards"}}</tool_call>',
    'The results come back in <tool_result> blocks. Then continue: call another tool, or, when you have what you need, write the final answer with no tool_call block.',
    'Tools:',
    ...tools.map((t) => `- ${t.name}(${sig(t)}): ${t.description}`),
  ].join('\n');
}

const asArgs = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') {
    try {
      return asArgs(JSON.parse(v));
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

function parseTextCalls(content: string): ParsedCall[] {
  const out: ParsedCall[] = [];
  const blocks = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1]!);
  // A bare JSON object that names a tool counts too: small models often drop the tags.
  if (!blocks.length && /^\s*\{[\s\S]*"name"[\s\S]*\}\s*$/.test(content)) blocks.push(content);
  for (const b of blocks) {
    try {
      const j = JSON.parse(b.replace(/^```(?:json)?|```$/g, '').trim()) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof j.name === 'string') out.push({ id: `text_${out.length}`, name: j.name, args: asArgs(j.arguments ?? j.parameters), raw: null });
    } catch {
      // Not valid JSON: ignore this block.
    }
  }
  return out;
}

interface ModelReply {
  content: string;
  reasoning: string;
  calls: ParsedCall[];
}

async function callModel(ep: Endpoint, messages: Msg[], tools: AgentTool[], offerTools: boolean, fetcher: Fetcher, timeoutMs: number): Promise<ModelReply> {
  const s = brain();
  const native = ep.mode === 'native' && offerTools && tools.length > 0;
  const body: Record<string, unknown> = {
    model: ep.model,
    temperature: s.temperature,
    top_p: s.topP,
    // A thinking model spends part of the budget reasoning first.
    max_tokens: s.maxTokens + (ep.thinking ? 2000 : 0),
    messages,
    ...(ep.local ? { reasoning_effort: ep.thinking ? 'low' : 'none' } : /gpt-oss|gemini/.test(ep.model) ? { reasoning_effort: 'low' } : {}),
    ...(native ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' } : {}),
  };
  const res = await fetcher(`${ep.url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5_000, timeoutMs)),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string | null; reasoning?: string; reasoning_content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] } }[] };
  const msg = data.choices?.[0]?.message;
  const content = stripThink(msg?.content ?? '');
  const calls: ParsedCall[] = native
    ? (msg?.tool_calls ?? []).flatMap((c, i): ParsedCall[] => (c.function?.name ? [{ id: c.id || `call_${i}`, name: c.function.name, args: asArgs(c.function.arguments), raw: c }] : []))
    : ep.mode === 'text' && tools.length && offerTools
      ? parseTextCalls(content)
      : [];
  return { content, reasoning: (msg?.reasoning ?? msg?.reasoning_content ?? '').trim(), calls };
}

async function loop(ctx: AppContext, ep: Endpoint, run: AgentRun, system: string, user: string, tools: AgentTool[], fetcher: Fetcher, deadline: number): Promise<string | null> {
  const s = brain();
  const messages: Msg[] = [
    { role: 'system', content: ep.mode === 'text' && tools.length ? `${system}\n\n${textProtocol(tools)}` : system },
    { role: 'user', content: user },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const done = new Map<string, string>();
  for (let n = 1; n <= s.maxSteps; n++) {
    const last = n === s.maxSteps;
    if (last && n > 1) messages.push({ role: 'user', content: 'You have no tool calls left. Answer now with what you have, and say what you could not confirm.' });
    const t0 = Date.now();
    const reply = await callModel(ep, messages, tools, !last, fetcher, Math.min(ep.timeoutMs, deadline - Date.now()));
    const step = { n: run.steps.length + 1, endpoint: ep.local ? ('local' as const) : ('cloud' as const), model: ep.model, ms: Date.now() - t0, reasoning: reply.reasoning, content: reply.content, calls: [] as AgentRun['steps'][number]['calls'] };
    run.steps.push(step);

    if (reply.calls.length && !last) {
      const calls = reply.calls.slice(0, MAX_CALLS_PER_STEP);
      messages.push(
        ep.mode === 'native'
          ? { role: 'assistant', content: reply.content, tool_calls: calls.map((c) => c.raw) }
          : { role: 'assistant', content: reply.content },
      );
      for (const call of calls) {
        const key = `${call.name}:${JSON.stringify(call.args)}`;
        const trace = { name: call.name, args: call.args, result: '', ms: 0, error: false };
        step.calls.push(trace);
        const tool = byName.get(call.name);
        const t1 = Date.now();
        const out = done.has(key)
          ? { text: done.get(key)!, error: false }
          : tool
            ? await runTool(tool, call.args, ctx, s.toolResultChars)
            : { text: JSON.stringify({ error: `There is no tool called "${call.name}". Tools: ${tools.map((t) => t.name).join(', ')}.` }), error: true };
        if (!out.error) done.set(key, out.text);
        trace.result = out.text;
        trace.error = out.error;
        trace.ms = Date.now() - t1;
        messages.push(ep.mode === 'native' ? { role: 'tool', tool_call_id: call.id, content: out.text } : { role: 'user', content: `<tool_result name="${call.name}">${out.text}</tool_result>` });
      }
      continue;
    }

    if (reply.content) return reply.content;
    if (last) return null;
    // Neither a tool call nor an answer: push it once more.
    messages.push({ role: 'user', content: 'Reply with your answer, or call a tool.' });
  }
  return null;
}

/** Runs the agent on one question. Always returns the run (status done with text, or failed with the reason); never throws. */
export async function runAgent(ctx: AppContext, question: string, who: { id: string; name: string; operator: boolean }, deps: AgentDeps = {}): Promise<AgentRun> {
  const { config } = ctx;
  const fetcher = deps.fetcher ?? ((url: string, init: RequestInit) => fetch(url, init));
  const now = deps.now ?? Date.now();
  const s = brain();
  const tools = enabledTools(ctx, deps.tools);
  const system = [buildSystemPrompt({ bot: config.BOT_NAME, clan: config.CLAN_NAME }), who.operator ? OPERATOR_NOTE : ''].filter(Boolean).join('\n\n');
  const run = deps.run ?? newRun({ who: who.name, operator: who.operator, question, system });
  run.system = system;
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  const user = `[${new Date(now).toISOString().slice(0, 16)} UTC · ${who.name}]\n${question}`;
  const errors: string[] = [];

  const endpoints: Endpoint[] = [];
  const localModel = localModelOf(config);
  if (config.LOCAL_AI_URL && localModel && aiToggle('local') && localAvailable(now)) {
    const caps = await modelCapabilities(ollamaBase(config.LOCAL_AI_URL), localModel, fetcher as typeof fetch, now);
    endpoints.push({
      local: true,
      url: config.LOCAL_AI_URL,
      key: config.LOCAL_AI_KEY || 'ollama',
      model: localModel,
      timeoutMs: (config.LOCAL_AI_TIMEOUT_SECONDS ?? 60) * 1000,
      thinking: aiToggle('thinking') && caps.includes('thinking'),
      mode: s.toolMode === 'auto' ? (caps.includes('tools') ? 'native' : 'text') : s.toolMode,
    });
  }
  if (config.FREE_AI_KEY) {
    endpoints.push({ local: false, url: config.FREE_AI_URL, key: config.FREE_AI_KEY, model: config.FREE_AI_MODEL, timeoutMs: 30_000, thinking: false, mode: s.toolMode === 'text' ? 'text' : 'native' });
  }
  if (!endpoints.length) errors.push('No model is available: the local model is off or down and no cloud key is set.');

  for (const ep of endpoints) {
    if (!ep.local && !allow(config.FREE_AI_DAILY_LIMIT, now)) {
      errors.push('The free cloud allowance for today is used up.');
      continue;
    }
    let attempt = ep;
    for (let tries = 0; tries < 2; tries++) {
      try {
        run.mode = attempt.mode;
        const text = await loop(ctx, attempt, run, system, user, tools, fetcher, deadline);
        if (text) {
          run.text = text.length > s.maxChars ? `${text.slice(0, s.maxChars - 1)}…` : text;
          run.via = ep.local ? 'local' : 'cloud';
          run.model = ep.model;
          run.status = 'done';
          run.ms = Date.now() - started;
          return run;
        }
        errors.push(`${ep.model} gave no answer.`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A model that rejects the `tools` field gets one more go with tool calls written as text.
        if (attempt.mode === 'native' && /support[s]? tools|tool/i.test(msg) && /HTTP 400/.test(msg) && tools.length) {
          attempt = { ...attempt, mode: 'text' };
          continue;
        }
        errors.push(`${ep.model}: ${msg}`);
        console.warn(`[agent] ${ep.local ? 'local' : 'cloud'} model failed: ${msg}`);
        if (ep.local) {
          markLocalDown(now);
          console.warn(`[agent] local AI skipped for ${LOCAL_COOLDOWN_MS / 60_000} min`);
        }
        break;
      }
    }
  }
  run.status = 'failed';
  run.error = errors.join(' · ') || 'No answer.';
  run.ms = Date.now() - started;
  return run;
}
