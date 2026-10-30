import { localModelOf, modelCapabilities, ollamaBase } from '../ai/ollama.js';
import { aiToggle } from '../ai/settings.js';
import { LOCAL_COOLDOWN_MS, allow, localAvailable, markLocalDown } from '../answers/compose.js';
import type { AppContext } from '../context.js';
import { OPERATOR_NOTE, brain, buildSystemPrompt } from './brain.js';
import { wikiPrefetch } from './prefetch.js';
import { type AgentTool, enabledTools, runTool } from './tools.js';
import { type AgentRun, type StepTrace, newRun } from './traces.js';

/**
 * The agent loop. The model gets the system prompt (the editable one from the Brain page, plus the persona level), the
 * question and the enabled tools, and decides for itself which to call, how often, and when to stop. Each tool result goes
 * back to it until it writes the answer or runs out of steps (the last step has no tools, so it must answer).
 *
 * Two ways to call tools: the model's own function calling (OpenAI-style `tools`, supported by Ollama for models that
 * report the `tools` capability and by Gemini), or, for models without it, tool calls written as `<tool_call>` text that
 * this loop parses. The local model (Ollama) goes first, then the free cloud model, like every other answer.
 *
 * With `onEvent` every step and tool call is reported as it happens, and with `stream` the model's reply is streamed too and
 * every token and speed reading is reported (the Brain page's live chat). Discord answers use plain requests per step.
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

/** Everything the live view needs, one JSON object per line on the wire. */
export type AgentEvent =
  | { t: 'start'; id: string }
  | { t: 'step'; n: number; endpoint: 'local' | 'cloud'; model: string; mode: 'native' | 'text' }
  | { t: 'reasoning' | 'content'; d: string }
  | { t: 'stats'; n: number; tokens: number; tps: number; ttft: number }
  | { t: 'tool'; n: number; name: string; args: unknown }
  | { t: 'toolresult'; n: number; name: string; ms: number; error: boolean; result: string }
  | { t: 'stepend'; n: number; ms: number; tokens: number; tps: number; ttft: number; promptTokens: number | null }
  | { t: 'reset'; why: string }
  | { t: 'done'; text: string; via: 'local' | 'cloud'; model: string; ms: number; tokens: number; tps: number }
  | { t: 'error'; message: string };

export interface AgentDeps {
  fetcher?: Fetcher;
  now?: number;
  /** Replaces the real tool set (tests). */
  tools?: AgentTool[];
  /** Fill in this run instead of creating one (the panel starts it first, so it can show it live). */
  run?: AgentRun;
  /** Live events (steps, tool calls). */
  onEvent?: (e: AgentEvent) => void;
  /** Stream the model's reply token by token (the Brain page's live chat). Defaults to on when `onEvent` is set; Discord answers pass false. */
  stream?: boolean;
  /** Stops the run (the browser's Stop button or a closed connection). */
  signal?: AbortSignal;
  /** Earlier turns of a conversation (the panel's chat, or the asker's remembered messages in Discord), oldest first. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** Staff corrections and rated answers for this question (see answers/corrections.ts), added to the system prompt. */
  guidance?: string;
}

const MAX_CALLS_PER_STEP = 4;
const TOTAL_BUDGET_MS = 4 * 60_000;
const STATS_EVERY_MS = 250;

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

export function parseTextCalls(content: string): ParsedCall[] {
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
  tokens: number;
  promptTokens: number | null;
  ttft: number;
  tps: number;
}

interface Live {
  emit: (e: AgentEvent) => void;
  signal?: AbortSignal | undefined;
  stream: boolean;
  step: number;
}

interface RawToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: unknown };
}
interface Chunk {
  choices?: { message?: Message; delta?: Message }[];
  usage?: { completion_tokens?: number; prompt_tokens?: number };
}
interface Message {
  content?: string | null;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: RawToolCall[];
}

/** Reads an OpenAI-style event stream (`data: {json}` lines), reporting each piece of text as it arrives. */
export async function readStream(res: Response, onText: (kind: 'content' | 'reasoning' | 'call', d: string) => void, signal?: AbortSignal): Promise<{ content: string; reasoning: string; calls: Map<number, { id: string; name: string; args: string }>; usage: Chunk['usage'] }> {
  if (!res.body) throw new Error('the server sent no body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage: Chunk['usage'];
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(payload) as Chunk;
    } catch {
      return;
    }
    if (chunk.usage) usage = chunk.usage;
    const d = chunk.choices?.[0]?.delta ?? chunk.choices?.[0]?.message;
    if (!d) return;
    if (d.content) {
      content += d.content;
      onText('content', d.content);
    }
    const r = d.reasoning ?? d.reasoning_content;
    if (r) {
      reasoning += r;
      onText('reasoning', r);
    }
    (d.tool_calls ?? []).forEach((tc, i) => {
      const idx = tc.index ?? i;
      const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      const a = tc.function?.arguments;
      if (a !== undefined) cur.args += typeof a === 'string' ? a : JSON.stringify(a);
      calls.set(idx, cur);
      onText('call', `${tc.function?.name ?? ''}${typeof a === 'string' ? a : ''}`);
    });
  };
  for (;;) {
    if (signal?.aborted) throw new Error('stopped');
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf.trim());
  return { content, reasoning, calls, usage };
}

