import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectAlerts } from '../src/discord/notifier.js';
import { groupDrops } from '../src/warframe/drops.js';
import { searchItems } from '../src/warframe/market.js';
import { type Fissure, type WorldState, filterFissures, rewardText } from '../src/warframe/worldstate.js';

test('searchItems ranks exact, prefix, word-prefix, then substring matches', () => {
  const items = [
    { slug: 'primed_flow', name: 'Primed Flow' },
    { slug: 'flow', name: 'Flow' },
    { slug: 'overflow', name: 'Overflow' },
    { slug: 'flow_state', name: 'Flow State' },
  ];
  assert.deepEqual(searchItems(items, 'flow').map((i) => i.slug), ['flow', 'flow_state', 'primed_flow', 'overflow']);
  assert.equal(searchItems(items, 'primed_flow')[0]?.slug, 'primed_flow');
  assert.equal(searchItems(items, 'zzz').length, 0);
});

test('groupDrops groups per item, exact match first, best chance first', () => {
  const groups = groupDrops(
    [
      { place: 'A', item: 'Forma Blueprint', rarity: 'Rare', chance: 2 },
      { place: 'B', item: 'Forma', rarity: 'Legendary', chance: 0.5 },
      { place: 'C', item: 'Forma', rarity: 'Rare', chance: 5 },
    ],
    'forma',
    8,
    5,
  );
  assert.deepEqual(groups.map((g) => g.item), ['Forma', 'Forma Blueprint']);
  assert.deepEqual(groups[0]!.locations.map((l) => l.place), ['C', 'B']);
});

test('filterFissures filters by tier/steel path and drops expired ones', () => {
  const now = Date.now();
  const f = (tier: string, tierNum: number, isHard: boolean, expiresIn: number) =>
    ({ tier, tierNum, isHard, isStorm: false, expiry: new Date(now + expiresIn) }) as unknown as Fissure;
  const list = [f('Axi', 4, false, 60_000), f('Lith', 1, true, 60_000), f('Lith', 1, false, -1), f('Meso', 2, false, 60_000)];
  assert.deepEqual(filterFissures(list, {}, now).map((x) => x.tier), ['Lith', 'Meso', 'Axi']);
  assert.deepEqual(filterFissures(list, { tier: 'lith' }, now).map((x) => x.isHard), [true]);
  assert.equal(filterFissures(list, { steelPath: false }, now).length, 2);
});

test('rewardText formats counted items, items and credits', () => {
  assert.equal(rewardText({ countedItems: [{ count: 3, type: 'Fieldron' }], items: ['Orokin Catalyst'], credits: 5000 }), '3x Fieldron, Orokin Catalyst, 5,000 cr');
  assert.equal(rewardText(undefined), '—');
  assert.equal(rewardText({ countedItems: [{ count: 1, type: 'Pumpkin Dangle' }], items: ['Pumpkin Dangle', 'Glyph'] }), '1x Pumpkin Dangle, Glyph');
});

test('collectAlerts emits stable keys for sortie, Baro and notable invasions only', () => {
  const now = Date.now();
  const future = new Date(now + 3_600_000);
  const ws = {
    sortie: { id: 's1', expiry: future, variants: [] },
    archonHunt: undefined,
    voidTrader: { id: 'b1', activation: new Date(now - 1000), expiry: future, location: 'Relay', inventory: [{ item: 'Primed Flow', ducats: 300, credits: 100000 }] },
    steelPath: undefined,
    alerts: [],
    invasions: [
      { id: 'i1', completed: false, node: 'N', desc: 'D', vsInfestation: false, completion: 50, attacker: { faction: 'Grineer', reward: { items: ['Orokin Reactor Blueprint'] } }, defender: { faction: 'Corpus', reward: { countedItems: [{ count: 3, type: 'Fieldron' }] } } },
      { id: 'i2', completed: false, node: 'N', desc: 'D', vsInfestation: false, completion: 50, attacker: { faction: 'Grineer', reward: { countedItems: [{ count: 3, type: 'Mutagen Mass' }] } }, defender: { faction: 'Corpus', reward: { countedItems: [{ count: 3, type: 'Fieldron' }] } } },
    ],
  } as unknown as WorldState;
  assert.deepEqual(collectAlerts(ws, now).map((a) => a.key), ['sortie:s1', `baro:b1:${now - 1000}`, 'invasion:i1']);
});
