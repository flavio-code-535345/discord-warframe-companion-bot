import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { useAgent } from '../src/agent/answer.js';
import { DEFAULT_PROMPT, brain, buildSystemPrompt, loadBrain, normalizeBrain, personaBand, resetBrain, resetBrainState, toneFor, updateBrain } from '../src/agent/brain.js';
import { runAgent } from '../src/agent/run.js';
import { type AgentTool, enabledTools } from '../src/agent/tools.js';
import { getRun, resetRuns } from '../src/agent/traces.js';
import { resetCapabilities } from '../src/ai/ollama.js';
import { resetAiToggles } from '../src/ai/settings.js';
import { resetLocalAi } from '../src/answers/compose.js';
import { Store } from '../src/db.js';

afterEach(() => {
  resetBrainState();
  resetAiToggles();
  resetCapabilities();
  resetLocalAi();
  resetRuns();
});

const config = {
  BOT_NAME: 'Cephalon Ordis',
  CLAN_NAME: 'The Rats Den 69',
  DISCORD_GUILD_ID: 'g',
  OPERATOR_IDS: ['1'],
  LOCAL_AI_URL: 'http://h:11434/v1',
  LOCAL_AI_MODEL: 'gemma',
  LOCAL_AI_TIMEOUT_SECONDS: 5,
  FREE_AI_KEY: undefined as string | undefined,
  FREE_AI_URL: 'https://cloud.example/v1',
  FREE_AI_MODEL: 'cloud',
  FREE_AI_DAILY_LIMIT: 100,
  WARFRAME_PLATFORM: 'pc',
};
const ctxOf = (over: Partial<typeof config> = {}) => ({ config: { ...config, ...over }, store: new Store(':memory:') }) as never;
const who = { id: '2', name: 'Rat', operator: false };

const echo: AgentTool = {
  name: 'echo',
  description: 'Echoes the query back.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  run: async (args) => ({ echoed: args.q }),
};
const other: AgentTool = { ...echo, name: 'other' };

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const reply = (content: string | null, tool_calls?: unknown[], extra: object = {}) => json({ choices: [{ message: { content, ...(tool_calls ? { tool_calls } : {}), ...extra } }] });
const toolCall = (name: string, args: object, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const show = (...capabilities: string[]) => json({ capabilities });

/** A fake server: /api/show answers capabilities, chat requests are recorded and answered from the queue. */
function server(caps: string[], replies: (() => Response)[]) {
  const bodies: Record<string, any>[] = [];
  const queue = [...replies];
  const fetcher = async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/show')) return show(...caps);
    bodies.push(JSON.parse(String(init.body)));
    const next = queue.shift();
    if (!next) throw new Error('no more replies');
    return next();
  };
  return { fetcher, bodies };
}

