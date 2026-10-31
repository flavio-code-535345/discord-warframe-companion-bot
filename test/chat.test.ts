import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, type Message } from 'discord.js';
import { Store } from '../src/db.js';
import { handleChatMessage } from '../src/discord/chat.js';
import { CHAT_TOPIC, syncChatTopic } from '../src/discord/chat-topic.js';

const config = { BOT_NAME: 'Cephalon Ordis', CLAN_NAME: 'The Rats Den 69', DISCORD_GUILD_ID: 'g', WARFRAME_PLATFORM: 'pc' };

describe('the chat channel', () => {
  const CHAT = 'chat-channel';
  const setup = () => {
    const store = new Store(':memory:');
    store.updateSettings('g', { chatChannelId: CHAT });
    const replies: string[] = [];
    const ctx = { config: { ...config, ENABLE_MESSAGE_CONTENT: true }, store, client: { user: { id: 'bot' } } } as never;
    const message = (content: string, over: { mention?: boolean; reference?: { authorId: string } | null } = {}) =>
      ({
        id: 'x1',
        content,
        guildId: 'g',
        channelId: CHAT,
        author: { id: '5', bot: false, displayName: 'Rat', username: 'rat' },
        member: { displayName: 'Rat', permissions: { has: () => false } },
        inGuild: () => true,
        mentions: { has: () => over.mention === true },
        reference: over.reference ? { messageId: 'ref1' } : null,
        fetchReference: async () => ({ id: 'ref1', author: { id: over.reference?.authorId ?? 'bot' } }),
        channel: { isSendable: () => true, sendTyping: async () => {} },
        reply: async (o: { content: string }) => {
          replies.push(o.content);
          return { id: `sent-${replies.length}` };
        },
      }) as unknown as Message;
    return { ctx, store, replies, message };
  };

  it('replies without a question mark, logs the question, and stays quiet on chatter', async () => {
    const { ctx, store, replies, message } = setup();
    await handleChatMessage(message('9 x 2'), ctx);
    assert.deepEqual(replies, ['9 × 2 = **18**']);
    assert.equal(store.recentAiLog('g', 5)[0]?.question, '9 x 2');
    await handleChatMessage(message('lol'), ctx);
    assert.equal(replies.length, 1, 'nothing to look up, no reply');
  });

  it('stays out of picture-only posts and of conversations between members', async () => {
    const { ctx, replies, message } = setup();
    await handleChatMessage(message(''), ctx);
    await handleChatMessage(message('9 x 2', { reference: { authorId: 'someone-else' } }), ctx);
    assert.deepEqual(replies, []);
    // A mention still always works, and so does a reply to the bot.
    await handleChatMessage(message('9 x 2', { mention: true, reference: { authorId: 'someone-else' } }), ctx);
    await handleChatMessage(message('9 x 2', { reference: { authorId: 'bot' } }), ctx);
    assert.equal(replies.length, 2);
  });
});

describe('the chat channel description', () => {
  const channelOf = (topic: string | null) => {
    const calls: string[] = [];
    return { calls, channel: { type: ChannelType.GuildText, topic, setTopic: async (t: string) => void calls.push(t) } };
  };
  const ctxFor = (channel: unknown, over: { content?: boolean; chat?: string | null; store?: Store } = {}) => {
    const store = over.store ?? new Store(':memory:');
    if (over.chat !== null) store.updateSettings('g', { chatChannelId: over.chat ?? 'c1' });
    return { config: { ...config, ENABLE_MESSAGE_CONTENT: over.content ?? true }, store, client: { channels: { fetch: async () => channel } } } as never;
  };

  it('tells members what the channel does, within Discord limits', () => {
    assert.match(CHAT_TOPIC, /links the wiki pages, nothing made up/);
    assert.ok(CHAT_TOPIC.length <= 1024);
  });

  it('fills an empty description, and leaves a matching one alone', async () => {
    const a = channelOf(null);
    await syncChatTopic(ctxFor(a.channel));
    assert.deepEqual(a.calls, [CHAT_TOPIC]);
    const b = channelOf(CHAT_TOPIC);
    await syncChatTopic(ctxFor(b.channel));
    assert.deepEqual(b.calls, []);
  });

  it('replaces its own older text, but never a description staff wrote by hand', async () => {
    const store = new Store(':memory:');
    store.setMeta('chat_topic_written:c1', 'the bot\'s old description');
    const old = channelOf('the bot\'s old description');
    await syncChatTopic(ctxFor(old.channel, { store }));
    assert.deepEqual(old.calls, [CHAT_TOPIC], 'a new text in the code arrives on its own');
    const edited = channelOf('Ask Ordis here, rats!');
    await syncChatTopic(ctxFor(edited.channel, { store }));
    const fresh = channelOf('a hand-written one');
    await syncChatTopic(ctxFor(fresh.channel));
    assert.deepEqual(edited.calls, [], 'a hand edit survives the next start');
    assert.deepEqual(fresh.calls, [], 'and so does one that was there before Ordis ever wrote');
    const matching = new Store(':memory:');
    await syncChatTopic(ctxFor(channelOf(CHAT_TOPIC).channel, { store: matching }));
    assert.equal(matching.getMeta('chat_topic_written:c1'), CHAT_TOPIC, 'the text already there is remembered as the bot\'s own');
  });

  it('does nothing without a chat channel or while Ordis cannot read messages, and survives a refusal', async () => {
    const a = channelOf(null);
    await syncChatTopic(ctxFor(a.channel, { chat: null }));
    await syncChatTopic(ctxFor(a.channel, { content: false }));
    assert.deepEqual(a.calls, []);
    await syncChatTopic(ctxFor({ type: ChannelType.GuildText, topic: null, setTopic: async () => Promise.reject(new Error('Missing Permissions')) }));
  });
});
