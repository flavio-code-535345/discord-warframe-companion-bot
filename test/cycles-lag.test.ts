import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { collectTrackables } from '../src/trackers.js';
import { ZARIMAN, projectCycles } from '../src/warframe/cycles.js';
import { api } from '../src/warframe/fetch.js';
import { type WorldState, configureWorldState, getWorldState, worldStateInfo, worldStateStaleNote } from '../src/warframe/worldstate.js';

const MIN = 60_000;

const cycles = (now: number, over: Record<string, unknown> = {}) =>
  ({
    cetusCycle: { isDay: true, expiry: new Date(now + 30 * MIN) },
    vallisCycle: { isWarm: true, expiry: new Date(now + 5 * MIN) },
    earthCycle: { isDay: true, expiry: new Date(now + 60 * MIN) },
    cambionCycle: { state: 'fass', expiry: new Date(now + 30 * MIN) },
    zarimanCycle: { state: 'grineer', isCorpus: false, expiry: new Date(now + 60 * MIN) },
    duviriCycle: { state: 'joy', expiry: new Date(now + 60 * MIN) },
    invasions: [], alerts: [], events: [], fissures: [], dailyDeals: [],
    ...over,
  }) as unknown as WorldState;

describe('Zariman projection', () => {
  const t0 = Date.parse('2026-10-27T03:41:00.000Z');
  it('flips between Grineer and Corpus every 150 minutes', () => {
    const ws = cycles(t0, { zarimanCycle: { state: 'grineer', isCorpus: false, expiry: new Date(t0) } });
    const a = projectCycles(ws, t0 + 10 * MIN).zariman;
    assert.deepEqual([a.state, a.expiry, a.projected], ['corpus', t0 + ZARIMAN.corpus, true]);
    const b = projectCycles(ws, t0 + 160 * MIN).zariman;
    assert.deepEqual([b.state, b.expiry], ['grineer', t0 + 2 * ZARIMAN.corpus]);
  });

  it('leaves a phase that has not ended alone', () => {
    const z = projectCycles(cycles(t0), t0).zariman;
    assert.deepEqual([z.state, z.projected], ['grineer', false]);
  });

  it('is also what the cycle trackers see, so they fire on time between polls', () => {
    const ws = cycles(t0, { cetusCycle: { isDay: true, expiry: new Date(t0 - 10 * MIN) }, zarimanCycle: { state: 'grineer', isCorpus: false, expiry: new Date(t0 - 5 * MIN) } });
    const items = collectTrackables(ws, t0);
    assert.ok(items.some((i) => i.title === 'Cetus: night'));
    assert.ok(items.some((i) => i.title === 'Zariman: corpus'));
    assert.ok(!items.some((i) => i.title === 'Cetus: day'));
  });

  it('gives a calculated expiry and the feed\'s own, a few milliseconds apart, the same tracker key', () => {
    const calculated = collectTrackables(cycles(t0, { earthCycle: { isDay: true, expiry: new Date(t0 - 1) } }), t0).find((i) => i.title === 'Earth: night')!;
    const real = collectTrackables(cycles(t0, { earthCycle: { isDay: false, expiry: new Date(t0 - 1 + 240 * MIN + 241) } }), t0).find((i) => i.title === 'Earth: night')!;
    assert.equal(calculated.key, real.key);
  });
});

describe('source lag note', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const serve = async (timestampAgoMs: number) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ...cycles(Date.now()), timestamp: new Date(Date.now() - timestampAgoMs).toISOString() }), { status: 200 })) as typeof fetch;
    configureWorldState({ enabled: true, intervalSeconds: 600, url: `http://relay.test/${Math.random()}`, store: new Store(':memory:') });
    await getWorldState();
  };

  it('warns when the source itself is serving old data', async () => {
    await serve(40 * MIN);
    const note = worldStateStaleNote();
    assert.match(note ?? '', /was serving data 40 min old/);
    assert.ok((worldStateInfo().sourceLagMs ?? 0) >= 40 * MIN);
  });

  it('says nothing when the source is current', async () => {
    await serve(3 * MIN);
    assert.equal(worldStateStaleNote(), null);
  });
});
