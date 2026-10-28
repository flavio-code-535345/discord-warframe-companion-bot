import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OverwriteType, PermissionFlagsBits, type GuildTextBasedChannel } from 'discord.js';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { BULK_MAX_AGE_MS, MAX_PURGE, parseAmount, selectForPurge } from '../src/moderation/purge.js';
import { lockChannel, unlockChannel } from '../src/moderation/service.js';
import { parseDuration } from '../src/time.js';

test('parseAmount accepts 1..MAX_PURGE and "all"', () => {
  assert.equal(parseAmount('25'), 25);
  assert.equal(parseAmount(' ALL '), 'all');
  assert.equal(parseAmount('0'), null);
  assert.equal(parseAmount(String(MAX_PURGE + 1)), null);
  assert.equal(parseAmount('ten'), null);
});

test('parseDuration reads compact durations', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('soon'), null);
});

test('selectForPurge filters, caps and splits by the 14-day bulk limit', () => {
  const now = Date.now();
  const msg = (id: string, authorId: string, ageMs: number, extra: { bot?: boolean; pinned?: boolean } = {}) => ({
    id, authorId, bot: extra.bot ?? false, pinned: extra.pinned ?? false, createdTimestamp: now - ageMs,
  });
  const batch = [
    msg('1', 'a', 1000),
    msg('2', 'b', 2000, { pinned: true }),
    msg('3', 'bot', 3000, { bot: true }),
    msg('4', 'a', BULK_MAX_AGE_MS + 1000),
    msg('5', 'a', 5000),
  ];
  assert.deepEqual(selectForPurge(batch, {}, 10, now), { recent: ['1', '3', '5'], old: ['4'] });
  assert.deepEqual(selectForPurge(batch, { includePinned: true }, 2, now), { recent: ['1', '2'], old: [] });
  assert.deepEqual(selectForPurge(batch, { userId: 'a' }, 10, now), { recent: ['1', '5'], old: ['4'] });
  assert.deepEqual(selectForPurge(batch, { botsOnly: true }, 10, now), { recent: ['3'], old: [] });
});

test('lock denies sending for members, skips moderator roles, and unlock restores the exact previous state', async () => {
  const GUILD = '111111111111111111';
  const perms = (...bits: bigint[]) => ({ has: (b: bigint) => bits.includes(b) });
  const overwrites = new Map<string, { id: string; type: OverwriteType; allow: ReturnType<typeof perms>; deny: ReturnType<typeof perms> }>([
    [GUILD, { id: GUILD, type: OverwriteType.Role, allow: perms(), deny: perms(PermissionFlagsBits.ReadMessageHistory) }],
    ['verified', { id: 'verified', type: OverwriteType.Role, allow: perms(PermissionFlagsBits.SendMessages), deny: perms() }],
    ['mods', { id: 'mods', type: OverwriteType.Role, allow: perms(PermissionFlagsBits.SendMessages), deny: perms() }],
    ['someone', { id: 'someone', type: OverwriteType.Member, allow: perms(PermissionFlagsBits.SendMessages), deny: perms() }],
  ]);
  const edits: [string, unknown][] = [];
  const channel = {
    id: 'chan',
    name: 'general',
    guild: {
      id: GUILD,
      roles: {
        cache: new Map([
          ['verified', { permissions: { any: () => false } }],
          ['mods', { permissions: { any: () => true } }],
        ]),
      },
    },
    permissionOverwrites: {
      cache: overwrites,
      edit: async (id: string, opts: unknown) => {
        edits.push([id, opts]);
      },
    },
  } as unknown as GuildTextBasedChannel;
  const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD });
  const ctx: AppContext = { config, store: new Store(':memory:'), client: {} as Client, ai: null };

  assert.equal(await lockChannel(ctx, channel, 'test'), 2);
  assert.deepEqual(edits, [
    [GUILD, { SendMessages: false }],
    ['verified', { SendMessages: false }],
  ]);
  await assert.rejects(lockChannel(ctx, channel, 'test'), /already locked/);

  edits.length = 0;
  assert.equal(await unlockChannel(ctx, channel, 'test'), 2);
  assert.deepEqual(new Map(edits), new Map<string, unknown>([
    [GUILD, { SendMessages: null }],
    ['verified', { SendMessages: true }],
  ]));
  await assert.rejects(unlockChannel(ctx, channel, 'test'), /isn't locked/);
});

test('a failed lock is undone, and an unlock carries on past an overwrite it cannot restore', async () => {
  const GUILD = '111111111111111111';
  const perms = (...bits: bigint[]) => ({ has: (b: bigint) => bits.includes(b) });
  const overwrites = new Map([
    [GUILD, { id: GUILD, type: OverwriteType.Role, allow: perms(), deny: perms() }],
    ['verified', { id: 'verified', type: OverwriteType.Role, allow: perms(PermissionFlagsBits.SendMessages), deny: perms() }],
  ]);
  const edits: [string, unknown][] = [];
  let broken: string | null = 'verified';
  const channel = {
    id: 'chan',
    name: 'general',
    guild: { id: GUILD, roles: { cache: new Map([['verified', { permissions: { any: () => false } }]]) } },
    permissionOverwrites: {
      cache: overwrites,
      edit: async (id: string, opts: unknown) => {
        if (id === broken) throw new Error('Unknown Role');
        edits.push([id, opts]);
      },
    },
  } as unknown as GuildTextBasedChannel;
  const ctx: AppContext = { config: loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }), store: new Store(':memory:'), client: {} as Client, ai: null };

  // The second edit fails: the first is put back and no lock is left behind.
  await assert.rejects(lockChannel(ctx, channel, 'test'), /Unknown Role/);
  assert.deepEqual(edits, [[GUILD, { SendMessages: false }], [GUILD, { SendMessages: null }]]);
  assert.equal(ctx.store.isLocked('chan'), false);

  // Locked properly, then one role vanishes: the others are still restored.
  broken = null;
  assert.equal(await lockChannel(ctx, channel, 'test'), 2);
  broken = 'verified';
  edits.length = 0;
  assert.equal(await unlockChannel(ctx, channel, 'test'), 1);
  assert.deepEqual(edits, [[GUILD, { SendMessages: null }]]);
});
