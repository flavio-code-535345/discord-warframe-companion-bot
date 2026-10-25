import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeAnswer } from '../src/answers/compose.js';

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
