import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestUpdate, scheduleRestart } from '../src/selfupdate.js';

const config = { WATCHTOWER_URL: 'http://watchtower:8080', WATCHTOWER_TOKEN: 'secret-token' };

test('posts to Watchtower with the bearer token', async () => {
  let seen: { url: string; auth: string | null } | null = null;
  await requestUpdate(config, async (url, init) => {
    seen = { url, auth: new Headers(init.headers).get('authorization') };
    return new Response('{}', { status: 200 });
  });
  assert.deepEqual(seen, { url: 'http://watchtower:8080/v1/update', auth: 'Bearer secret-token' });
});

test('explains itself when not configured or rejected', async () => {
  await assert.rejects(requestUpdate({}), /not set up/);
  await assert.rejects(requestUpdate(config, async () => new Response('', { status: 401 })), /rejected the token/);
  await assert.rejects(requestUpdate(config, async () => { throw new Error('ECONNREFUSED'); }), /Could not reach Watchtower: ECONNREFUSED/);
});

test('restart exits with code 0 after the delay', async () => {
  const codes: number[] = [];
  scheduleRestart(5, (c) => codes.push(c));
  assert.deepEqual(codes, []);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(codes, [0]);
});
