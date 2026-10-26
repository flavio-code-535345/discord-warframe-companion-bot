import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, type Guild, OverwriteType } from 'discord.js';
import { planRestore, restoreBackup } from '../src/backup/restore.js';
import { BACKUP_VERSION, type ServerBackup, parseBackup, summarize } from '../src/backup/snapshot.js';
import { Store } from '../src/db.js';

const OLD_GUILD = '100000000000000000';

function sampleBackup(): ServerBackup {
  return {
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    guild: { id: OLD_GUILD, name: 'Rats', icon: null, verificationLevel: 1, defaultMessageNotifications: 1, explicitContentFilter: 0, afkTimeout: 300, afkChannelId: null, systemChannelId: 'c-general' },
    roles: [
      { id: OLD_GUILD, name: '@everyone', color: 0, hoist: false, mentionable: false, permissions: '1024', position: 0, everyone: true, managed: false },
      { id: 'r-verified', name: 'Verified', color: 0, hoist: false, mentionable: false, permissions: '0', position: 1, everyone: false, managed: false },
      { id: 'r-leader', name: 'Leadership', color: 0xff0000, hoist: true, mentionable: false, permissions: '8', position: 2, everyone: false, managed: false },
      { id: 'r-bot', name: 'SomeBot', color: 0, hoist: false, mentionable: false, permissions: '0', position: 3, everyone: false, managed: true },
    ],
    channels: [
      { id: 'c-den', name: 'THE DEN', type: ChannelType.GuildCategory, parentId: null, position: 0, topic: null, nsfw: false, rateLimitPerUser: 0, bitrate: null, userLimit: null, overwrites: [] },
      {
        id: 'c-general', name: 'general', type: ChannelType.GuildText, parentId: 'c-den', position: 0, topic: 'chat', nsfw: false, rateLimitPerUser: 0, bitrate: null, userLimit: null,
        overwrites: [
          { id: OLD_GUILD, type: 0, allow: '0', deny: '1024' },
          { id: 'r-verified', type: 0, allow: '1024', deny: '0' },
          { id: 'r-bot', type: 0, allow: '0', deny: '1024' },
        ],
        messages: [{ author: 'Rat', avatar: null, content: 'hello', attachments: [], createdAt: 1 }],
      },
      { id: 'c-news', name: 'news', type: ChannelType.GuildAnnouncement, parentId: 'c-den', position: 1, topic: null, nsfw: false, rateLimitPerUser: 0, bitrate: null, userLimit: null, overwrites: [] },
    ],
    emojis: [{ name: 'rat', animated: false, data: Buffer.from('png').toString('base64') }],
    bans: [{ id: 'u-troll', reason: 'spam' }],
    botSettings: {
      alertsChannelId: null,
      alertsRoleId: null,
      announcementsChannelId: 'c-news',
      welcomeChannelId: null,
      chatChannelId: null,
      modLogChannelId: null,
      verifyChannelId: 'c-general',
      verifyPanelMessageId: null,
      verifyRoleId: 'r-verified',
      verifyMinAccountAgeDays: 3,
      honeypotChannelId: null,
      honeypotAction: null,
      ssRolesChannelId: null,
      levelingOff: null,
      levelChannelId: null,
      auditLogChannelId: null,
      lfgVoiceCategoryId: null,
      lfgVoiceGraceMinutes: null,
      autoVcHubChannelId: null,
    },
    includesMessages: true,
  };
}

test('planRestore: missing mode only lists what is gone; sync mode also lists resets', () => {
  const current = { guildId: 'g', roleIds: new Set(['r-verified']), channelIds: new Set(['c-den']), emojiNames: new Set<string>(), banIds: new Set<string>() };
  const missing = planRestore(current, sampleBackup(), { mode: 'missing', bans: true, messages: true });
  assert.deepEqual(missing.rolesCreate, ['Leadership']);
  assert.deepEqual(missing.rolesUpdate, []);
  assert.deepEqual(missing.rolesSkipped, ['SomeBot']);
  assert.deepEqual(missing.channelsCreate, ['general', 'news']);
  assert.deepEqual(missing.channelsUpdate, []);
  assert.equal(missing.messageChannels, 1);
  assert.equal(missing.bansAdd, 1);
  const sync = planRestore(current, sampleBackup(), { mode: 'sync', bans: false, messages: false });
  assert.deepEqual(sync.rolesUpdate, ['Verified']);
  assert.deepEqual(sync.channelsUpdate, ['THE DEN']);
  assert.equal(sync.bansAdd, 0);
});

test('parseBackup rejects foreign files and summarize counts the right things', () => {
  assert.throws(() => parseBackup('{"hello":1}'), /Not a Cephalon Ordis backup/);
  const b = parseBackup(JSON.stringify(sampleBackup()));
  assert.deepEqual(summarize(b, 123), { roles: 2, channels: 3, emojis: 1, bans: 1, messages: 1, sizeBytes: 123 });
});