async function callModel(ep: Endpoint, messages: Msg[], tools: AgentTool[], offerTools: boolean, fetcher: Fetcher, timeoutMs: number, deadline: number, live: Live): Promise<ModelReply> {
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
    ...(live.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };

  // Streaming has an idle timeout (no data for `timeoutMs`) so a slow CPU can keep generating; a plain request has a total one.
  const idle = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const bump = () => {
    if (!live.stream) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new Error(`no data from the model for ${Math.round(timeoutMs / 1000)} s`)), Math.max(5_000, timeoutMs));
    idleTimer.unref();
  };
  const signals = [AbortSignal.timeout(Math.max(5_000, live.stream ? deadline - Date.now() : timeoutMs)), ...(live.stream ? [idle.signal] : []), ...(live.signal ? [live.signal] : [])];
  const t0 = Date.now();
  let firstAt = 0;
  let pieces = 0;
  let lastStats = 0;
  const tick = (n: number) => {
    if (!firstAt) firstAt = Date.now();
    pieces += n;
    const now = Date.now();
    if (now - lastStats >= STATS_EVERY_MS) {
      lastStats = now;
      live.emit({ t: 'stats', n: live.step, tokens: pieces, tps: pieces / Math.max(0.001, (now - firstAt) / 1000), ttft: firstAt - t0 });
    }
  };

  try {
    bump();
    const res = await fetcher(`${ep.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);

    let content: string;
    let reasoning: string;
    let rawCalls: { id: string; name: string; args: unknown; raw: unknown }[];
    let usage: Chunk['usage'];
    if (live.stream) {
      const out = await readStream(
        res,
        (kind, d) => {
          bump();
          tick(1);
          if (kind !== 'call') live.emit({ t: kind, d });
        },
        AbortSignal.any(signals),
      );
      content = out.content;
      reasoning = out.reasoning;
      usage = out.usage;
      rawCalls = [...out.calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, args: c.args, raw: { id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args } } }));
    } else {
      const data = (await res.json()) as Chunk;
      const msg = data.choices?.[0]?.message;
      content = msg?.content ?? '';
      reasoning = msg?.reasoning ?? msg?.reasoning_content ?? '';
      usage = data.usage;
      rawCalls = (msg?.tool_calls ?? []).flatMap((c, i) => (c.function?.name ? [{ id: c.id || `call_${i}`, name: c.function.name, args: c.function.arguments, raw: c }] : []));
    }
    const ms = Date.now() - t0;
    const text = stripThink(content);
    const calls: ParsedCall[] = native
      ? rawCalls.map((c) => ({ id: c.id, name: c.name, args: asArgs(c.args), raw: c.raw }))
      : ep.mode === 'text' && tools.length && offerTools
        ? parseTextCalls(text)
        : [];
    const tokens = usage?.completion_tokens ?? pieces;
    const gen = Math.max(0.001, (Date.now() - (firstAt || t0)) / 1000);
    return { content: text, reasoning: reasoning.trim(), calls, tokens, promptTokens: usage?.prompt_tokens ?? null, ttft: firstAt ? firstAt - t0 : ms, tps: tokens / (live.stream ? gen : Math.max(0.001, ms / 1000)) };
  } finally {
    clearTimeout(idleTimer);
  }
}

async function loop(ctx: AppContext, ep: Endpoint, run: AgentRun, system: string, user: string, history: NonNullable<AgentDeps['history']>, tools: AgentTool[], fetcher: Fetcher, deadline: number, io: { emit: (e: AgentEvent) => void; signal?: AbortSignal | undefined; stream: boolean }): Promise<string | null> {
  const s = brain();
  const messages: Msg[] = [
    { role: 'system', content: ep.mode === 'text' && tools.length ? `${system}\n\n${textProtocol(tools)}` : system },
    ...history.map((h): Msg => ({ role: h.role, content: h.content })),
    { role: 'user', content: user },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const done = new Map<string, string>();
  for (let n = 1; n <= s.maxSteps; n++) {
    const last = n === s.maxSteps;
    if (last && n > 1) messages.push({ role: 'user', content: 'You have no tool calls left. Answer now with what you have, and say what you could not confirm.' });
    const stepNo = run.steps.length + 1;
    io.emit({ t: 'step', n: stepNo, endpoint: ep.local ? 'local' : 'cloud', model: ep.model, mode: ep.mode });
    const t0 = Date.now();
    const reply = await callModel(ep, messages, tools, !last, fetcher, Math.min(ep.timeoutMs, deadline - Date.now()), deadline, { ...io, step: stepNo });
    const step: StepTrace = { n: stepNo, endpoint: ep.local ? 'local' : 'cloud', model: ep.model, ms: Date.now() - t0, reasoning: reply.reasoning, content: reply.content, calls: [], tokens: reply.tokens, tps: reply.tps, ttft: reply.ttft, promptTokens: reply.promptTokens };
    run.steps.push(step);
    io.emit({ t: 'stepend', n: stepNo, ms: step.ms, tokens: reply.tokens, tps: reply.tps, ttft: reply.ttft, promptTokens: reply.promptTokens });

    if (reply.calls.length && !last) {
      const calls = reply.calls.slice(0, MAX_CALLS_PER_STEP);
      messages.push(ep.mode === 'native' ? { role: 'assistant', content: reply.content, tool_calls: calls.map((c) => c.raw) } : { role: 'assistant', content: reply.content });
      for (const call of calls) {
        const key = `${call.name}:${JSON.stringify(call.args)}`;
        const trace = { name: call.name, args: call.args, result: '', ms: 0, error: false };
        step.calls.push(trace);
        io.emit({ t: 'tool', n: stepNo, name: call.name, args: call.args });
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
        io.emit({ t: 'toolresult', n: stepNo, name: call.name, ms: trace.ms, error: out.error, result: out.text.slice(0, 1500) });
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
  const emit = deps.onEvent ?? (() => {});
  const tools = enabledTools(ctx, deps.tools);
  const system = [buildSystemPrompt({ bot: config.BOT_NAME, clan: config.CLAN_NAME }), who.operator ? OPERATOR_NOTE : '', deps.guidance ?? ''].filter(Boolean).join('\n\n');
  const run = deps.run ?? newRun({ who: who.name, operator: who.operator, question, system });
  run.system = system;
  emit({ t: 'start', id: run.id });
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  const head = await wikiPrefetch(question, tools, { followUp: Boolean(deps.history?.length) });
  if (head) run.prefetched = head.titles;
  const user = `[${new Date(now).toISOString().slice(0, 16)} UTC · ${who.name}]\n${question}${head?.text ?? ''}`;
  const errors: string[] = [];
  const io = { emit, signal: deps.signal, stream: deps.stream ?? Boolean(deps.onEvent) };
  const finish = (): AgentRun => {
    run.ms = Date.now() - started;
    run.tokens = run.steps.reduce((n, st) => n + (st.tokens ?? 0), 0);
    const gen = run.steps.reduce((n, st) => n + (st.tokens && st.tps ? st.tokens / st.tps : 0), 0);
    run.tps = gen > 0 ? run.tokens / gen : 0;
    return run;
  };

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
        const text = await loop(ctx, attempt, run, system, user, deps.history ?? [], tools, fetcher, deadline, io);
        if (text) {
          run.text = text.length > s.maxChars ? `${text.slice(0, s.maxChars - 1)}…` : text;
          run.via = ep.local ? 'local' : 'cloud';
          run.model = ep.model;
          run.status = 'done';
          finish();
          emit({ t: 'done', text: run.text, via: run.via, model: ep.model, ms: run.ms, tokens: run.tokens, tps: run.tps });
          return run;
        }
        errors.push(`${ep.model} gave no answer.`);
        break;
      } catch (err) {
        if (deps.signal?.aborted) {
          run.status = 'failed';
          run.error = 'Stopped.';
          finish();
          emit({ t: 'error', message: 'Stopped.' });
          return run;
        }
        const msg = err instanceof Error ? err.message : String(err);
        // A model that rejects the `tools` field gets one more go with tool calls written as text.
        if (attempt.mode === 'native' && /HTTP 400/.test(msg) && /tool/i.test(msg) && tools.length) {
          attempt = { ...attempt, mode: 'text' };
          emit({ t: 'reset', why: `${ep.model} does not support tool calling: retrying with tool calls written as text` });
          continue;
        }
        errors.push(`${ep.model}: ${msg}`);
        console.warn(`[agent] ${ep.local ? 'local' : 'cloud'} model failed: ${msg}`);
        if (ep.local) {
          markLocalDown(now);
          console.warn(`[agent] local AI skipped for ${LOCAL_COOLDOWN_MS / 60_000} min`);
        }
        emit({ t: 'reset', why: `${ep.model} failed: ${msg}` });
        break;
      }
    }
  }
  run.status = 'failed';
  run.error = errors.join(' · ') || 'No answer.';
  finish();
  emit({ t: 'error', message: run.error });
  return run;
}
