import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { type CardReading, type RoleInfo, checkClan, earnedNames, masteryRank, planRoles } from '../src/ssroles/roles.js';
import { parseReading, readProfileCard } from '../src/ssroles/vision.js';

const card = (over: Partial<CardReading> = {}): CardReading => ({
  is_profile_card: true,
  in_game_name: 'Flavio11113#108',
  mastery_rank_title: 'Legendary 2',
  mastery_rank_number: 2,
  mastery_points: '2,637,138',
  next_rank: 'Legendary 3',
  points_to_next_rank: '55,362',
  clan_name: 'The Rats Den 69',
  clan_tag: '043',
  clan_tier_rank: 'GHOST CLAN RANK 10',
  accolades: ['Ten Year Supporter'],
  emblem_matches_reference: true,
  clan_text_matches_reference: true,
  looks_edited_or_fake: false,
  notes: '',
  ...over,
});

const role = (id: string, name: string, position: number, over: Partial<RoleInfo> = {}): RoleInfo => ({ id, name, position, managed: false, dangerous: false, ...over });

test('mastery rank: Legendary N is 30 + N, plain ranks are themselves', () => {
  assert.equal(masteryRank({ mastery_rank_title: 'Legendary 3', mastery_rank_number: 3 }), 33);
  assert.equal(masteryRank({ mastery_rank_title: 'Grand Master', mastery_rank_number: 28 }), 28);
  assert.equal(masteryRank({ mastery_rank_title: 'MR 25', mastery_rank_number: null }), 25);
  assert.equal(masteryRank({ mastery_rank_title: null, mastery_rank_number: null }), null);
});

test('clan check: the clan name must match, ignoring punctuation and case', () => {
  assert.equal(checkClan(card(), "The Rat's Den 69", true).ok, true);
  const other = checkClan(card({ clan_name: 'Other Clan' }), 'The Rats Den 69', true);
  assert.equal(other.ok, false);
  assert.match(other.problems.join(' '), /Other Clan/);
});

test('clan check: with a reference card the emblem and text must match, and edits are refused', () => {
  assert.equal(checkClan(card({ emblem_matches_reference: false }), 'The Rats Den 69', true).ok, false);
  assert.equal(checkClan(card({ clan_text_matches_reference: null }), 'The Rats Den 69', true).ok, false);
  // The fallback reader can't compare the emblem (null), which is allowed.
  assert.equal(checkClan(card({ emblem_matches_reference: null }), 'The Rats Den 69', true).ok, true);
  assert.equal(checkClan(card({ looks_edited_or_fake: true }), 'The Rats Den 69', true).ok, false);
  assert.equal(checkClan(card({ is_profile_card: false }), 'The Rats Den 69', false).ok, false);
  assert.equal(checkClan(card({ emblem_matches_reference: null }), 'The Rats Den 69', false).ok, true);
});

test('roles: only existing, safe roles are added and the old rank role is replaced', () => {
  const roles = [
    role('1', 'MR 32', 5),
    role('2', 'MR 33', 5),
    role('3', '🐀 Clan', 5),
    role('4', 'Ten Year Supporter', 5),
    role('5', 'Legendary 2', 5),
    role('6', 'Level 30+', 5),
    role('7', 'Clan', 50), // above Ordis
  ];
  const r = card({ mastery_rank_title: 'Legendary 2' });
  const earned = earnedNames(r, masteryRank(r), 'The Rats Den 69');
  const plan = planRoles(roles, earned, new Set(['2']), 36);
  assert.deepEqual(plan.add.map((x) => x.name).sort(), ['Legendary 2', 'MR 32', 'Ten Year Supporter', '🐀 Clan'].sort());
  assert.deepEqual(plan.remove.map((x) => x.name), ['MR 33']);
  assert.deepEqual(plan.skipped.map((x) => x.name), ['Clan']);
});

test('roles: managed or moderator roles are never handed out', () => {
  const roles = [role('1', 'Clan', 5, { dangerous: true }), role('2', 'Ten Year Supporter', 5, { managed: true })];
  const plan = planRoles(roles, earnedNames(card(), 32, 'The Rats Den 69'), new Set(), 36);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.skipped.length, 2);
});

test('reading parses fenced JSON and tolerates junk', () => {
  const r = parseReading('```json\n{"is_profile_card": true, "mastery_rank_title": "Legendary 3", "clan_name": "The Rats Den 69", "clan_tag": "#043", "accolades": ["A", 5]}\n```');
  assert.equal(r?.mastery_rank_title, 'Legendary 3');
  assert.equal(r?.clan_tag, '043');
  assert.deepEqual(r?.accolades, ['A']);
  assert.equal(parseReading('no json here'), null);
});

test('vision call sends the submission as the only image', async () => {
  let content: any[] = [];
  const config = { FREE_AI_KEY: 'test-key-123', FREE_AI_URL: 'https://llm.example/v1', FREE_AI_MODEL: 'm' };
  const out = await readProfileCard(
    config,
    { mime: 'image/png', data: new Uint8Array([2]) },
    async (_url, init) => {
      content = JSON.parse(String(init.body)).messages[0].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"is_profile_card": true}' } }] }));
    },
  );
  assert.equal(out.is_profile_card, true);
  assert.equal(content.length, 2);
  assert.equal(content[1].image_url.url, 'data:image/png;base64,Ag==');
});

test('a screenshot or in-game name belongs to the first member who used it', () => {
  const store = new Store(':memory:');
  assert.equal(store.claimSs('g', 'ign', 'flavio11113108', 'u1'), null);
  assert.equal(store.claimSs('g', 'ign', 'flavio11113108', 'u1'), null);
  assert.equal(store.claimSs('g', 'ign', 'flavio11113108', 'u2'), 'u1');
  store.setSsReference('g', new Uint8Array([1, 2, 3]), 'The Rats Den 69#043');
  assert.deepEqual([...store.getSsReference('g')!.fingerprint], [1, 2, 3]);
  assert.equal(store.getSsReference('g')!.clanText, 'The Rats Den 69#043');
});
