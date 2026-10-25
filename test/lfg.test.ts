import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store, type LfgPost } from '../src/db.js';
import { parseDuration, sweepAction, validImageUrl } from '../src/lfg/lifecycle.js';

const GRACE = 5 * 60_000;
const NOW = 1_000_000_000;

const post = (over: Partial<LfgPost> = {}): LfgPost => ({
  id: 1,
  guildId: 'g',
  channelId: 'c',
  messageId: 'm',
  hostId: 'host',
  activity: 'Eidolon hunt',
  details: null,
  size: 4,
  closed: false,
  createdAt: NOW - 60_000,
  voiceChannelId: 'vc',
  expiresAt: null,
  hostAbsentSince: NOW - 60_000,
  ...over,
});

test('an open squad with its host in voice is left alone, and a returning host clears the timer', () => {
  assert.deepEqual(sweepAction(post({ hostAbsentSince: null }), ['host', 'a'], NOW, GRACE), { kind: 'none' });
  assert.deepEqual(sweepAction(post(), ['host'], NOW, GRACE), { kind: 'host-present' });
});

test('a host out of voice gets the grace period, then the squad closes', () => {
  assert.deepEqual(sweepAction(post({ hostAbsentSince: NOW - GRACE + 1000 }), ['someone'], NOW, GRACE), { kind: 'none' });
  assert.deepEqual(sweepAction(post({ hostAbsentSince: NOW - GRACE }), [], NOW, GRACE), { kind: 'close', reason: 'the host was not in voice' });
  // The first time the host is seen missing, the clock starts now.
  assert.deepEqual(sweepAction(post({ hostAbsentSince: null }), [], NOW, GRACE), { kind: 'host-absent', since: NOW });
});

test('an expired squad closes even while its host is in voice', () => {
  assert.deepEqual(sweepAction(post({ expiresAt: NOW - 1, hostAbsentSince: null }), ['host'], NOW, GRACE), { kind: 'close', reason: 'time ran out' });
  assert.deepEqual(sweepAction(post({ expiresAt: NOW + 1, hostAbsentSince: null }), ['host'], NOW, GRACE), { kind: 'none' });
});

test('a squad without voice only cares about its expiry', () => {
  assert.deepEqual(sweepAction(post({ voiceChannelId: null, hostAbsentSince: null }), null, NOW, GRACE), { kind: 'none' });
  assert.deepEqual(sweepAction(post({ voiceChannelId: null, expiresAt: NOW - 1 }), null, NOW, GRACE).kind, 'close');
});

test('a deleted voice channel is forgotten instead of closing the squad', () => {
  assert.deepEqual(sweepAction(post(), null, NOW, GRACE), { kind: 'clear-voice' });
  assert.deepEqual(sweepAction(post({ closed: true }), null, NOW, GRACE), { kind: 'clear-voice' });
});

test('a closed squad keeps its voice channel while people are in it, then deletes it', () => {
  assert.deepEqual(sweepAction(post({ closed: true }), ['a', 'b'], NOW, GRACE), { kind: 'none' });
  assert.deepEqual(sweepAction(post({ closed: true }), [], NOW, GRACE), { kind: 'delete-voice' });
  assert.deepEqual(sweepAction(post({ closed: true, voiceChannelId: null }), [], NOW, GRACE), { kind: 'none' });
});

test('parseDuration reads minutes, hours and days', () => {
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('2H'), 2 * 3_600_000);
  assert.equal(parseDuration(' 1d '), 86_400_000);
  for (const bad of ['', '0m', '10', 'soon', '5 minutes', '-5m']) assert.throws(() => parseDuration(bad), RangeError, bad);
});

test('validImageUrl accepts only plain https links', () => {
  assert.equal(validImageUrl(' https://example.com/a.png '), 'https://example.com/a.png');
  for (const bad of ['http://example.com/a.png', 'javascript:alert(1)', 'https://exa mple.com/a.png', 'not a url', '', `https://x.com/${'a'.repeat(1000)}`]) {
    assert.equal(validImageUrl(bad), null, bad);
  }
});

test('store: squads track their voice channel, expiry and host presence', () => {
  const store = new Store(':memory:');
  const p = store.createLfg({ guildId: 'g', channelId: 'c', hostId: 'host', activity: 'Sortie', details: null, size: 4 });
  assert.equal(p.voiceChannelId, null);
  assert.deepEqual(store.lfgForSweep(), []);

  store.setLfgVoice(p.id, 'vc1', 123);
  store.setLfgExpiry(p.id, 999);
  const open = store.getLfg(p.id)!;
  assert.deepEqual([open.voiceChannelId, open.hostAbsentSince, open.expiresAt], ['vc1', 123, 999]);
  assert.equal(store.openVoiceLfgByHost('g', 'host')?.id, p.id);
  assert.equal(store.openVoiceLfgByHost('g', 'other'), null);

  store.setLfgHostAbsent(p.id, null);
  assert.equal(store.getLfg(p.id)!.hostAbsentSince, null);

  store.closeLfg(p.id);
  assert.equal(store.openVoiceLfgByHost('g', 'host'), null);
  assert.equal(store.lfgForSweep().length, 1, 'a closed squad stays listed until its voice channel is deleted');
  store.setLfgVoice(p.id, null);
  assert.deepEqual(store.lfgForSweep(), []);
});

test('store: activities are case-insensitive and can be renamed', () => {
  const store = new Store(':memory:');
  store.saveActivity({ name: 'Eidolon hunt', imageUrl: 'https://example.com/e.png', roleId: 'r1', channelId: null });
  assert.equal(store.getActivity('eidolon HUNT')?.imageUrl, 'https://example.com/e.png');

  store.saveActivity({ name: 'Eidolon Hunt', imageUrl: null, roleId: 'r1', channelId: 'c1' });
  assert.equal(store.listActivities().length, 1);
  assert.equal(store.getActivity('eidolon hunt')?.name, 'Eidolon Hunt');

  store.saveActivity({ name: 'Eidolons', imageUrl: null, roleId: 'r1', channelId: 'c1' }, 'Eidolon Hunt');
  assert.deepEqual(store.listActivities().map((a) => a.name), ['Eidolons']);
  assert.equal(store.removeActivity('EIDOLONS'), true);
  assert.equal(store.removeActivity('Eidolons'), false);
});

test('store: squad voice settings round-trip', () => {
  const store = new Store(':memory:');
  store.updateSettings('g', { lfgVoiceCategoryId: 'cat', lfgVoiceGraceMinutes: 10 });
  assert.deepEqual([store.getSettings('g').lfgVoiceCategoryId, store.getSettings('g').lfgVoiceGraceMinutes], ['cat', 10]);
});
