import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanQuestion, detectIntent } from '../src/answers/intent.js';
import { titleCandidates } from '../src/warframe/wiki.js';

const cases: [string, ReturnType<typeof detectIntent>][] = [
  ['hi', { kind: 'help' }],
  ['what can you do?', { kind: 'help' }],
  ['price of arcane energize', { kind: 'price', item: 'arcane energize' }],
  ['how much is wisp prime set worth?', { kind: 'price', item: 'wisp prime set' }],
  ['what is a neo n16 relic worth', { kind: 'price', item: 'neo n16 relic' }],
  ['pc primed flow', { kind: 'price', item: 'primed flow' }],
  ['condition overload price', { kind: 'price', item: 'condition overload' }],
  ['where does neo n16 drop?', { kind: 'relic', name: 'Neo N16' }],
  ['where do i farm forma', { kind: 'drops', item: 'forma' }],
  ['how do I get condition overload?', { kind: 'drops', item: 'condition overload' }],
  ['what drops nitain extract', { kind: 'drops', item: 'nitain extract' }],
  ['orokin cell drop locations', { kind: 'drops', item: 'orokin cell' }],
  ['what is in axi a1', { kind: 'relic', name: 'Axi A1' }],
  ['entrati bounties', { kind: 'bounties', syndicate: 'Entrati' }],
  ['what are the bounties today', { kind: 'bounties', syndicate: null }],
  ['when is baro coming?', { kind: 'world', view: 'baro' }],
  ['what is varzia selling', { kind: 'world', view: 'resurgence' }],
  ["what's today's sortie", { kind: 'world', view: 'sortie' }],
  ['archon hunt this week', { kind: 'world', view: 'archon' }],
  ["what's teshin offering", { kind: 'world', view: 'steelpath' }],
  ['nightwave challenges', { kind: 'world', view: 'nightwave' }],
  ['any good invasions?', { kind: 'world', view: 'invasions' }],
  ["what's darvo selling", { kind: 'world', view: 'deals' }],
  ['deep archimedea this week', { kind: 'world', view: 'archimedea' }],
  ['any events running?', { kind: 'world', view: 'events' }],
  ['is it night on cetus', { kind: 'world', view: 'cycles' }],
  ['eidolons up?', { kind: 'world', view: 'cycles' }],
  ['steel path axi fissures', { kind: 'fissures', tier: 'Axi', steelPath: true, storm: undefined }],
  ['when is our next clan event', { kind: 'clanEvents' }],
  ['build for wisp prime', { kind: 'build', item: 'wisp prime' }],
  ['kuva bramma build', { kind: 'build', item: 'kuva bramma' }],
  ['stats of kuva bramma', { kind: 'item', name: 'kuva bramma' }],
  ['wisp prime', { kind: 'item', name: 'wisp prime' }],
  ['how do archon shards work?', { kind: 'wiki', query: 'archon shards' }],
];

for (const [question, expected] of cases) {
  test(`detectIntent: "${question}"`, () => assert.deepEqual(detectIntent(question), expected));
}

test('cleanQuestion drops filler words', () => {
  assert.equal(cleanQuestion('what is the best way to level my mastery rank'), 'level mastery rank');
});

test('titleCandidates tries longer phrases first and singular forms', () => {
  assert.deepEqual(titleCandidates('archon shards'), ['Archon Shards', 'Archon Shard', 'Archon', 'Shards', 'Shard']);
});