describe('brain settings', () => {
  it('clamps everything and keeps bad input out', () => {
    const s = normalizeBrain({ ordisness: 500, temperature: '0.7', topP: -3, maxSteps: 99, maxTokens: 'x', agentFor: 'nobody', scope: 'all', disabledTools: ['search_web', 'Bad Name', 5, 'search_web'], showTools: 'yes', prompt: '  hi  ' });
    assert.equal(s.ordisness, 100);
    assert.equal(s.temperature, 0.7);
    assert.equal(s.topP, 0.1);
    assert.equal(s.maxSteps, 8);
    assert.equal(s.maxTokens, 1200, 'unparsable falls back to the default');
    assert.equal(s.agentFor, 'operators');
    assert.equal(s.scope, 'all');
    assert.deepEqual(s.disabledTools, ['search_web']);
    assert.equal(s.showTools, false);
    assert.equal(s.prompt, 'hi');
  });

  it('are saved in bot_meta, survive a restart and reset to the defaults', () => {
    const store = new Store(':memory:');
    updateBrain(store, { ordisness: 80, agentFor: 'everyone', prompt: 'Custom {{persona}}' });
    resetBrainState();
    assert.equal(brain().ordisness, 20);
    loadBrain(store);
    assert.equal(brain().ordisness, 80);
    assert.equal(brain().agentFor, 'everyone');
    resetBrain(store);
    loadBrain(store);
    assert.equal(brain().ordisness, 20);
    assert.equal(brain().prompt, '');
  });

  it('turns the slider into a persona and builds the system prompt', () => {
    assert.deepEqual([0, 20, 50, 51, 100].map((l) => personaBand(l).name), ['Off', 'Hint', 'Light', 'Strong', 'Full']);
    const vars = { bot: 'Ordis', clan: 'Rats', now: new Date('2026-01-02T00:00:00Z') };
    const prompt = buildSystemPrompt(vars, normalizeBrain({ ordisness: 100 }));
    assert.match(prompt, /You are Ordis, the Cephalon of the Warframe clan "Rats"/);
    assert.match(prompt, /Persona level: 100\/100 \(Full\)/);
    assert.match(prompt, /theatrical/);
    // A custom prompt with the placeholders; without {{persona}} the persona is appended.
    const custom = normalizeBrain({ prompt: 'Be {{bot}} on {{date}}.', ordisness: 0 });
    assert.equal(buildSystemPrompt(vars, custom), 'Be Ordis on 2026-01-02.\n\nPersona level: 0/100 (Off).\n' + personaBand(0).text);
    assert.ok(DEFAULT_PROMPT.includes('{{persona}}'));
    assert.match(toneFor(10), /no roleplay/);
    assert.match(toneFor(90), /theatrical/);
  });

  it('can switch tools off', () => {
    const ctx = ctxOf();
    assert.deepEqual(enabledTools(ctx, [echo, other]).map((t) => t.name), ['echo', 'other']);
    updateBrain(new Store(':memory:'), { disabledTools: ['other'] });
    assert.deepEqual(enabledTools(ctx, [echo, other]).map((t) => t.name), ['echo']);
  });
});

