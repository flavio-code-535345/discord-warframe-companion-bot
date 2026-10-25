import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';

const G = '111111111111111111';

test('members: upsert, lookup by IGN (case-insensitive), clash detection', () => {
  const store = new Store(':memory:');
  store.upsertMember({ guildId: G, userId: 'u1', ign: 'RatKing', masteryRank: 30, platform: 'PC' });
  store.upsertMember({ guildId: G, userId: 'u1', ign: 'RatKing', masteryRank: 31, platform: 'PC' });
  assert.equal(store.getMember(G, 'u1')?.masteryRank, 31);
  assert.equal(store.findMemberByIgn(G, 'ratking')?.userId, 'u1');
  assert.throws(
    () => store.upsertMember({ guildId: G, userId: 'u2', ign: 'RATKING', masteryRank: null, platform: null }),
    /already registered/,
  );
  assert.equal(store.listMembers(G).length, 1);
  assert.equal(store.removeMember(G, 'u1'), true);
  assert.equal(store.removeMember(G, 'u1'), false);
});

test('events: RSVPs, upcoming list, reminder window, cancellation', () => {
  const store = new Store(':memory:');
  const now = Date.now();
  const soon = store.createEvent({ guildId: G, title: 'Eidolons', description: null, startsAt: now + 10 * 60_000, createdBy: 'u1' });
  const later = store.createEvent({ guildId: G, title: 'Archon', description: null, startsAt: now + 86_400_000, createdBy: 'u1' });

  store.setRsvp(soon.id, 'u1', 'going');
  store.setRsvp(soon.id, 'u2', 'maybe');
  store.setRsvp(soon.id, 'u2', 'going');
  assert.deepEqual(store.getRsvps(soon.id), { going: ['u1', 'u2'], maybe: [], declined: [] });

  assert.deepEqual(store.upcomingEvents(G).map((e) => e.id), [soon.id, later.id]);
  assert.deepEqual(store.eventsDueForReminder(now, 15 * 60_000).map((e) => e.id), [soon.id]);
  store.markEventReminded(soon.id);
  assert.equal(store.eventsDueForReminder(now, 15 * 60_000).length, 0);

  store.cancelEvent(later.id);
  assert.deepEqual(store.upcomingEvents(G).map((e) => e.id), [soon.id]);
});

test('lfg: host auto-joins, join/leave, close', () => {
  const store = new Store(':memory:');
  const post = store.createLfg({ guildId: G, channelId: 'c1', hostId: 'host', activity: 'Netracells', details: null, size: 4 });
  store.joinLfg(post.id, 'a');
  store.joinLfg(post.id, 'a');
  assert.deepEqual(store.lfgMembers(post.id), ['host', 'a']);
  store.leaveLfg(post.id, 'a');
  assert.deepEqual(store.lfgMembers(post.id), ['host']);
  store.closeLfg(post.id);
  assert.equal(store.getLfg(post.id)?.closed, true);
});

test('settings: partial updates keep other fields', () => {
  const store = new Store(':memory:');
  store.updateSettings(G, { alertsChannelId: 'a', alertsRoleId: 'r' });
  store.updateSettings(G, { announcementsChannelId: 'b' });
  assert.deepEqual(store.getSettings(G), {
    guildId: G,
    alertsChannelId: 'a',
    alertsRoleId: 'r',
    announcementsChannelId: 'b',
    welcomeChannelId: null,
    chatChannelId: null,
    modLogChannelId: null,
    verifyChannelId: null,
    verifyPanelMessageId: null,
    verifyRoleId: null,
    verifyMinAccountAgeDays: null,
    honeypotChannelId: null,
    honeypotAction: null,
  });
  store.updateSettings(G, { verifyMinAccountAgeDays: 7 });
  assert.equal(store.getSettings(G).verifyMinAccountAgeDays, 7);
});

test('bot meta values round-trip and overwrite', () => {
  const store = new Store(':memory:');
  assert.equal(store.getMeta('avatar_sha256'), null);
  store.setMeta('avatar_sha256', 'a');
  store.setMeta('avatar_sha256', 'b');
  assert.equal(store.getMeta('avatar_sha256'), 'b');
});

