import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ApiClient } from '../src/warframe/fetch.js';
import {
  type ArbitrationData,
  ArbitrationSchedule,
  SCHEDULE_URL,
  TIERS_URL,
  arbitrationView,
  atLeast,
  loadArbitrations,
  nodeInfo,
  parseTiers,
  resetArbitrations,
  slotAt,
} from '../src/warframe/arbitrations.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const HOUR = 3_600_000;
/** 2026-11-08 18:00 UTC, an hour boundary. */
const T0 = Date.UTC(2026, 10, 8, 18);
const NODES = ['SolNode195', 'SolNode23', 'ClanNode0', 'SolNode85', 'SolNode999'];

/** `hours` hourly lines from T0, cycling through NODES, in the file's format. */
const scheduleText = (hours: number, from = T0) =>
  Array.from({ length: hours }, (_, i) => `${(from + i * HOUR) / 1000},${NODES[i % NODES.length]}`).join('\n') + '\n';

const TIERS_JS = 'window.arbyTiers = {\nSolNode23: "S",\nSolNode195: "C",\nClanNode0: \'B\',\nSolNode85: "D",\n};\n';
const tiers = parseTiers(TIERS_JS);
const data = (hours = 200): ArbitrationData => ({ schedule: ArbitrationSchedule.parse(scheduleText(hours)), tiers, stale: false, fetchedAt: T0 });

const arbWs = (node: string, start = T0, end = T0 + HOUR) =>
  ({ arbitration: { node, type: 'Defense', enemy: 'Grineer', activation: new Date(start).toISOString(), expiry: new Date(end).toISOString() } }) as unknown as WorldState;

describe('arbitration schedule', () => {
  it('reads the tier list and orders the tiers', () => {
    assert.equal(tiers.size, 4);
    assert.equal(tiers.get('SolNode23'), 'S');
    assert.equal(tiers.get('ClanNode0'), 'B');
    assert.ok(atLeast('S', 'A') && atLeast('A', 'A') && !atLeast('B', 'A') && atLeast('F', 'F'));
  });

  it('names nodes from the node table, without the "Dark Sector" prefix', () => {
    assert.deepEqual(nodeInfo('SolNode195'), { node: 'Hydron (Sedna)', name: 'Hydron', planet: 'Sedna', mission: 'Defense', faction: 'Grineer' });
    assert.equal(nodeInfo('ClanNode0').mission, 'Defense', 'a dark sector Defense is a Defense');
    assert.deepEqual(nodeInfo('NoSuchNode', {}), { node: 'NoSuchNode', name: 'NoSuchNode', planet: '', mission: 'Unknown', faction: '' });
  });

  it('lists the slot running now first, then every hour, with F for nodes the tier list does not rank', () => {
    // Lines out of order and noise in between are fine.
    const text = ['# comment', `${(T0 + HOUR) / 1000},SolNode23`, 'garbage', `${T0 / 1000},SolNode195`, `${(T0 + 2 * HOUR) / 1000},SolNode999`].join('\n');
    const schedule = ArbitrationSchedule.parse(text);
    assert.equal(schedule.size, 3);
    assert.equal(schedule.lastStart, T0 + 2 * HOUR);
    const slots = schedule.slots(T0 + 30 * 60_000, T0 + 3 * HOUR, tiers);
    assert.deepEqual(
      slots.map((s) => [s.nodeKey, s.tier, s.start - T0, s.end - T0]),
      [
        ['SolNode195', 'C', 0, HOUR],
        ['SolNode23', 'S', HOUR, 2 * HOUR],
        ['SolNode999', 'F', 2 * HOUR, 3 * HOUR],
      ],
    );
    assert.equal(slots[1]!.node, 'Cytherean (Venus)');
    assert.deepEqual(schedule.slots(T0 - 5 * HOUR, T0 - HOUR, tiers), [], 'nothing before the first hour');
    assert.deepEqual(schedule.slots(T0 + 4 * HOUR, T0 + 5 * HOUR, tiers), [], 'nothing after the last hour ends');
  });

  it('never stretches one slot over a gap in the file', () => {
    const schedule = ArbitrationSchedule.parse(`${T0 / 1000},SolNode23\n${(T0 + 5 * HOUR) / 1000},SolNode195\n`);
    const [first, second] = schedule.slots(T0, T0 + 6 * HOUR, tiers);
    assert.equal(first!.end, T0 + HOUR);
    assert.equal(second!.start, T0 + 5 * HOUR);
    assert.equal(slotAt({ schedule, tiers, stale: false, fetchedAt: 0 }, T0 + 2 * HOUR), null, 'no slot in the gap');
    assert.equal(slotAt({ schedule, tiers, stale: false, fetchedAt: 0 }, T0 + 10 * 60_000)?.nodeKey, 'SolNode23');
  });
});

