import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { chooseModel, setToggle } from '../src/ai/control.js';
import { resetCapabilities, setChosenModel } from '../src/ai/ollama.js';
import { TOGGLE_KEYS, aiToggle, loadAiToggles, resetAiToggles, setAiToggle } from '../src/ai/settings.js';
import { composeAnswer, resetLocalAi } from '../src/answers/compose.js';
import { logAnswer } from '../src/answers/log.js';
import { useOperatorMode } from '../src/answers/operator.js';
import { Store } from '../src/db.js';
import { webSearch } from '../src/warframe/websearch.js';

afterEach(() => {
  resetAiToggles();
  resetCapabilities();
  resetLocalAi();
  setChosenModel(null);
});

const passages = [{ title: 'T', url: 'u', extract: 'e' }];
const cfg = {
  FREE_AI_KEY: 'test-key-123',
  FREE_AI_URL: 'https://llm.example/v1',
  FREE_AI_MODEL: 'cloud',
  FREE_AI_DAILY_LIMIT: 100,
  LOCAL_AI_URL: 'http://h:11434/v1',
  LOCAL_AI_MODEL: 'gemma',
};
const chat = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
const show = (...capabilities: string[]) => new Response(JSON.stringify({ capabilities }));

describe('switches', () => {
  it('have defaults, are saved in bot_meta and survive a restart', () => {
    const store = new Store(':memory:');
    assert.deepEqual(
      TOGGLE_KEYS.map((k) => [k, aiToggle(k)]),
      [['local', true], ['thinking', false], ['websearch', true], ['operators', true], ['log', true]],
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

  it('local off sends everything to the cloud model', async () => {
    setAiToggle(new Store(':memory:'), 'local', false);
    const urls: string[] = [];
    const out = await composeAnswer(cfg, 'q', passages, async (url) => {
      urls.push(url);
      return chat('from cloud');
    });
    assert.equal(out, 'from cloud');
    assert.deepEqual(urls, ['https://llm.example/v1/chat/completions']);
  });

  it('thinking on lets a capable model reason and leaves other models alone', async () => {
    setAiToggle(new Store(':memory:'), 'thinking', true);
    const seen: Record<string, unknown>[] = [];
    const run = (capabilities: string[]) =>
      composeAnswer(cfg, 'q', passages, async (url, init) => {
        if (url.endsWith('/api/show')) return show(...capabilities);
        seen.push(JSON.parse(String(init.body)));
        return chat('ok');
      });

    await run(['completion', 'thinking']);
    assert.equal(seen[0]!.reasoning_effort, 'low');
    assert.equal(seen[0]!.max_tokens, 3000);

    resetCapabilities();
    await run(['completion']);
    assert.equal(seen[1]!.reasoning_effort, 'none');
    assert.equal(seen[1]!.max_tokens, 1200);
  });

  it('thinking off (the default) always sends none and asks nothing extra', async () => {
    const urls: string[] = [];
    let effort: unknown;
    await composeAnswer(cfg, 'q', passages, async (url, init) => {
      urls.push(url);
      effort = JSON.parse(String(init.body)).reasoning_effort;
      return chat('ok');
    });
    assert.equal(effort, 'none');
    assert.ok(!urls.some((u) => u.endsWith('/api/show')));
  });

  it('web search, operator mode and the question log can each be switched off', async () => {
    const store = new Store(':memory:');
    const ops = { OPERATOR_IDS: ['1'] };
    assert.ok(useOperatorMode(ops, '1', 'wiki'));
    setAiToggle(store, 'operators', false);
    assert.ok(!useOperatorMode(ops, '1', 'wiki'));

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
});
