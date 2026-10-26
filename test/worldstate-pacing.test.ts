import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { configureWorldState, getWorldState, worldStateInfo } from '../src/warframe/worldstate.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('worldstate pacing', () => {
  it('makes no call while switched off', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    configureWorldState({ enabled: false });
    await assert.rejects(getWorldState(), /switched off/);
    assert.equal(calls, 0);
    assert.equal(worldStateInfo().enabled, false);
  });

  it('calls once, remembers the failure, and does not retry (even after a restart)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('', { status: 403 });
    }) as typeof fetch;
    const store = new Store(':memory:');
    configureWorldState({ enabled: true, intervalSeconds: 600, store });
    await assert.rejects(getWorldState(), /403/);
    await assert.rejects(getWorldState(), /403/);
    assert.equal(calls, 1);
    const info = worldStateInfo();
    assert.equal(info.lastOk, false);
    assert.match(info.lastDetail ?? '', /403/);
    assert.ok(info.lastCallAt && Date.now() - info.lastCallAt < 5000);

    // A restart reads the last call back from the database and still holds off.
    configureWorldState({ enabled: true, intervalSeconds: 600, store });
    await assert.rejects(getWorldState(), /403/);
    assert.equal(calls, 1);
  });
});
