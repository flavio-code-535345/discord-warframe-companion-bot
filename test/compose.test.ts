import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCAL_COOLDOWN_MS, composeAnswer, resetLocalAi } from '../src/answers/compose.js';

const config = { FREE_AI_KEY: 'test-key-123', FREE_AI_URL: 'https://llm.example/v1/', FREE_AI_MODEL: 'm', FREE_AI_DAILY_LIMIT: 100 };
const passages = [{ title: 'The Steel Path', url: 'u', extract: 'Talk to Teshin on any Relay to unlock the mode.' }];
const reply = (content: string, status = 200) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

test('sends only the excerpts and returns the written answer', async () => {
  let body: any;
  const out = await composeAnswer(config, 'how do i unlock steel path', passages, async (url, init) => {
    assert.equal(url, 'https://llm.example/v1/chat/completions');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-key-123');
    body = JSON.parse(String(init.body));
    return reply('Talk to **Teshin** on any Relay.')();
  });
  assert.equal(out, 'Talk to **Teshin** on any Relay.');
  assert.match(body.messages[1].content, /Talk to Teshin on any Relay/);
  assert.match(body.messages[0].content, /ONLY the wiki excerpts/);
});

test('returns null (so the plain excerpt is used) without a key, when not covered, or on errors', async () => {
  assert.equal(await composeAnswer({ ...config, FREE_AI_KEY: undefined }, 'q', passages, reply('x')), null);
  assert.equal(await composeAnswer(config, 'q', passages, reply('NOT_COVERED')), null);
  assert.equal(await composeAnswer(config, 'q', passages, reply('x', 429)), null);
  assert.equal(await composeAnswer(config, 'q', passages, async () => { throw new Error('down'); }), null);
});

test('stops calling the model once the daily allowance is used', async () => {
  const tight = { ...config, FREE_AI_DAILY_LIMIT: 1 };
  let calls = 0;
  const f = async () => { calls++; return reply('ok')(); };
  await composeAnswer(tight, 'q', passages, f);
  await composeAnswer(tight, 'q', passages, f);
  assert.ok(calls <= 1);
});

test('falls back to the backup model when the main one is overloaded', async () => {
  const models: string[] = [];
  const out = await composeAnswer({ ...config, FREE_AI_FALLBACK_MODEL: 'backup' }, 'q', passages, async (_url, init) => {
    const model = JSON.parse(String(init.body)).model as string;
    models.push(model);
    return model === 'backup' ? reply('Answer from the backup.')() : new Response('busy', { status: 503 });
  });
  assert.deepEqual(models, ['m', 'backup']);
  assert.equal(out, 'Answer from the backup.');
});

const local = { ...config, LOCAL_AI_URL: 'http://100.64.0.1:11434/v1', LOCAL_AI_MODEL: 'gemma' };

test('asks the local model first, without the cloud key or daily limit', async () => {
  resetLocalAi();
  const urls: string[] = [];
  const out = await composeAnswer({ ...local, FREE_AI_KEY: undefined, FREE_AI_DAILY_LIMIT: 1 }, 'q', passages, async (url, init) => {
    urls.push(url);
    assert.equal(JSON.parse(String(init.body)).model, 'gemma');
    return reply('Local answer.')();
  });
  assert.equal(out, 'Local answer.');
  assert.deepEqual(urls, ['http://100.64.0.1:11434/v1/chat/completions']);
});

test('falls back to the cloud when the local server is down, then skips it for a while', async () => {
  resetLocalAi();
  const urls: string[] = [];
  const f = async (url: string) => {
    urls.push(url);
    if (url.startsWith('http://100.')) throw new Error('timeout');
    return reply('Cloud answer.')();
  };
  const t = Date.now();
  assert.equal(await composeAnswer(local, 'q', passages, f, t), 'Cloud answer.');
  assert.equal(await composeAnswer(local, 'q', passages, f, t + 1000), 'Cloud answer.');
  assert.equal(urls.filter((u) => u.startsWith('http://100.')).length, 1);
  await composeAnswer(local, 'q', passages, f, t + LOCAL_COOLDOWN_MS + 1);
  assert.equal(urls.filter((u) => u.startsWith('http://100.')).length, 2);
  resetLocalAi();
});

test('a clean "not covered" from the local model is final', async () => {
  resetLocalAi();
  let cloud = 0;
  const out = await composeAnswer(local, 'q', passages, async (url) => {
    if (!url.startsWith('http://100.')) cloud++;
    return reply('NOT_COVERED')();
  });
  assert.equal(out, null);
  assert.equal(cloud, 0);
});

test('turns thinking off for the local model only', async () => {
  resetLocalAi();
  const efforts: Record<string, unknown> = {};
  await composeAnswer({ ...local, FREE_AI_FALLBACK_MODEL: undefined }, 'q', passages, async (url, init) => {
    efforts[url.startsWith('http://100.') ? 'local' : 'cloud'] = JSON.parse(String(init.body)).reasoning_effort;
    throw new Error('down');
  });
  assert.equal(efforts.local, 'none');
  assert.equal(efforts.cloud, undefined);
  resetLocalAi();
});
