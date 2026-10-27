import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { api } from '../src/warframe/fetch.js';
import { configureWorldState, feedUrlFor, getWorldState, usableFeedUrl, worldStateInfo } from '../src/warframe/worldstate.js';

const realFetch = globalThis.fetch;
beforeEach(() => {
  api.reset();
  api.configure({ limits: { minIntervalMs: 0 } });
});
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

  it('reads the parsed world state from warframestat.us and never calls Digital Extremes', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ timestamp: '2026-10-27T00:00:00.000Z', cetusCycle: { isDay: true, expiry: '2026-10-27T01:00:00.000Z' }, fissures: [] }), { status: 200 });
    }) as typeof fetch;
    configureWorldState({ enabled: true, platform: 'xbox', intervalSeconds: 600, store: new Store(':memory:') });
    const ws = await getWorldState();
    assert.equal(ws.cetusCycle.isDay, true);
    assert.deepEqual(urls, ['https://api.warframestat.us/xb1']);
    assert.ok(urls.every((u) => !u.includes('api.warframe.com')));
    assert.equal(feedUrlFor('pc'), 'https://api.warframestat.us/pc');
    assert.equal(feedUrlFor('switch'), 'https://api.warframestat.us/swi');
    assert.equal(feedUrlFor('mobile'), 'https://api.warframestat.us/pc');
  });

  it('refuses an answer that is not warframestat.us JSON (such as the raw DE feed)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ Events: [], Alerts: [], WorldSeed: 'abc' }), { status: 200 })) as typeof fetch;
    configureWorldState({ enabled: true, platform: 'pc', intervalSeconds: 600, store: new Store(':memory:') });
    await assert.rejects(getWorldState(), /Unexpected world state answer: api\.warframestat\.us\/pc answered JSON with the keys Events, Alerts, WorldSeed/);
    assert.equal(worldStateInfo().lastOk, false);
  });

  it('ignores a failure recorded for another source (an older version called DE)', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ cetusCycle: {}, fissures: [] }), { status: 200 });
    }) as typeof fetch;
    const store = new Store(':memory:');
    store.setMeta('worldstate_last_call', JSON.stringify({ at: Date.now(), ok: false, detail: 'HTTP 403', retryAt: Date.now() + 3_000_000 }));
    configureWorldState({ enabled: true, platform: 'pc', intervalSeconds: 600, store });
    await getWorldState();
    assert.equal(calls, 1);
    assert.equal(worldStateInfo().lastOk, true);
  });

  it('ignores a WORLDSTATE_URL that is a warframestat.us web page and uses the public API', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ cetusCycle: {}, fissures: [] }), { status: 200 });
    }) as typeof fetch;
    configureWorldState({ url: 'https://docs.warframestat.us/', enabled: true, platform: 'pc', intervalSeconds: 0, store: new Store(':memory:') });
    await getWorldState();
    assert.deepEqual(urls, ['https://api.warframestat.us/pc']);
    assert.equal(usableFeedUrl('https://hub.warframestat.us/'), null);
    assert.equal(usableFeedUrl('http://relay.lan:8080/pc'), 'http://relay.lan:8080/pc');
  });
});
