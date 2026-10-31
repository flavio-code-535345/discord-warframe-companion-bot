import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { chooseModel, setToggle, tuneModel } from '../src/ai/control.js';
import { resetCapabilities, setChosenModel } from '../src/ai/ollama.js';
import { TOGGLE_KEYS, aiToggle, loadAiToggles, resetAiToggles, setAiToggle } from '../src/ai/settings.js';
import { resetLocalAi } from '../src/ai/local.js';
import { logAnswer } from '../src/answers/log.js';
import { Store } from '../src/db.js';
import { webSearch } from '../src/warframe/websearch.js';

afterEach(() => {
  resetAiToggles();
  resetCapabilities();
  resetLocalAi();
  setChosenModel(null);
});

const cfg = {
  FREE_AI_KEY: 'test-key-123',
  FREE_AI_URL: 'https://llm.example/v1',
  FREE_AI_MODEL: 'cloud',
  FREE_AI_DAILY_LIMIT: 100,
  LOCAL_AI_URL: 'http://h:11434/v1',
  LOCAL_AI_MODEL: 'gemma',
};
const show = (...capabilities: string[]) => new Response(JSON.stringify({ capabilities }));

describe('switches', () => {
  it('have defaults, are saved in bot_meta and survive a restart', () => {
    const store = new Store(':memory:');
    assert.deepEqual(
      TOGGLE_KEYS.map((k) => [k, aiToggle(k)]),
      [['local', true], ['thinking', false], ['websearch', true], ['log', true]],
    );
    setAiToggle(store, 'thinking', true);
    setAiToggle(store, 'websearch', false);
    resetAiToggles();
    assert.equal(aiToggle('thinking'), false, 'memory is cleared');
    loadAiToggles(store);
    assert.equal(aiToggle('thinking'), true);
    assert.equal(aiToggle('websearch'), false);
    assert.equal(aiToggle('log'), true);
  });

  it('web search and the question log can each be switched off', async () => {
    const store = new Store(':memory:');
    let calls = 0;
    setAiToggle(store, 'websearch', false);
    const none = await webSearch('http://s', 'q', 3, (async () => {
      calls++;
      return new Response('{}');
    }) as never);
    assert.deepEqual(none, []);
    assert.equal(calls, 0);

    const ctx = { store, config: { DISCORD_GUILD_ID: 'g' } } as never;
    const who = { id: '1', name: 'A', channelId: null, via: 'ask' } as never;
    const answer = { content: 'x', embeds: [], found: true } as never;
    setAiToggle(store, 'log', false);
    logAnswer(ctx, who, 'q', answer);
    assert.equal(store.recentAiLog('g', 10).length, 0);
    setAiToggle(store, 'log', true);
    logAnswer(ctx, who, 'q', answer);
    assert.equal(store.recentAiLog('g', 10).length, 1);
  });
});

describe('control actions', () => {
  const ctxOf = (store: Store) => ({ store, config: { ...cfg, DISCORD_GUILD_ID: 'g', OPERATOR_IDS: [], LOCAL_AI_TIMEOUT_SECONDS: 5 } }) as never;

  it('warns when thinking is turned on for a model that cannot think', async () => {
    const store = new Store(':memory:');
    const msg = await setToggle(ctxOf(store), 'thinking', true, (async () => show('completion')) as never);
    assert.match(msg, /is now on/);
    assert.match(msg, /does not support thinking/);
    assert.equal(aiToggle('thinking'), true);
  });

  it('chooses an installed model, refuses an unknown one, and goes back to the default', async () => {
    const store = new Store(':memory:');
    const tags = (async () => new Response(JSON.stringify({ models: [{ name: 'small:1', size: 5e9, details: { parameter_size: '4B' } }] }))) as never;
    assert.match(await chooseModel(ctxOf(store), 'small:1', tags), /now answers with small:1/);
    assert.equal(store.getMeta('local_ai_model'), 'small:1');
    await assert.rejects(chooseModel(ctxOf(store), 'nope', tags), /not installed/);
    assert.match(await chooseModel(ctxOf(store), '-', tags), /Back to the bot's own setting: gemma/);
  });

  it('makes a CPU-tuned copy of the model in use, and can switch to it', async () => {
    const store = new Store(':memory:');
    const created: unknown[] = [];
    const server = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/create') {
        created.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ status: 'success' }));
      }
      return new Response(JSON.stringify({ models: [{ name: 'gemma', size: 5e9 }, ...(created.length ? [{ name: 'ordis-t6', size: 5e9 }] : [])] }));
    }) as never;

    assert.match(await tuneModel(ctxOf(store), { threads: 6 }, server), /Created ordis-t6 from gemma with 6 threads and a 4096-token context/);
    assert.deepEqual(created[0], { model: 'ordis-t6', from: 'gemma', parameters: { num_thread: 6, num_ctx: 4096 }, stream: false });
    assert.equal(store.getMeta('local_ai_model') ?? '', '');

    assert.match(await tuneModel(ctxOf(store), { threads: 6, use: true }, server), /now answers with ordis-t6/);
    assert.equal(store.getMeta('local_ai_model'), 'ordis-t6');
  });

  it('refuses silly tuning requests', async () => {
    const store = new Store(':memory:');
    const tags = (async () => new Response(JSON.stringify({ models: [{ name: 'gemma', size: 5e9 }] }))) as never;
    await assert.rejects(tuneModel(ctxOf(store), { threads: 0 }, tags), /between 1 and 64/);
    await assert.rejects(tuneModel(ctxOf(store), { threads: 6, context: 10 }, tags), /Context must be/);
    await assert.rejects(tuneModel(ctxOf(store), { threads: 6, from: 'missing' }, tags), /"missing" is not installed/);
    await assert.rejects(tuneModel(ctxOf(store), { threads: 6, name: 'bad name!' }, tags), /usable model name/);
    const failing = (async (url: string) => (new URL(String(url)).pathname === '/api/create' ? new Response(JSON.stringify({ error: 'nope' })) : new Response(JSON.stringify({ models: [{ name: 'gemma', size: 1 }] })))) as never;
    await assert.rejects(tuneModel(ctxOf(store), { threads: 6 }, failing), /could not create ordis-t6: nope/);
  });
});
