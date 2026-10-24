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
  });
});

test('markSeen returns true only the first time', () => {
  const store = new Store(':memory:');
  assert.equal(store.seenCount(), 0);
  assert.equal(store.markSeen('sortie:1'), true);
  assert.equal(store.markSeen('sortie:1'), false);
  assert.equal(store.seenCount(), 1);
});