test('markSeen returns true only the first time', () => {
  const store = new Store(':memory:');
  assert.equal(store.seenCount(), 0);
  assert.equal(store.markSeen('sortie:1'), true);
  assert.equal(store.markSeen('sortie:1'), false);
  assert.equal(store.seenCount(), 1);
});

test('trackers: create, list per user, delete only own', () => {
  const store = new Store(':memory:');
  const a = store.createTracker(G, 'u1', JSON.stringify({ kind: 'baro' }));
  store.createTracker(G, 'u2', JSON.stringify({ kind: 'reward', keyword: 'Nitain' }));
  assert.equal(store.listTrackers(G, 'u1').length, 1);
  assert.equal(store.listTrackers(G).length, 2);
  assert.equal(store.deleteTracker(G, 'u2', a.id), false);
  assert.equal(store.deleteTracker(G, 'u1', a.id), true);
  assert.equal(store.listTrackers(G, 'u1').length, 0);
});

test('warnings: add, list per user, clear', () => {
  const store = new Store(':memory:');
  store.addWarning({ guildId: G, userId: 'u1', moderatorId: 'm', reason: 'spam' });
  store.addWarning({ guildId: G, userId: 'u1', moderatorId: 'm', reason: 'again' });
  store.addWarning({ guildId: G, userId: 'u2', moderatorId: 'm', reason: 'other' });
  assert.deepEqual(store.listWarnings(G, 'u1').map((w) => w.reason), ['spam', 'again']);
  assert.equal(store.clearWarnings(G, 'u1'), 2);
  assert.equal(store.listWarnings(G, 'u1').length, 0);
  assert.equal(store.listWarnings(G, 'u2').length, 1);
});

test('channel locks round-trip once', () => {
  const store = new Store(':memory:');
  store.saveLock('c1', { everyone: 'neutral', verified: 'allow' });
  assert.equal(store.isLocked('c1'), true);
  assert.deepEqual(store.takeLock('c1'), { everyone: 'neutral', verified: 'allow' });
  assert.equal(store.isLocked('c1'), false);
  assert.deepEqual(store.takeLock('c1'), {});
});

test('backups: save, list newest first, fetch data, prune only automatic ones', () => {
  const store = new Store(':memory:');
  const t = Date.now();
  const manual = store.saveBackup({ guildId: G, label: 'before renovation', auto: false, summary: '{}', data: '{"v":0}', createdAt: t - 10_000 });
  for (let i = 0; i < 4; i++) store.saveBackup({ guildId: G, label: null, auto: true, summary: '{}', data: `{"v":${i + 1}}`, createdAt: t - 5_000 + i });
  assert.equal(store.listBackups(G).length, 5);
  assert.equal(store.listBackups(G)[0]!.auto, true);
  assert.equal(store.getBackupData(G, manual.id), '{"v":0}');
  assert.equal(store.getBackupData('other', manual.id), null);
  assert.equal(store.pruneAutoBackups(G, 2), 2);
  const left = store.listBackups(G);
  assert.equal(left.filter((b) => b.auto).length, 2);
  assert.ok(left.some((b) => b.id === manual.id));
  assert.equal(store.deleteBackup(G, manual.id), true);
});

test('panel admins and sessions: removal signs the admin out, expired sessions are ignored', () => {
  const store = new Store(':memory:');
  store.addPanelAdmin('a1', 'owner', 'clan officer');
  assert.equal(store.isPanelAdmin('a1'), true);
  store.createPanelSession({ id: 's1', userId: 'a1', username: 'Rat', avatar: null, csrf: 'c' }, 60_000);
  assert.equal(store.getPanelSession('s1')?.userId, 'a1');
  assert.equal(store.getPanelSession('s1', Date.now() + 120_000), null);
  assert.equal(store.removePanelAdmin('a1'), true);
  assert.equal(store.isPanelAdmin('a1'), false);
  assert.equal(store.getPanelSession('s1'), null);
});