describe('agent loop', () => {
  it('lets the model call a tool, reads the result, then answers (native tool calling)', async () => {
    const s = server(['completion', 'tools'], [() => reply('', [toolCall('echo', { q: 'kuva' })]), () => reply('Use the Kuva Bramma.', undefined, { reasoning: 'thinking about it' })]);
    updateBrain(new Store(':memory:'), { temperature: 0.1 });
    const run = await runAgent(ctxOf(), 'best kuva weapon?', who, { fetcher: s.fetcher, tools: [echo] });
    assert.equal(run.status, 'done');
    assert.equal(run.text, 'Use the Kuva Bramma.');
    assert.equal(run.via, 'local');
    assert.equal(run.mode, 'native');
    assert.equal(run.steps.length, 2);
    assert.equal(run.steps[0]!.calls[0]!.name, 'echo');
    assert.match(run.steps[0]!.calls[0]!.result, /kuva/);
    assert.equal(run.steps[1]!.reasoning, 'thinking about it');
    assert.equal(getRun(run.id), run, 'kept for the panel');

    const first = s.bodies[0]!;
    assert.equal(first.temperature, 0.1);
    assert.equal(first.reasoning_effort, 'none');
    assert.equal(first.tools[0].function.name, 'echo');
    assert.match(first.messages[0].content, /Persona level: 20/);
    const second = s.bodies[1]!;
    assert.deepEqual(second.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: '{"echoed":"kuva"}' });
    assert.equal(second.messages.at(-2).role, 'assistant');
  });

  it('forces an answer on the last step by withholding the tools', async () => {
    updateBrain(new Store(':memory:'), { maxSteps: 2 });
    const s = server(['tools'], [() => reply('', [toolCall('echo', { q: 'a' })]), () => reply('Done anyway.')]);
    const run = await runAgent(ctxOf(), 'q', who, { fetcher: s.fetcher, tools: [echo] });
    assert.equal(run.text, 'Done anyway.');
    assert.ok(s.bodies[0]!.tools);
    assert.equal(s.bodies[1]!.tools, undefined);
    assert.match(s.bodies[1]!.messages.at(-1).content, /no tool calls left/);
  });

  it('tells the model when it calls a tool that does not exist, and never repeats an identical call', async () => {
    const s = server(['tools'], [() => reply('', [toolCall('nope', {}, 'a'), toolCall('echo', { q: 'z' }, 'b'), toolCall('echo', { q: 'z' }, 'c')]), () => reply('ok')]);
    let runs = 0;
    const counted: AgentTool = { ...echo, run: async (a) => (runs++, { echoed: a.q }) };
    const run = await runAgent(ctxOf(), 'q', who, { fetcher: s.fetcher, tools: [counted] });
    assert.equal(run.text, 'ok');
    assert.equal(runs, 1);
    assert.equal(run.steps[0]!.calls[0]!.error, true);
    assert.match(run.steps[0]!.calls[0]!.result, /no tool called \\"nope\\"/);
  });

  it('uses tool calls written as text for a model without native support', async () => {
    const s = server(['completion'], [() => reply('<tool_call>{"name": "echo", "arguments": {"q": "a"}}</tool_call>'), () => reply('Final answer.')]);
    const run = await runAgent(ctxOf(), 'q', who, { fetcher: s.fetcher, tools: [echo] });
    assert.equal(run.mode, 'text');
    assert.equal(run.text, 'Final answer.');
    assert.equal(s.bodies[0]!.tools, undefined);
    assert.match(s.bodies[0]!.messages[0].content, /Tools:\n- echo\(q\): Echoes/);
    assert.match(s.bodies[1]!.messages.at(-1).content, /^<tool_result name="echo">\{"echoed":"a"\}<\/tool_result>$/);
  });

  it('retries in text mode when the server refuses the tools field', async () => {
    const s = server(['tools'], [() => json({ error: 'registry.ollama.ai/x does not support tools' }, 400), () => reply('Plain answer.')]);
    const run = await runAgent(ctxOf(), 'q', who, { fetcher: s.fetcher, tools: [echo] });
    assert.equal(run.text, 'Plain answer.');
    assert.equal(run.mode, 'text');
  });

  it('falls back to the cloud model when the local one fails, and skips local for a while', async () => {
    const urls: string[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      urls.push(url);
      if (url.startsWith('http://h')) {
        if (url.endsWith('/api/show')) return show('tools');
        throw new Error('ECONNREFUSED');
      }
      return reply('From the cloud.');
    };
    const ctx = ctxOf({ FREE_AI_KEY: 'key-12345678' });
    const run = await runAgent(ctx, 'q', who, { fetcher, tools: [echo] });
    assert.equal(run.text, 'From the cloud.');
    assert.equal(run.via, 'cloud');
    await runAgent(ctx, 'q2', who, { fetcher, tools: [echo] });
    assert.equal(urls.filter((u) => u.endsWith('/chat/completions') && u.startsWith('http://h')).length, 1, 'the local server is skipped after a failure');
  });

  it('reports why when no model could answer', async () => {
    const run = await runAgent(ctxOf({ LOCAL_AI_URL: undefined }), 'q', who, { fetcher: async () => reply('x'), tools: [echo] });
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /No model is available/);
  });

  it('adds the operator paragraph only for operators, and thinking only when switched on and supported', async () => {
    const a = server(['tools', 'thinking'], [() => reply('hi')]);
    await runAgent(ctxOf(), 'q', { id: '1', name: 'Boss', operator: true }, { fetcher: a.fetcher, tools: [echo] });
    assert.match(a.bodies[0]!.messages[0].content, /one of your two operators/);
    assert.equal(a.bodies[0]!.reasoning_effort, 'none');

    const b = server(['tools'], [() => reply('hi')]);
    await runAgent(ctxOf(), 'q', who, { fetcher: b.fetcher, tools: [echo] });
    assert.doesNotMatch(b.bodies[0]!.messages[0].content, /one of your two operators/);
  });
});

