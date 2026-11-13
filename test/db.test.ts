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
  store.updateSettings(G, { alertsChannelId: 'a', lfgChannelId: 'l' });
  store.updateSettings(G, { announcementsChannelId: 'b' });
  assert.deepEqual(store.getSettings(G), {
    guildId: G,
    alertsChannelId: 'a',
    lfgChannelId: 'l',
    announcementsChannelId: 'b',
    welcomeChannelId: null,
    chatChannelId: null,
    modLogChannelId: null,
    honeypotChannelId: null,
    honeypotAction: null,
    ssRolesChannelId: null,
    levelingOff: null,
    levelChannelId: null,
    auditLogChannelId: null,
    statusChannelId: null,
    rivenChannelId: null,
    lfgVoiceCategoryId: null,
    lfgVoiceGraceMinutes: null,
    autoVcHubChannelId: null,
    birthdayChannelId: null,
    weeklyChannelId: null,
    promoChannelId: null,
    newsChannelId: null,
    arbitrationsChannelId: null,
    fissuresChannelId: null,
    sortieChannelId: null,
    cyclesChannelId: null,
    tradersChannelId: null,
    invasionsChannelId: null,
  });
  store.updateSettings(G, { lfgVoiceGraceMinutes: 7 });
  assert.equal(store.getSettings(G).lfgVoiceGraceMinutes, 7);
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

/** The schema versions some migrations start from (how many migrations ran before them). */
const CACHE_REMOVAL = 25;
const PING_ROLES_REMOVAL = 37;

test('the ping roles move out of the settings into a note for the one-time conversion, and the squads channel setting arrives', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ordis-db-'));
  const file = join(dir, 'bot.db');
  try {
    new Store(file, { migrateTo: PING_ROLES_REMOVAL }).close();
    const raw = new DatabaseSync(file);
    raw.exec(
      "INSERT INTO guild_settings (guild_id, alerts_channel_id, alerts_role_id, arbitrations_role_id, baro_role_id, weekly_role_id, events_role_id, lfg_role_id) VALUES ('g1', 'c-alerts', 'r-alerts', 'r-arby', 'r-baro', 'r-weekly', 'r-events', 'r-squads')",
    );
    // A second server that never had a ping role gets no note.
    raw.exec("INSERT INTO guild_settings (guild_id, alerts_channel_id) VALUES ('g2', 'c2')");
    raw.exec("INSERT INTO activities (name, image_url, role_id, channel_id) VALUES ('Eidolon hunt', 'https://x.test/e.png', 'r-eidolon', 'c-lfg')");
    raw.close();

    const store = new Store(file);
    assert.deepEqual(JSON.parse(store.getMeta('legacy_ping_roles:g1') ?? 'null'), {
      alerts: 'r-alerts',
      arbitrations: 'r-arby',
      baro: 'r-baro',
      weekly: 'r-weekly',
      events: 'r-events',
      squads: 'r-squads',
    });
    assert.equal(store.getMeta('legacy_ping_roles:g2'), null);
    const settings = store.getSettings('g1') as unknown as Record<string, unknown>;
    assert.equal(settings.alertsChannelId, 'c-alerts', 'the channels stay');
    assert.equal(settings.lfgChannelId, null);
    for (const gone of ['alertsRoleId', 'arbitrationsRoleId', 'baroRoleId', 'weeklyRoleId', 'eventsRoleId', 'lfgRoleId']) assert.ok(!(gone in settings), gone);
    assert.deepEqual(store.getActivity('eidolon hunt'), { name: 'Eidolon hunt', imageUrl: 'https://x.test/e.png', channelId: 'c-lfg' });
    store.updateSettings('g1', { lfgChannelId: 'c-lfg' });
    assert.equal(store.getSettings('g1').lfgChannelId, 'c-lfg');
    store.close();

    const check = new DatabaseSync(file);
    const cols = (check.prepare('PRAGMA table_info(guild_settings)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.some((c) => c.endsWith('_role_id')), `no role column is left, got ${cols.filter((c) => c.endsWith('_role_id')).join(', ')}`);
    assert.ok(!(check.prepare('PRAGMA table_info(activities)').all() as { name: string }[]).some((c) => c.name === 'role_id'));
    check.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test('the answer cache is dropped with its switch and settings, also from a database that had it', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ordis-db-'));
  const file = join(dir, 'bot.db');
  try {
    // A database as it was just before the answer cache was removed (the 26th migration): built by running only the migrations up to
    // then, so its tables and columns are the real ones of that time. The later migrations then run when it is opened normally.
    new Store(file, { migrateTo: CACHE_REMOVAL }).close();
    const raw = new DatabaseSync(file);
    assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, CACHE_REMOVAL);
    raw.exec("INSERT INTO answer_cache (guild_id, key, question) VALUES ('g', 'q', 'what is a riven?')");
    raw.exec(
      "INSERT INTO bot_meta (key, value) VALUES ('ai_toggle_cache', 'off'), ('cfg_ANSWER_REFRESH_MAX', 'v:12'), ('local_ai_model', 'gemma4:e4b'), ('brain_settings', '{}'), ('cfg_EMBED_MODEL', 'v:x'), ('cfg_LOCAL_AI_MODEL', 'v:old-model'), ('ai_toggle_local', 'on'), ('cfg_WORLDSTATE_URL', 'v:https://docs.warframestat.us/'), ('avatar_sha256', 'abc')",
    );
    raw.close();

    const store = new Store(file);
    assert.equal(store.getMeta('ai_toggle_cache'), null);
    assert.equal(store.getMeta('cfg_ANSWER_REFRESH_MAX'), null);
    assert.equal(store.getMeta('brain_settings'), null, 'and the settings of the removed agent and reranking');
    assert.equal(store.getMeta('cfg_EMBED_MODEL'), null);
    assert.equal(store.getMeta('avatar_sha256'), 'abc', 'other settings stay');
    assert.equal(store.getMeta('local_ai_model'), null, 'the /ai model choice is gone...');
    assert.equal(store.getMeta('cfg_LOCAL_AI_MODEL'), 'v:gemma4:e4b', '...and became the Config value, so the same model stays in use');
    assert.equal(store.getMeta('ai_toggle_local'), null, 'the AI switches are gone');
    assert.equal(store.getMeta('cfg_WORLDSTATE_URL'), null, 'a world state URL pointing at the docs site is dropped');
    store.close();
    const check = new DatabaseSync(file);
    const settingCols = (check.prepare('PRAGMA table_info(guild_settings)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!settingCols.some((c) => c.startsWith('verify_')), 'the verification columns are gone');
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'answer_cache'").get(), undefined);
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'corrections'").get(), undefined, 'the corrections are gone too');
    const cols = (check.prepare('PRAGMA table_info(ai_log)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.includes('rating') && !cols.includes('review') && !cols.includes('message_id'), 'and the rating and review columns');
    check.close();
  } finally {
    // On Windows a database left open by a failed step can't be removed; that must not hide the failure itself.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
