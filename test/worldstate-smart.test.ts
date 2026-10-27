import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Store } from '../src/db.js';
import { api } from '../src/warframe/fetch.js';
import { type WorldState, configureWorldState, getWorldState, nextRefreshDelay, worldStateInfo } from '../src/warframe/worldstate.js';

const MIN = 60_000;
const T0 = Date.parse('2026-10-27T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** A minimal world state: only the parts the refresh planning looks at. */
const world = (over: Record<string, unknown> = {}): WorldState =>
  ({ cetusCycle: { isDay: true, expiry: at(60 * MIN) }, fissures: [], ...over }) as unknown as WorldState;

const opts = { minMs: 10 * MIN, maxMs: 60 * MIN };

describe('nextRefreshDelay', () => {
  it('waits for the soonest rollover, plus a short grace', () => {
    const ws = world({ alerts: [{ expiry: at(25 * MIN) }], sortie: { expiry: at(5 * 3_600_000) } });
    assert.equal(nextRefreshDelay(ws, T0, opts), 25 * MIN + 20_000);
  });

  it('never goes below the poll interval or above the cap', () => {
    assert.equal(nextRefreshDelay(world({ alerts: [{ expiry: at(2 * MIN) }] }), T0, opts), 10 * MIN, 'minimum gap');
    assert.equal(nextRefreshDelay(world({ sortie: { expiry: at(5 * 3_600_000) } }), T0, opts), 60 * MIN, 'cap');
    assert.equal(nextRefreshDelay(world(), T0, opts), 60 * MIN, 'nothing to wait for');
  });

  it('ignores fissures, which would keep it at the minimum all the time', () => {
    const ws = world({ fissures: [{ expiry: at(1 * MIN) }, { expiry: at(3 * MIN) }], alerts: [{ expiry: at(40 * MIN) }] });
    assert.equal(nextRefreshDelay(ws, T0, opts), 40 * MIN + 20_000);
  });

  it('looks at when Baro arrives while he is away, and when he leaves while he is here', () => {
    const away = world({ voidTrader: { activation: at(30 * MIN), expiry: at(2 * 24 * 60 * MIN) } });
    assert.equal(nextRefreshDelay(away, T0, opts), 30 * MIN + 20_000);
    const here = world({ voidTrader: { activation: at(-60 * MIN), expiry: at(45 * MIN) } });
    assert.equal(nextRefreshDelay(here, T0, opts), 45 * MIN + 20_000);
  });

  it('skips rollovers that have already passed and values that are not dates', () => {
    const ws = world({ alerts: [{ expiry: at(-5 * MIN) }, { expiry: 'garbage' }, {}], duviriCycle: { expiry: at(50 * MIN) } });
    assert.equal(nextRefreshDelay(ws, T0, opts), 50 * MIN + 20_000);
  });
});

describe('smart polling', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
    mock.timers.enable({ apis: ['Date'], now: T0 });
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(world({ alerts: [{ expiry: at(Date.now() - T0 + 25 * MIN) }] })), { status: 200 });
    }) as typeof fetch;
  });
  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  });

  const start = (smartPoll: boolean) =>
    configureWorldState({ enabled: true, platform: 'pc', intervalSeconds: 600, smartPoll, maxPollMinutes: 60, url: `http://relay.test/${smartPoll ? 'smart' : 'fixed'}/${Math.random()}`, store: new Store(':memory:') });

  it('keeps the answer until something is due to change, instead of every poll interval', async () => {
    start(true);
    await getWorldState();
    assert.equal(calls, 1);
    mock.timers.tick(15 * MIN);
    await getWorldState();
    assert.equal(calls, 1, 'a fixed timer would have called again after 10 minutes');
    assert.ok(worldStateInfo().smart);
    assert.equal(worldStateInfo().nextCallAt, T0 + 25 * MIN + 20_000);
    mock.timers.tick(11 * MIN);
    await getWorldState();
    assert.equal(calls, 2, 'the alert has ended, so it refreshes');
  });

  it('is the old fixed timer when switched off', async () => {
    start(false);
    await getWorldState();
    mock.timers.tick(11 * MIN);
    await getWorldState();
    assert.equal(calls, 2);
    assert.equal(worldStateInfo().smart, false);
  });
});
