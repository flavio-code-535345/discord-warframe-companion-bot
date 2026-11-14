import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type TrackerSpec, collectTrackables, describeTracker, matchTracker } from '../src/trackers.js';
import { rankItems, relicBaseName } from '../src/warframe/items.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const now = Date.now();
const later = new Date(now + 3_600_000);

const ws = {
  invasions: [
    {
      id: 'i1', completed: false, node: 'Pallas (Ceres)', desc: 'Corpus Siege', vsInfestation: false,
      attacker: { faction: 'Corpus', reward: { countedItems: [{ count: 1, type: 'Orokin Catalyst Blueprint' }] } },
      defender: { faction: 'Grineer', reward: { countedItems: [{ count: 3, type: 'Fieldron' }] } },
    },
  ],
  alerts: [],
  dailyDeals: [{ id: 'd1', item: 'Mire', salePrice: 45, discount: 70, expiry: later }],
  events: [],
  fissures: [
    { id: 'f1', tier: 'Axi', missionType: 'Disruption', isHard: true, isStorm: false, node: 'Apollo (Lua)', enemy: 'Corrupted', expiry: later },
    { id: 'f2', tier: 'Lith', missionType: 'Capture', isHard: false, isStorm: false, node: 'Mantle (Earth)', enemy: 'Grineer', expiry: later },
  ],
  cetusCycle: { isDay: false, expiry: later },
  vallisCycle: { isWarm: true, expiry: later },
  cambionCycle: { state: 'vome', expiry: later },
  zarimanCycle: { state: 'corpus', expiry: later },
  earthCycle: { isDay: true, expiry: later },
  duviriCycle: { state: 'joy', expiry: later },
} as unknown as WorldState;

const keysFor = (spec: TrackerSpec) =>
  collectTrackables(ws, now)
    .filter((t) => matchTracker(spec, t) !== null)
    .map((t) => t.key);

test('reward trackers match keywords across invasions and deals, case-insensitively', () => {
  assert.deepEqual(keysFor({ kind: 'reward', keyword: 'orokin catalyst' }), ['invasion:i1']);
  assert.deepEqual(keysFor({ kind: 'reward', keyword: 'Mire' }), ['deal:d1']);
  assert.deepEqual(keysFor({ kind: 'reward', keyword: 'Nitain' }), []);
  const hit = collectTrackables(ws, now).find((t) => t.key === 'invasion:i1')!;
  assert.deepEqual(matchTracker({ kind: 'reward', keyword: 'catalyst' }, hit), ['Orokin Catalyst Blueprint']);
});

test('fissure trackers combine tier, mission (with aliases) and Steel Path filters', () => {
  assert.deepEqual(keysFor({ kind: 'fissure', tier: 'Axi', mission: 'Disruption', steelPath: true }), ['fissure:f1']);
  assert.deepEqual(keysFor({ kind: 'fissure', tier: 'Axi', steelPath: false }), []);
  assert.deepEqual(keysFor({ kind: 'fissure', mission: 'capture' }), ['fissure:f2']);
});

test('cycle trackers match only the current state, keyed per rotation', () => {
  const keys = keysFor({ kind: 'cycle', cycle: 'cetus', state: 'night' });
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /^cycle:cetus:night:\d+$/);
  assert.deepEqual(keysFor({ kind: 'cycle', cycle: 'cetus', state: 'day' }), []);
  assert.equal(keysFor({ kind: 'cycle', cycle: 'duviri', state: 'joy' }).length, 1);
});

test('baro tracker stays quiet while Baro is away', () => {
  assert.deepEqual(keysFor({ kind: 'baro' }), []);
});

test('incarnon trackers match this week\'s Steel Path Circuit choices, one key per rotation', () => {
  const week = (hard: string[]) =>
    ({ ...ws, duviriCycle: { state: 'joy', expiry: later, choices: [{ category: 'normal', choices: ['Ash'] }, { category: 'hard', choices: hard }] } }) as unknown as WorldState;
  const a = collectTrackables(week(['Soma', 'Braton', 'Kunai']), now);
  const spec: TrackerSpec = { kind: 'incarnon', weapon: 'soma' };
  const hit = a.find((t) => matchTracker(spec, t) !== null)!;
  assert.equal(hit.key, 'incarnon:Soma,Braton,Kunai');
  assert.deepEqual(matchTracker(spec, hit), ['Soma']);
  // A Warframe in the normal Circuit is not an Incarnon weapon, and another weapon does not match.
  assert.equal(a.filter((t) => matchTracker({ kind: 'incarnon', weapon: 'Ash' }, t) !== null).length, 0);
  assert.equal(a.filter((t) => matchTracker({ kind: 'incarnon', weapon: 'Boltor' }, t) !== null).length, 0);
  assert.equal(a.filter((t) => matchTracker({ kind: 'incarnon', weapon: ' ' }, t) !== null).length, 0);
  // The next week has another key, so the DM is sent again once per appearance.
  const b = collectTrackables(week(['Soma', 'Boltor']), now).find((t) => matchTracker(spec, t) !== null)!;
  assert.notEqual(b.key, hit.key);
  assert.equal(describeTracker(spec), 'soma Incarnon in the Steel Path Circuit');
});

test('describeTracker reads naturally', () => {
  assert.equal(describeTracker({ kind: 'cycle', cycle: 'cetus', state: 'night' }), 'Cetus night');
  assert.equal(describeTracker({ kind: 'fissure', tier: 'Axi', mission: 'Disruption', steelPath: true }), 'Axi Disruption fissure (Steel Path)');
});

test('relicBaseName normalises refinements and the word Relic', () => {
  assert.equal(relicBaseName('neo n16'), 'Neo N16');
  assert.equal(relicBaseName('Axi A1 Radiant'), 'Axi A1');
  assert.equal(relicBaseName('Lith G1 Relic'), 'Lith G1');
  assert.equal(relicBaseName('Wisp Prime'), null);
});

test('rankItems prefers exact names and gameplay items over cosmetics', () => {
  const items = [
    { name: 'Bramma Skin', category: 'Skins' },
    { name: 'Kuva Bramma', category: 'Primary' },
    { name: 'Bramma', category: 'Primary' },
  ];
  assert.deepEqual(rankItems(items, 'bramma').map((i) => i.name), ['Bramma', 'Kuva Bramma', 'Bramma Skin']);
});

test('tracker dropdowns: menus of at most 25 options carry what the handler needs, and a pick builds the tracker', async () => {
  const { ANY, pickRows, pickerSpec, isPicker } = await import('../src/discord/track-pick.js');
  const choices = Array.from({ length: 60 }, (_, i) => ({ label: `Weapon ${i}`, value: `Weapon ${i}` }));
  const rows = pickRows('incarnon', choices).map((r) => r.toJSON().components[0] as { custom_id: string; options: unknown[] });
  assert.deepEqual(rows.map((r) => r.options.length), [25, 25, 10]);
  assert.deepEqual(rows.map((r) => r.custom_id), ['trackpick:incarnon:0', 'trackpick:incarnon:1', 'trackpick:incarnon:2']);
  assert.deepEqual(pickerSpec('incarnon', 'Soma'), { kind: 'incarnon', weapon: 'Soma' });
  assert.deepEqual(pickerSpec('squads', ANY), { kind: 'squad' });
  assert.deepEqual(pickerSpec('sortie', 'Spy'), { kind: 'sortie', mission: 'Spy' });
  assert.deepEqual(pickerSpec('arbitration', 'Defense'), { kind: 'arbitration', type: 'Defense' });
  assert.equal(isPicker('price'), false);
});
