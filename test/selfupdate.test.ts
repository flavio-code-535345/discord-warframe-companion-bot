import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRestart, requestUpdate, scheduleRestart } from '../src/selfupdate.js';

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

test('restart runs the registered shutdown first, and still exits when it fails or hangs', async () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const order: string[] = [];
  try {
    onRestart(async () => {
      order.push('shutdown');
    });
    scheduleRestart(1, (c) => order.push(`exit ${c}`), 50);
    await wait(40);
    assert.deepEqual(order, ['shutdown', 'exit 0']);

    order.length = 0;
    onRestart(() => new Promise<void>(() => {}));
    scheduleRestart(1, (c) => order.push(`exit ${c}`), 20);
    await wait(80);
    assert.deepEqual(order, ['exit 0'], 'a shutdown that never finishes must not block the restart');

    order.length = 0;
    onRestart(async () => {
      throw new Error('boom');
    });
    scheduleRestart(1, (c) => order.push(`exit ${c}`), 50);
    await wait(40);
    assert.deepEqual(order, ['exit 0'], 'a failing shutdown must not block the restart');
  } finally {
    onRestart(null);
  }
});
