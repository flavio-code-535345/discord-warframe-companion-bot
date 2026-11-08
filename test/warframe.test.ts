import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupDrops } from '../src/warframe/drops.js';
import { searchItems } from '../src/warframe/market.js';
import { type Fissure, type WorldState, filterFissures, isNotableReward, rewardText } from '../src/warframe/worldstate.js';

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
  assert.equal(rewardText({ countedItems: [{ count: 3, type: 'Fieldron' }], items: ['Orokin Catalyst'], credits: 5000 }), '3 Fieldron, Orokin Catalyst, 5,000 cr');
  assert.equal(rewardText(undefined), '—');
  assert.equal(rewardText({ countedItems: [{ count: 1, type: 'Pumpkin Dangle' }], items: ['Pumpkin Dangle', 'Glyph'] }), 'Pumpkin Dangle, Glyph');
});

test('a big Kuva payout is worth an alert, a small one is not', () => {
  assert.equal(isNotableReward('200,000 Kuva, 10,000 cr'), true);
  assert.equal(isNotableReward('100,000 Kuva'), true);
  assert.equal(isNotableReward('20,000 Kuva, 10,000 cr'), false);
  assert.equal(isNotableReward('Kuva Brakk Blueprint'), false);
  assert.equal(isNotableReward('3 Forma, 10,000 cr'), true);
  assert.equal(isNotableReward('Nitain Extract'), true);
  assert.equal(isNotableReward('50 Moonflesh, 17,000 cr'), false);
});
