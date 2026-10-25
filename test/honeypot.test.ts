import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import { Store } from '../src/db.js';
import { handleHoneypotMessage, honeypotAction, isHoneypotExempt } from '../src/moderation/honeypot.js';
import type { AppContext } from '../src/context.js';

const member = (id: string, position: number, perms: bigint[] = []) =>
  ({ id, permissions: { any: (p: bigint[]) => p.some((x) => perms.includes(x)) }, roles: { highest: { position } } }) as unknown as GuildMember;

test('honeypotAction falls back to softban for unknown values', () => {
  assert.equal(honeypotAction(null), 'softban');
  assert.equal(honeypotAction('nuke'), 'softban');
  assert.equal(honeypotAction('ban'), 'ban');
  assert.equal(honeypotAction('kick'), 'kick');
});

test('isHoneypotExempt protects staff, the owner, Ordis and anyone above Ordis', () => {
  const me = member('bot', 10);
  assert.equal(isHoneypotExempt(member('spammer', 1), me, 'owner'), false);
  assert.equal(isHoneypotExempt(member('owner', 1), me, 'owner'), true);
  assert.equal(isHoneypotExempt(member('bot', 10), me, 'owner'), true);
  assert.equal(isHoneypotExempt(member('mod', 2, [PermissionFlagsBits.BanMembers]), me, 'owner'), true);
  assert.equal(isHoneypotExempt(member('admin', 2, [PermissionFlagsBits.Administrator]), me, 'owner'), true);
  assert.equal(isHoneypotExempt(member('boss', 12), me, 'owner'), true);
  assert.equal(isHoneypotExempt(member('peer', 10), me, 'owner'), true);
});

/** A guild that records what Ordis does to the poster. */
function harness(opts: { poster: GuildMember; channelId?: string; action?: string }) {
  const calls: string[] = [];
  const store = new Store(':memory:');
  store.updateSettings('g1', { honeypotChannelId: 'trap', honeypotAction: opts.action ?? null });
  const me = member('bot', 10);
  const guild = {
    ownerId: 'owner',
    members: {
      fetchMe: async () => me,
      fetch: async () => opts.poster,
      ban: async (id: string, o: { deleteMessageSeconds?: number }) => void calls.push(`ban ${id} ${o.deleteMessageSeconds}`),
      unban: async (id: string) => void calls.push(`unban ${id}`),
      kick: async (id: string) => void calls.push(`kick ${id}`),
    },
    name: 'Rats',
  };
  const message = {
    inGuild: () => true,
    guildId: 'g1',
    guild,
    channelId: opts.channelId ?? 'trap',
    author: { id: opts.poster.id, bot: false, send: async () => calls.push('dm') },
    member: opts.poster,
    content: 'free nitro http://scam',
    attachments: { size: 0 },
    delete: async () => void calls.push('delete'),
  };
  const ctx = { config: { DISCORD_GUILD_ID: 'g1' }, store, client: { user: { id: 'bot' } } } as unknown as AppContext;
  return { calls, message: message as never, ctx };
}

test('a poster in the trap is deleted, told, softbanned and unbanned', async () => {
  const h = harness({ poster: member('spammer', 1) });
  assert.equal(await handleHoneypotMessage(h.message, h.ctx), true);
  assert.deepEqual(h.calls, ['delete', 'dm', 'ban spammer 3600', 'unban spammer']);
});

test('ban keeps the ban and kick only kicks', async () => {
  const ban = harness({ poster: member('spammer', 1), action: 'ban' });
  await handleHoneypotMessage(ban.message, ban.ctx);
  assert.deepEqual(ban.calls, ['delete', 'dm', 'ban spammer 3600']);
  const kick = harness({ poster: member('spammer', 1), action: 'kick' });
  await handleHoneypotMessage(kick.message, kick.ctx);
  assert.deepEqual(kick.calls, ['delete', 'dm', 'kick spammer']);
});

test('staff posting in the trap are left alone, other channels are ignored', async () => {
  const staff = harness({ poster: member('mod', 2, [PermissionFlagsBits.BanMembers]) });
  assert.equal(await handleHoneypotMessage(staff.message, staff.ctx), true);
  assert.deepEqual(staff.calls, []);
  const elsewhere = harness({ poster: member('spammer', 1), channelId: 'general' });
  assert.equal(await handleHoneypotMessage(elsewhere.message, elsewhere.ctx), false);
  assert.deepEqual(elsewhere.calls, []);
});