/** A minimal in-memory stand-in for the parts of discord.js Guild that restore uses. */
function fakeGuild(opts: { roles: string[]; channels: { id: string; type: ChannelType; name: string }[] }) {
  let seq = 0;
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const roles = new Map<string, Record<string, unknown>>(opts.roles.map((id) => [id, { id, editable: true, edit: async () => {} }]));
  const channels = new Map<string, Record<string, unknown>>(
    opts.channels.map((c) => [c.id, { ...c, isThread: () => false, edit: async (a: Record<string, unknown>) => calls.push({ op: 'channel.edit', args: { id: c.id, ...a } }) }]),
  );
  const guild = {
    id: 'g-new',
    features: [] as string[],
    maximumBitrate: 96000,
    icon: null,
    afkChannelId: null,
    systemChannelId: null,
    roles: {
      cache: roles,
      everyone: { setPermissions: async () => {} },
      fetch: async () => roles,
      create: async (a: Record<string, unknown>) => {
        const id = `new-role-${++seq}`;
        calls.push({ op: 'role.create', args: { id, ...a } });
        const role = { id, editable: true, ...a };
        roles.set(id, role);
        return role;
      },
      setPositions: async (a: unknown) => calls.push({ op: 'role.positions', args: { list: a } }),
    },
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async (a: Record<string, unknown>) => {
        const id = `new-ch-${++seq}`;
        calls.push({ op: 'channel.create', args: { id, ...a } });
        const ch = { id, ...a, createWebhook: async () => ({ send: async (m: unknown) => calls.push({ op: 'webhook.send', args: { m } }), delete: async () => {} }) };
        channels.set(id, ch);
        return ch;
      },
      setPositions: async (a: unknown) => calls.push({ op: 'channel.positions', args: { list: a } }),
    },
    emojis: { cache: new Map(), fetch: async () => new Map(), create: async (a: Record<string, unknown>) => calls.push({ op: 'emoji.create', args: a }) },
    bans: { fetch: async () => new Map() },
    members: {
      fetchMe: async () => ({ roles: { highest: { position: 50 } } }),
      fetch: async () => null,
      ban: async (id: string) => calls.push({ op: 'ban', args: { id } }),
    },
    edit: async (a: Record<string, unknown>) => calls.push({ op: 'guild.edit', args: a }),
  };
  return { guild: guild as unknown as Guild, calls };
}

test('restoreBackup recreates missing roles and channels with mapped parents, overwrites and bot settings', async () => {
  // A wrecked server: only the category and @everyone survived; Verified, Leadership and both channels are gone.
  const { guild, calls } = fakeGuild({ roles: ['g-new'], channels: [{ id: 'c-den', type: ChannelType.GuildCategory, name: 'THE DEN' }] });
  const store = new Store(':memory:');
  const result = await restoreBackup(guild, sampleBackup(), { mode: 'missing', bans: true, messages: true }, store);

  assert.deepEqual(result.errors, []);
  assert.equal(result.rolesCreated, 2);
  assert.equal(result.channelsCreated, 2);
  const createdRoles = calls.filter((c) => c.op === 'role.create').map((c) => c.args.name);
  assert.deepEqual(createdRoles, ['Verified', 'Leadership']);
  const verifiedId = calls.find((c) => c.op === 'role.create' && c.args.name === 'Verified')!.args.id;

  const general = calls.find((c) => c.op === 'channel.create' && c.args.name === 'general')!.args;
  assert.equal(general.parent, 'c-den');
  assert.equal(general.topic, 'chat');
  // @everyone maps to the live guild, Verified to its recreated role, and the missing bot role is dropped.
  assert.deepEqual(general.permissionOverwrites, [
    { id: 'g-new', type: OverwriteType.Role, allow: 0n, deny: 1024n },
    { id: verifiedId, type: OverwriteType.Role, allow: 1024n, deny: 0n },
  ]);
  // Announcement channels need the Community feature; without it they come back as text.
  assert.equal(calls.find((c) => c.op === 'channel.create' && c.args.name === 'news')!.args.type, ChannelType.GuildText);

  assert.equal(result.messagesPosted, 1);
  assert.equal(result.emojisCreated, 1);
  assert.equal(result.bansAdded, 1);
  assert.equal(store.getSettings('g-new').announcementsChannelId, result.channelMap.get('c-news'));
  assert.equal(store.getSettings('g-new').verifyChannelId, result.channelMap.get('c-general'));
  assert.equal(store.getSettings('g-new').verifyRoleId, verifiedId);
  // Existing channels are left alone in "missing" mode.
  assert.equal(calls.filter((c) => c.op === 'channel.edit').length, 0);
});
