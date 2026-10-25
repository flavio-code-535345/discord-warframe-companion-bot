import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'discord.js';
import { Store } from '../src/db.js';
import { StickyKeeper, renderSticky } from '../src/sticky/service.js';

const GUILD = 'g1';
const CHANNEL = 'c1';

/** A text channel that records what the keeper sends and deletes. */
function fakeChannel(store: Store) {
  const log: string[] = [];
  let n = 0;
  const channel = {
    lastMessageId: null as string | null,
    isTextBased: () => true,
    send: async (payload: { embeds: { data: { description?: string } }[] }) => {
      const id = `m${++n}`;
      channel.lastMessageId = id;
      log.push(`send ${id}: ${payload.embeds[0]!.data.description}`);
      return { id };
    },
    messages: { delete: async (id: string) => void log.push(`delete ${id}`) },
  };
  void store;
  return { channel, log };
}

function setup(debounce = 5) {
  const store = new Store(':memory:');
  const { channel, log } = fakeChannel(store);
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  const keeper = new StickyKeeper({ client, store, config: { DISCORD_GUILD_ID: GUILD } } as never, debounce);
  store.setSticky({ channelId: CHANNEL, guildId: GUILD, title: null, content: 'Read the rules', createdBy: 'u', deleteOthers: false, imageUrl: null });
  const say = (id: string, author = 'someone') => ({ id, channelId: CHANNEL, guildId: GUILD, inGuild: () => true, author: { id: author } }) as unknown as Message;
  return { store, channel, log, keeper, say };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

test('the first message in a channel posts the sticky, the next one replaces it', async () => {
  const { keeper, log, say, channel } = setup();
  keeper.onMessage(say('u1'));
  await settle();
  assert.deepEqual(log, ['send m1: Read the rules']);
  channel.lastMessageId = 'u2'; // someone talked after the sticky
  keeper.onMessage(say('u2'));
  await settle();
  assert.deepEqual(log, ['send m1: Read the rules', 'send m2: Read the rules', 'delete m1']);
});

test('a burst of messages causes one repost', async () => {
  const { keeper, log, say } = setup(20);
  for (const id of ['a', 'b', 'c', 'd']) keeper.onMessage(say(id));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(log.filter((l) => l.startsWith('send')).length, 1);
});

test('its own sticky message does not trigger another repost', async () => {
  const { keeper, log, say, store } = setup();
  keeper.onMessage(say('u1'));
  await settle();
  const stickyId = store.getSticky(CHANNEL)!.messageId!;
  keeper.onMessage(say(stickyId, 'bot'));
  await settle();
  assert.equal(log.filter((l) => l.startsWith('send')).length, 1);
});

test('channels without a sticky, and other servers, are ignored', async () => {
  const { keeper, log, say } = setup();
  keeper.onMessage({ ...say('x'), channelId: 'other' } as Message);
  keeper.onMessage({ ...say('y'), guildId: 'elsewhere' } as Message);
  await settle();
  assert.deepEqual(log, []);
});

test('forced refresh replaces the sticky even when it is already the last message', async () => {
  const { keeper, log, channel, store } = setup();
  await keeper.refresh(CHANNEL);
  assert.equal(channel.lastMessageId, 'm1');
  await keeper.refresh(CHANNEL); // already last: nothing to do
  assert.equal(log.length, 1);
  store.setSticky({ channelId: CHANNEL, guildId: GUILD, title: 'New', content: 'Changed text', createdBy: 'u', deleteOthers: false, imageUrl: null });
  await keeper.refresh(CHANNEL, true);
  assert.deepEqual(log.slice(1), ['send m2: Changed text', 'delete m1']);
});

test('the sticky store keeps one row per channel and survives edits', () => {
  const store = new Store(':memory:');
  store.setSticky({ channelId: 'c', guildId: 'g', title: null, content: 'one', createdBy: 'u', deleteOthers: false, imageUrl: null });
  store.setStickyMessage('c', 'm9');
  store.setSticky({ channelId: 'c', guildId: 'g', title: 'T', content: 'two', createdBy: 'u', deleteOthers: false, imageUrl: null });
  assert.equal(store.listStickies('g').length, 1);
  assert.equal(store.getSticky('c')!.content, 'two');
  assert.equal(store.getSticky('c')!.messageId, 'm9');
  assert.equal(store.removeSticky('c'), true);
  assert.equal(store.getSticky('c'), null);
});

test('the sticky embed has a heading only when one was given', () => {
  assert.equal(renderSticky({ title: null, content: 'x' }).data.title, undefined);
  assert.equal(renderSticky({ title: 'Rules', content: 'x' }).data.title, 'Rules');
});

test('clean mode deletes what other members post, but not staff, and never reposts', async () => {
  const { keeper, log, store } = setup();
  store.setSticky({ channelId: CHANNEL, guildId: GUILD, title: null, content: 'Rules', createdBy: 'u', deleteOthers: true, imageUrl: null });
  const deleted: string[] = [];
  const msg = (id: string, staff: boolean, author = 'someone') =>
    ({
      id,
      channelId: CHANNEL,
      guildId: GUILD,
      inGuild: () => true,
      author: { id: author },
      member: { permissions: { has: () => staff } },
      delete: async () => void deleted.push(id),
    }) as unknown as Message;
  keeper.onMessage(msg('spam', false));
  keeper.onMessage(msg('mod', true));
  keeper.onMessage(msg('own', false, 'bot'));
  await settle();
  assert.deepEqual(deleted, ['spam']);
  assert.deepEqual(log, []);
  assert.equal(store.getSticky(CHANNEL)!.deleteOthers, true);
});

test('constant chat cannot starve the sticky: it is reposted at least every max-wait', async () => {
  const store = new Store(':memory:');
  const { channel, log } = fakeChannel(store);
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  const keeper = new StickyKeeper({ client, store, config: { DISCORD_GUILD_ID: GUILD } } as never, 60, 120);
  store.setSticky({ channelId: CHANNEL, guildId: GUILD, title: null, content: 'Rules', createdBy: 'u', deleteOthers: false, imageUrl: null });
  const say = (id: string) => ({ id, channelId: CHANNEL, guildId: GUILD, inGuild: () => true, author: { id: 'someone' } }) as unknown as Message;
  // a message every 30 ms for 400 ms: the 60 ms debounce never gets a quiet gap, so only the max-wait can post it
  for (let i = 0; i < 13; i++) {
    channel.lastMessageId = `m${i}`; // someone talked, so the sticky is no longer last
    keeper.onMessage(say(`m${i}`));
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(log.filter((l) => l.startsWith('send')).length >= 2, log.join(' | '));
  keeper.stop();
});

test('the sticky embed carries the picture and a pinned footer', () => {
  const e = renderSticky({ title: 'Rules', content: 'Be nice', imageUrl: 'https://example.com/a.png' }).data;
  assert.equal(e.image?.url, 'https://example.com/a.png');
  assert.match(e.footer?.text ?? '', /Pinned/);
});