describe('arbitration view', () => {
  it('shows now, the next 48 hours and the best of the week from the schedule', () => {
    const view = arbitrationView(data(), null, T0 + 10 * 60_000);
    assert.equal(view.current?.nodeKey, 'SolNode195');
    assert.equal(view.upcoming.length, 48);
    assert.equal(view.upcoming[0]!.start, T0 + HOUR);
    assert.ok(view.scheduleTrusted);
    // Every fifth hour is SolNode23 (S): hours 1, 6, 11, ... within 7 days.
    assert.ok(view.best.length > 0 && view.best.every((s) => s.tier === 'S' && s.start > T0));
    assert.equal(view.best.length, Math.ceil((7 * 24 - 1) / 5));
    const withB = arbitrationView(data(), null, T0 + 10 * 60_000, { bestTier: 'B', bestDays: 1 });
    assert.ok(withB.best.some((s) => s.tier === 'B') && withB.best.every((s) => atLeast(s.tier, 'B')));
  });

  it('trusts the schedule when the world state names the same node, and shows only the live one when it does not', () => {
    const agree = arbitrationView(data(), arbWs('Hydron (Sedna)'), T0 + 60_000);
    assert.ok(agree.scheduleTrusted);
    assert.equal(agree.current?.tier, 'C');
    assert.equal(agree.upcoming.length, 48);

    const other = arbitrationView(data(), arbWs('Cytherean (Venus)'), T0 + 60_000);
    assert.equal(other.scheduleTrusted, false);
    assert.equal(other.current?.node, 'Cytherean (Venus)');
    assert.equal(other.current?.mission, 'Defense');
    assert.deepEqual(other.upcoming, []);
    assert.deepEqual(other.best, []);

    // The feed's placeholder when none is running (SolNode000, 1970) is no evidence either way.
    const placeholder = { arbitration: { node: 'SolNode000', activation: '1970-01-01T00:00:00.000Z', expiry: '1970-01-01T00:00:00.000Z', expired: true } } as unknown as WorldState;
    assert.ok(arbitrationView(data(), placeholder, T0 + 60_000).scheduleTrusted);
  });

  it('falls back to the world state when there is no schedule', () => {
    const view = arbitrationView(null, arbWs('Hydron (Sedna)'), T0 + 60_000);
    assert.equal(view.current?.node, 'Hydron (Sedna)');
    assert.equal(view.scheduleTrusted, false);
    assert.deepEqual(arbitrationView(null, null, T0), { current: null, upcoming: [], best: [], scheduleTrusted: false, stale: false });
  });
});

describe('loading the schedule', () => {
  beforeEach(() => resetArbitrations());

  /** A browse.wf that serves the two files (or fails); counts requests per URL. */
  function fakeHost(files: Record<string, string | 'down'>) {
    const hits: Record<string, number> = {};
    let now = T0;
    const client = new ApiClient({
      now: () => now,
      sleep: async () => {},
      random: () => 0.5,
      log: () => {},
      warn: () => {},
      fetch: async (url: string, init: RequestInit) => {
        hits[url] = (hits[url] ?? 0) + 1;
        const body = files[url];
        if (body === undefined) return new Response('not found', { status: 404 });
        if (body === 'down') throw new Error('connect ECONNREFUSED');
        const etag = `"${body.length}"`;
        if ((init.headers as Record<string, string>)['If-None-Match'] === etag) return new Response(null, { status: 304 });
        return new Response(body, { status: 200, headers: { etag } });
      },
    });
    client.configure({ limits: { maxRetries: 0 } });
    return { client, hits, files, advance: (ms: number) => (now += ms) };
  }

  it('reads and parses both files once, then serves them from the cache', async () => {
    const host = fakeHost({ [SCHEDULE_URL]: scheduleText(1500), [TIERS_URL]: TIERS_JS });
    const first = await loadArbitrations(host.client);
    assert.equal(first?.schedule.size, 1500);
    assert.equal(first?.tiers.get('SolNode23'), 'S');
    assert.equal(first?.stale, false);
    const again = await loadArbitrations(host.client);
    assert.equal(again?.schedule, first?.schedule, 'not parsed again');
    assert.deepEqual(host.hits, { [SCHEDULE_URL]: 1, [TIERS_URL]: 1 });
    // Half a day later it is revalidated (a 304) and still not parsed again.
    host.advance(13 * HOUR);
    const later = await loadArbitrations(host.client);
    assert.equal(later?.schedule, first?.schedule);
    assert.equal(host.hits[SCHEDULE_URL], 2);
  });

  it('keeps a good schedule when the host sends something else, and says when it is serving an old copy', async () => {
    const host = fakeHost({ [SCHEDULE_URL]: scheduleText(1500), [TIERS_URL]: TIERS_JS });
    const good = await loadArbitrations(host.client);
    host.files[SCHEDULE_URL] = '<html>Something went wrong</html>';
    host.advance(13 * HOUR);
    const afterJunk = await loadArbitrations(host.client);
    assert.equal(afterJunk?.schedule, good?.schedule, 'a page that is not the schedule does not replace it');
    host.files[SCHEDULE_URL] = 'down';
    host.advance(13 * HOUR);
    const down = await loadArbitrations(host.client);
    assert.ok(down, 'the cached copy is served');
    assert.equal(down?.stale, true);
  });

  it('is null when the schedule was never read', async () => {
    const host = fakeHost({ [SCHEDULE_URL]: 'down', [TIERS_URL]: TIERS_JS });
    assert.equal(await loadArbitrations(host.client), null);
  });
});
