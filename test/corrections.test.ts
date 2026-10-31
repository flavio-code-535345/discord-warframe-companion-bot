import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { PermissionFlagsBits, type Message } from 'discord.js';
import { resetCapabilities } from '../src/ai/ollama.js';
import { resetAiToggles } from '../src/ai/settings.js';
import { resetLocalAi } from '../src/ai/local.js';
import { addCorrection, approveCorrection, findCorrection, isStaff, rejectCorrection } from '../src/answers/corrections.js';
import { smartAnswer } from '../src/answers/smart.js';
import { Store } from '../src/db.js';
import { handleCorrectionReply } from '../src/discord/corrections.js';
import { addRatingReactions, handleRatingReaction } from '../src/discord/ratings.js';
import { handleChatMessage } from '../src/discord/chat.js';
import { CHAT_TOPIC, syncChatTopic } from '../src/discord/chat-topic.js';
import { ChannelType } from 'discord.js';

const config = {
  BOT_NAME: 'Cephalon Ordis',
  CLAN_NAME: 'The Rats Den 69',
  DISCORD_GUILD_ID: 'g',
  OPERATOR_IDS: ['1'],
  PANEL_OWNER_IDS: ['9'],
  LOCAL_AI_URL: 'http://h:11434/v1',
  LOCAL_AI_MODEL: 'gemma',
  LOCAL_AI_TIMEOUT_SECONDS: 5,
  FREE_AI_KEY: undefined as string | undefined,
  FREE_AI_URL: 'https://cloud.example/v1',
  FREE_AI_MODEL: 'cloud',
  FREE_AI_DAILY_LIMIT: 100,
  WARFRAME_PLATFORM: 'pc',
};
const ctxOf = (store = new Store(':memory:')) => ({ config, store }) as never;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetAiToggles();
  resetLocalAi();
  resetCapabilities();
});