describe('who gets the agent', () => {
  it('follows the setting, the asker and the kind of question', () => {
    const ctx = ctxOf();
    const store = new Store(':memory:');
    assert.equal(useAgent(ctx, '1', 'wiki'), true, 'default: operators, open-ended questions');
    assert.equal(useAgent(ctx, '2', 'wiki'), false, 'not an operator');
    assert.equal(useAgent(ctx, '1', 'price'), false, 'prices stay exact lookups');
    updateBrain(store, { agentFor: 'everyone' });
    assert.equal(useAgent(ctx, '2', 'build'), true);
    assert.equal(useAgent(ctx, '2', 'drops'), false);
    updateBrain(store, { scope: 'all' });
    assert.equal(useAgent(ctx, '2', 'drops'), true);
    assert.equal(useAgent(ctx, '2', 'help'), false);
    updateBrain(store, { agentFor: 'off' });
    assert.equal(useAgent(ctx, '1', 'wiki'), false);
    updateBrain(store, { agentFor: 'everyone' });
    assert.equal(useAgent(ctxOf({ LOCAL_AI_URL: undefined }), '2', 'wiki'), false, 'no model to run it');
  });
});

describe('live streaming', () => {
  const sse = (...events: unknown[]) => new Response(`${events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`);
  const delta = (d: object) => ({ choices: [{ delta: d }] });

  it('streams reasoning, tool calls and the answer, and reports tokens per second', async () => {
    const s = server(
      ['tools'],
      [
        () => sse(delta({ reasoning: 'hmm ' }), delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'echo', arguments: '{"q":' } }] }), delta({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }), { choices: [], usage: { completion_tokens: 12, prompt_tokens: 100 } }),
        () => sse(delta({ content: 'Hel' }), delta({ content: 'lo.' }), { choices: [], usage: { completion_tokens: 5, prompt_tokens: 140 } }),
      ],
    );
    const events: any[] = [];
    const run = await runAgent(ctxOf(), 'q', who, { fetcher: s.fetcher, tools: [echo], onEvent: (e) => events.push(e), history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }] });
    assert.equal(run.text, 'Hello.');
    assert.deepEqual(events.map((e) => e.t).filter((t, i, all) => all.indexOf(t) === i), ['start', 'step', 'stats', 'reasoning', 'stepend', 'tool', 'toolresult', 'content', 'done']);
    assert.deepEqual(events.find((e) => e.t === 'tool').args, { q: 'a' });
    assert.equal(events.find((e) => e.t === 'stepend').tokens, 12);
    assert.equal(events.find((e) => e.t === 'stepend').promptTokens, 100);
    assert.equal(events.filter((e) => e.t === 'content').map((e) => e.d).join(''), 'Hello.');
    const done = events.at(-1);
    assert.equal(done.t, 'done');
    assert.equal(done.tokens, 17);
    assert.ok(done.tps > 0);
    assert.equal(run.steps[0]!.tokens, 12);
    assert.equal(run.tokens, 17);

    assert.equal(s.bodies[0]!.stream, true);
    assert.deepEqual(s.bodies[0]!.stream_options, { include_usage: true });
    assert.deepEqual(s.bodies[0]!.messages.slice(1, 3), [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'reply' }]);
    const assistant = s.bodies[1]!.messages.find((m: any) => m.tool_calls);
    assert.equal(assistant.tool_calls[0].function.arguments, '{"q":"a"}');
    assert.deepEqual(s.bodies[1]!.messages.at(-1), { role: 'tool', tool_call_id: 'c1', content: '{"echoed":"a"}' });
  });

  it('stops when asked and does not blame the local server', async () => {
    const ac = new AbortController();
    const fetcher = async (url: string) => {
      if (url.endsWith('/api/show')) return show('tools');
      ac.abort();
      throw new Error('aborted');
    };
    const events: any[] = [];
    const run = await runAgent(ctxOf(), 'q', who, { fetcher, tools: [echo], onEvent: (e) => events.push(e), signal: ac.signal });
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'Stopped.');
    assert.deepEqual(events.at(-1), { t: 'error', message: 'Stopped.' });
    const s = server(['tools'], [() => reply('still local')]);
    assert.equal((await runAgent(ctxOf(), 'q', who, { fetcher: s.fetcher, tools: [echo] })).via, 'local');
  });
});
