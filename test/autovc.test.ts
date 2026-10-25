import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VoiceState } from 'discord.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { handleVoiceStateUpdate, roomName, sweepTempVoice } from '../src/lfg/autovc.js';

const G = 'g1';
const HUB = 'hub';

interface FakeChannel {
  id: string;
  parentId?: string;
  bitrate?: number;
  members: Map<string, unknown>;
  isVoiceBased: () => true;
  delete: (reason?: string) => Promise<void>;
}

function world() {
  const calls: string[] = [];
  const channels = new Map<string, FakeChannel>();
  const mk = (id: string, members: string[] = []): FakeChannel => {
    const ch: FakeChannel = {
      id,
      parentId: 'cat',
      bitrate: 64000,
      members: new Map(members.map((m) => [m, {}])),
      isVoiceBased: () => true,
      delete: async () => {
        channels.delete(id);
        calls.push(`delete ${id}`);
      },
    };
    channels.set(id, ch);
    return ch;
  };
  const hub = mk(HUB);
  const guild = {
    id: G,
    maximumBitrate: 96000,
    channels: {
      cache: channels,
      fetch: async (id: string) => channels.get(id) ?? null,
      create: async (o: { name: string; parent: string; permissionOverwrites: { id: string }[] }) => {
        const room = mk(`room${channels.size}`);
        calls.push(`create ${o.name} in ${o.parent} for ${o.permissionOverwrites[0]!.id}`);
        return room;
      },
    },
  };
  const store = new Store(':memory:');
  store.updateSettings(G, { autoVcHubChannelId: HUB });
  const ctx = { config: { DISCORD_GUILD_ID: G }, store, client: { guilds: { fetch: async () => guild } } } as unknown as AppContext;
  const member = (id: string, bot = false) => ({
    id,
    displayName: `Name-${id}`,
    user: { bot, username: id },
    guild,
    voice: { setChannel: async (c: FakeChannel) => void calls.push(`move ${id} -> ${c.id}`) },
  });
  const state = (m: ReturnType<typeof member> | null, channel: FakeChannel | null) =>
    ({ guild, member: m, channelId: channel?.id ?? null, channel }) as unknown as VoiceState;
  return { calls, channels, hub, mk, ctx, store, member, state };
}

test('roomName is capped at 100 characters', () => {
  assert.equal(roomName('Rat'), "🎧 Rat's room");
  assert.equal(roomName('x'.repeat(200)).length, 100);
});

test('joining the lobby creates a room next to it and moves the member in', async () => {
  const w = world();
  const rat = w.member('rat');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, null), w.state(rat, w.hub));
  assert.deepEqual(w.calls, ["create 🎧 Name-rat's room in cat for rat", 'move rat -> room1']);
  assert.equal(w.store.tempVoiceByOwner(G, 'rat')?.channelId, 'room1');
});

test('joining the lobby again returns to the existing room instead of making another', async () => {
  const w = world();
  const rat = w.member('rat');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, null), w.state(rat, w.hub));
  w.calls.length = 0;
  await handleVoiceStateUpdate(w.ctx, w.state(rat, null), w.state(rat, w.hub));
  assert.deepEqual(w.calls, ['move rat -> room1']);
});

test('bots and other channels never create rooms', async () => {
  const w = world();
  const other = w.mk('other');
  const bot = w.member('bot', true);
  await handleVoiceStateUpdate(w.ctx, w.state(bot, null), w.state(bot, w.hub));
  const rat = w.member('rat');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, null), w.state(rat, other));
  assert.deepEqual(w.calls, []);
});

test('a room is deleted when its last member leaves, but not while others remain', async () => {
  const w = world();
  const rat = w.member('rat');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, null), w.state(rat, w.hub));
  const room = w.channels.get('room1')!;
  room.members.set('rat', {});
  room.members.set('friend', {});
  w.calls.length = 0;

  room.members.delete('rat');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, room), w.state(rat, null));
  assert.deepEqual(w.calls, []);

  room.members.delete('friend');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, room), w.state(rat, null));
  assert.deepEqual(w.calls, ['delete room1']);
  assert.equal(w.store.getTempVoice('room1'), null);
});

test('leaving an ordinary channel never deletes it', async () => {
  const w = world();
  const plain = w.mk('plain');
  const rat = w.member('rat');
  await handleVoiceStateUpdate(w.ctx, w.state(rat, plain), w.state(rat, null));
  assert.deepEqual(w.calls, []);
  assert.ok(w.channels.has('plain'));
});

test('the sweep deletes empty old rooms, spares new and occupied ones, and forgets vanished ones', async () => {
  const w = world();
  const now = 1_000_000;
  const add = (id: string, createdAt: number) => w.store.addTempVoice({ channelId: id, guildId: G, ownerId: `o-${id}`, createdAt });
  w.mk('old-empty');
  add('old-empty', now - 120_000);
  w.mk('new-empty');
  add('new-empty', now - 5_000);
  w.mk('busy', ['someone']);
  add('busy', now - 120_000);
  add('gone', now - 120_000);

  await sweepTempVoice(w.ctx, now);
  assert.deepEqual(w.calls, ['delete old-empty']);
  assert.deepEqual(w.store.listTempVoice().map((r) => r.channelId).sort(), ['busy', 'new-empty']);
});