describe('corrections', () => {
  const Q = 'How do I get Condition Overload?';
  const entry = (store: Store, over: object = {}) => {
    const id = store.addAiLog('g', { at: Date.now(), userId: '5', userName: 'Rat', channelId: 'c', via: 'chat', question: Q, intent: 'wiki', source: 'local', model: 'gemma', found: true, ms: 10, answer: 'It drops from Grineer.', messageId: 'm1', ...over });
    return store.getAiLog('g', id)!;
  };

  it('saves a staff correction as approved at once, and marks the answer wrong', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    const e = entry(store);
    const r = addCorrection(ctx, { entry: e, text: 'It is a Steel Path Honors purchase.', authorId: '7', authorName: 'Boss', staff: true, source: 'staff_reply' })!;
    assert.equal(r.status, 'approved');
    assert.equal(findCorrection(ctx, 'how do i get condition overload')?.correction, 'It is a Steel Path Honors purchase.');
    assert.equal(store.getAiLog('g', e.id)!.rating, 'wrong');
    assert.equal(store.getCorrection('g', r.id)!.badAnswer, 'It drops from Grineer.');
  });

  it('keeps a member reply pending until staff approve it, with their edit', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    const r = addCorrection(ctx, { entry: entry(store), text: 'Buy it at Teshin.', authorId: '5', authorName: 'Rat', staff: false, source: 'member_reply' })!;
    assert.equal(r.status, 'pending');
    assert.equal(findCorrection(ctx, Q), null, 'a suggestion is never served');
    assert.equal(approveCorrection(ctx, r.id, '7', 'Buy it at Teshin for 15,000 Steel Essence.'), true);
    assert.equal(findCorrection(ctx, Q)?.correction, 'Buy it at Teshin for 15,000 Steel Essence.');
    assert.equal(store.getCorrection('g', r.id)!.decidedBy, '7');
  });

  it('rejects, ignores repeats, and refuses empty text', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    const e = entry(store);
    const a = addCorrection(ctx, { entry: e, text: 'Same text', authorId: '5', authorName: 'Rat', staff: false, source: 'member_reply' })!;
    const again = addCorrection(ctx, { entry: e, text: 'Same text', authorId: '5', authorName: 'Rat', staff: false, source: 'member_reply' })!;
    assert.equal(again.duplicate, true);
    assert.equal(again.id, a.id);
    assert.equal(addCorrection(ctx, { entry: e, text: '   ', authorId: '5', authorName: 'Rat', staff: false, source: 'member_reply' }), null);
    assert.equal(rejectCorrection(ctx, a.id, '7'), true);
    assert.equal(store.countCorrections('g').rejected, 1);
    assert.equal(findCorrection(ctx, Q), null);
  });

  it('prefers the newest correction for a question', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    addCorrection(ctx, { entry: null, question: Q, text: 'first', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' }, 1_000);
    addCorrection(ctx, { entry: null, question: Q, text: 'second', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' }, 2_000);
    assert.equal(findCorrection(ctx, Q)?.correction, 'second');
  });

  it('knows who counts as staff', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    store.addPanelAdmin('8', '1', null);
    assert.equal(isStaff(ctx, '1', false), true, 'operator');
    assert.equal(isStaff(ctx, '9', false), true, 'panel owner');
    assert.equal(isStaff(ctx, '8', false), true, 'panel admin');
    assert.equal(isStaff(ctx, '5', true), true, 'Manage Server');
    assert.equal(isStaff(ctx, '5', false), false);
  });

  it('serves the correction word for word, ahead of everything', async () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    addCorrection(ctx, { entry: null, question: Q, text: 'Steel Path Honors, 15 Steel Essence.', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' });
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    const a = await smartAnswer(Q, ctx);
    assert.equal(a.source, 'correction');
    assert.equal(a.content, 'Steel Path Honors, 15 Steel Essence.');
    assert.equal(a.intent, 'correction');
    assert.equal((await smartAnswer('how do i get condition overload??', ctx)).source, 'correction', 'punctuation does not matter');
  });

});

describe('replying to Ordis in Discord', () => {
  const store = () => new Store(':memory:');
  const fake = (over: { id?: string; manage?: boolean; reactFails?: boolean } = {}) => {
    const calls: { react: string[]; reply: string[] } = { react: [], reply: [] };
    const message = {
      author: { id: over.id ?? '5', username: 'rat', displayName: 'Rat' },
      member: { displayName: 'Rat', permissions: { has: (p: bigint) => over.manage === true && p === PermissionFlagsBits.ManageGuild } },
      react: async (e: string) => {
        if (over.reactFails) throw new Error('no permission');
        calls.react.push(e);
      },
      reply: async (o: { content: string }) => {
        calls.reply.push(o.content);
      },
    } as unknown as Message;
    return { message, calls };
  };
  const logged = (s: Store) => s.getAiLog('g', s.addAiLog('g', { at: Date.now(), userId: '2', userName: 'Asker', channelId: 'c', via: 'chat', question: 'How do I get Condition Overload?', intent: 'wiki', source: 'local', model: 'g', found: true, ms: 1, answer: 'wrong', messageId: 'm1' }))!;

  it('lets an admin correct by replying: saved at once and confirmed with a check mark', async () => {
    const s = store();
    const { message, calls } = fake({ manage: true });
    assert.equal(await handleCorrectionReply(message, ctxOf(s), logged(s), 'It is bought from Steel Path Honors for 15 Steel Essence.'), true);
    assert.deepEqual(calls.react, ['✅']);
    const [c] = s.listCorrections('g', 'approved');
    assert.equal(c!.source, 'staff_reply');
    assert.equal(c!.askerId, '2');
    assert.equal(c!.question, 'How do I get Condition Overload?');
  });

  it('operators count as admins without the Discord permission', async () => {
    const s = store();
    const { message, calls } = fake({ id: '1' });
    await handleCorrectionReply(message, ctxOf(s), logged(s), 'It is bought from Steel Path Honors.');
    assert.deepEqual(calls.react, ['✅']);
    assert.equal(s.countCorrections('g').approved, 1);
  });

  it("turns a member's reply into a suggestion for the admins", async () => {
    const s = store();
    const { message, calls } = fake();
    await handleCorrectionReply(message, ctxOf(s), logged(s), 'I think you buy it at Teshin instead.');
    assert.deepEqual(calls.react, ['📝']);
    assert.equal(s.countCorrections('g').pending, 1);
    assert.equal(s.countCorrections('g').approved, 0);
  });

  it('treats a question, thanks or a few words as something else', async () => {
    const s = store();
    for (const text of ['and where do I buy it?', 'Thanks a lot for that answer!', 'ok', 'no']) {
      const { message, calls } = fake({ manage: true });
      assert.equal(await handleCorrectionReply(message, ctxOf(s), logged(s), text), false, text);
      assert.deepEqual(calls.react, []);
    }
    assert.equal(s.countCorrections('g').approved + s.countCorrections('g').pending, 0);
  });

  it('says so in words when it cannot add a reaction', async () => {
    const s = store();
    const { message, calls } = fake({ manage: true, reactFails: true });
    await handleCorrectionReply(message, ctxOf(s), logged(s), 'It is bought from Steel Path Honors.');
    assert.match(calls.reply[0]!, /Noted/);
  });
});

describe('rating answers with reactions', () => {
  const setup = () => {
    const store = new Store(':memory:');
    const id = store.addAiLog('g', { at: Date.now(), userId: '2', userName: 'Asker', channelId: 'c', via: 'chat', question: 'How do I unlock Venus?', intent: 'wiki', source: 'local', model: 'g', found: true, ms: 1, answer: 'Do the quest.', messageId: 'm1' });
    return { store, id, ctx: { config, store } as never };
  };
  const reaction = (emoji: string, over: { messageId?: string; guildId?: string; manage?: boolean } = {}) =>
    ({
      emoji: { name: emoji },
      message: {
        id: over.messageId ?? 'm1',
        guildId: over.guildId ?? 'g',
        guild: { members: { fetch: async () => ({ permissions: { has: (p: bigint) => over.manage === true && p === PermissionFlagsBits.ManageGuild } }) } },
      },
    }) as never;
  const user = (id: string, bot = false) => ({ id, bot }) as never;

  it('puts the check and the cross under an answer, and shrugs when it may not', async () => {
    const seen: string[] = [];
    await addRatingReactions({ react: async (e: string) => void seen.push(e) } as unknown as Message);
    assert.deepEqual(seen, ['✅', '❌']);
    await addRatingReactions({ react: async () => Promise.reject(new Error('Missing Permissions')) } as unknown as Message);
  });

  it('lets staff rate an answer by reacting, and clears the rating when they take it back', async () => {
    const { store, id, ctx } = setup();
    await handleRatingReaction(reaction('✅', { manage: true }), user('5'), ctx, true);
    assert.equal(store.getAiLog('g', id)!.rating, 'right');
    await handleRatingReaction(reaction('❌', { manage: true }), user('5'), ctx, true);
    assert.equal(store.getAiLog('g', id)!.rating, 'wrong', 'the latest click wins');
    await handleRatingReaction(reaction('✅', { manage: true }), user('5'), ctx, false);
    assert.equal(store.getAiLog('g', id)!.rating, 'wrong', 'removing a different reaction changes nothing');
    await handleRatingReaction(reaction('❌', { manage: true }), user('5'), ctx, false);
    assert.equal(store.getAiLog('g', id)!.rating, null);
    // An operator needs no Discord permission.
    await handleRatingReaction(reaction('✅'), user('1'), ctx, true);
    assert.equal(store.getAiLog('g', id)!.rating, 'right');
  });

  it('ignores members, bots, other emoji, other messages and other servers', async () => {
    const { store, id, ctx } = setup();
    await handleRatingReaction(reaction('✅'), user('5'), ctx, true);
    await handleRatingReaction(reaction('✅', { manage: true }), user('77', true), ctx, true);
    await handleRatingReaction(reaction('👍', { manage: true }), user('5'), ctx, true);
    await handleRatingReaction(reaction('✅', { manage: true, messageId: 'other' }), user('5'), ctx, true);
    await handleRatingReaction(reaction('✅', { manage: true, guildId: 'elsewhere' }), user('5'), ctx, true);
    assert.equal(store.getAiLog('g', id)!.rating, null);
  });

});

describe('the chat channel', () => {
  const CHAT = 'chat-channel';
  const setup = () => {
    const store = new Store(':memory:');
    store.updateSettings('g', { chatChannelId: CHAT });
    addCorrection({ config, store } as never, { entry: null, question: 'Kuva Lich', text: 'An enemy that steals your Kuva.', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' });
    const replies: string[] = [];
    const ctx = { config: { ...config, ENABLE_MESSAGE_CONTENT: true }, store, client: { user: { id: 'bot' } } } as never;
    const message = (content: string, over: { mention?: boolean; reference?: { authorId: string } | null; id?: string } = {}) =>
      ({
        id: over.id ?? 'x1',
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
          return { id: `sent-${replies.length}`, react: async () => {} };
        },
      }) as unknown as Message;
    return { ctx, store, replies, message };
  };

  it('replies without a question mark, and keeps the answer in the log for corrections', async () => {
    const { ctx, store, replies, message } = setup();
    await handleChatMessage(message('Kuva Lich'), ctx);
    assert.deepEqual(replies, ['An enemy that steals your Kuva.']);
    assert.equal(store.aiLogByMessage('g', 'sent-1')?.question, 'Kuva Lich');
  });

  it('stays out of picture-only posts and of conversations between members', async () => {
    const { ctx, replies, message } = setup();
    await handleChatMessage(message(''), ctx);
    await handleChatMessage(message('Kuva Lich', { reference: { authorId: 'someone-else' } }), ctx);
    assert.deepEqual(replies, []);
    // A mention still always works, and so does a reply to the bot.
    await handleChatMessage(message('Kuva Lich', { mention: true, reference: { authorId: 'someone-else' } }), ctx);
    assert.equal(replies.length, 1);
  });
});

describe('the chat channel description', () => {
  const channelOf = (topic: string | null) => {
    const calls: string[] = [];
    return { calls, channel: { type: ChannelType.GuildText, topic, setTopic: async (t: string) => void calls.push(t) } };
  };
  const ctxFor = (channel: unknown, over: { content?: boolean; chat?: string | null } = {}) => {
    const store = new Store(':memory:');
    if (over.chat !== null) store.updateSettings('g', { chatChannelId: over.chat ?? 'c1' });
    return { config: { ...config, ENABLE_MESSAGE_CONTENT: over.content ?? true }, store, client: { channels: { fetch: async () => channel } } } as never;
  };

  it('tells members they can just write, within Discord limits', () => {
    assert.match(CHAT_TOPIC, /links the wiki pages/);
    assert.ok(CHAT_TOPIC.length <= 1024);
  });

  it('sets the description once, and leaves a matching one alone', async () => {
    const a = channelOf('old description');
    await syncChatTopic(ctxFor(a.channel));
    assert.deepEqual(a.calls, [CHAT_TOPIC]);
    const b = channelOf(CHAT_TOPIC);
    await syncChatTopic(ctxFor(b.channel));
    assert.deepEqual(b.calls, []);
  });

  it('does nothing without a chat channel or while Ordis cannot read messages, and survives a refusal', async () => {
    const a = channelOf(null);
    await syncChatTopic(ctxFor(a.channel, { chat: null }));
    await syncChatTopic(ctxFor(a.channel, { content: false }));
    assert.deepEqual(a.calls, []);
    await syncChatTopic(ctxFor({ type: ChannelType.GuildText, topic: null, setTopic: async () => Promise.reject(new Error('Missing Permissions')) }));
  });
});
