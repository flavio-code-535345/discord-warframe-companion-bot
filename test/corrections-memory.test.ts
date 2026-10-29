import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { PermissionFlagsBits, type Message } from 'discord.js';
import { brain, normalizeBrain, resetBrainState, updateBrain } from '../src/agent/brain.js';
import { useAgent } from '../src/agent/answer.js';
import { resetCapabilities } from '../src/ai/ollama.js';
import { resetAiToggles } from '../src/ai/settings.js';
import { normalizeQuestion } from '../src/answers/cache.js';
import { resetLocalAi } from '../src/answers/compose.js';
import { addCorrection, approveCorrection, findCorrection, guidanceFor, isStaff, rejectCorrection } from '../src/answers/corrections.js';
import { MEMORY_TTL_MS, forget, isFollowUp, memoryKey, recall, remember, transcript } from '../src/answers/memory.js';
import { smartAnswer } from '../src/answers/smart.js';
import { Store } from '../src/db.js';
import { handleCorrectionReply } from '../src/discord/corrections.js';

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
  forget();
  resetBrainState();
  resetAiToggles();
  resetLocalAi();
  resetCapabilities();
});

describe('conversation memory', () => {
  it('replays the last N messages of one person in one channel, oldest first', () => {
    const key = memoryKey('c1', 'u1');
    remember(key, 'q1', 'a1');
    remember(key, 'q2', 'a2');
    remember(key, 'q3', 'a3');
    assert.deepEqual(recall(key, 10).map((t) => t.content), ['q1', 'a1', 'q2', 'a2', 'q3', 'a3']);
    assert.deepEqual(recall(key, 3).map((t) => t.content), ['a2', 'q3', 'a3'], 'the newest N messages');
    assert.deepEqual(recall(key, 0), [], '0 turns it off');
    assert.deepEqual(recall(memoryKey('c2', 'u1'), 10), [], 'another channel is another conversation');
    assert.deepEqual(recall(memoryKey('c1', 'u2'), 10), [], 'and so is another person');
    assert.notEqual(memoryKey(null, 'u1'), memoryKey('c1', 'u1'));
  });

  it('forgets a conversation that has been quiet too long', () => {
    const key = memoryKey('c1', 'u1');
    remember(key, 'q', 'a', 1_000);
    assert.equal(recall(key, 10, 1_000 + MEMORY_TTL_MS - 1).length, 2);
    assert.equal(recall(key, 10, 1_000 + MEMORY_TTL_MS + 1).length, 0);
    // A new question after the pause starts a fresh conversation instead of resuming the stale one.
    remember(key, 'old', 'old', 1_000);
    remember(key, 'new', 'new', 1_000 + MEMORY_TTL_MS + 5);
    assert.deepEqual(recall(key, 10, 1_000 + MEMORY_TTL_MS + 6).map((t) => t.content), ['new', 'new']);
  });

  it('never keeps more than the slider maximum and cuts long messages', () => {
    const key = memoryKey('c', 'u');
    for (let i = 0; i < 50; i++) remember(key, `q${i}`, 'x'.repeat(5000));
    const all = recall(key, 1000);
    assert.equal(all.length, 30);
    assert.ok(all.every((t) => t.content.length <= 1200));
  });

  it('spots messages that lean on what was said before', () => {
    for (const f of ['and how do I get it?', 'what about its drops', 'why?', 'where does that drop', 'Thanks!', 'is there a faster way for them?']) assert.equal(isFollowUp(f), true, f);
    for (const s of ['where does Neo N16 drop?', 'how do archon shards work?', 'what is baro selling']) assert.equal(isFollowUp(s), false, s);
    assert.equal(isFollowUp('how do I get it when the game says I need to finish the quest first and then wait for the next update to happen'), false, 'long messages stand alone');
  });

  it('writes a transcript for single-shot prompts', () => {
    assert.equal(transcript([{ role: 'user', content: 'a  b' }, { role: 'assistant', content: 'c' }]), 'Member: a b\nOrdis: c');
  });

  it('has a slider setting that defaults to 10, clamps to 0-30, and survives a save', () => {
    assert.equal(brain().memoryMessages, 10);
    assert.equal(normalizeBrain({ memoryMessages: 99 }).memoryMessages, 30);
    assert.equal(normalizeBrain({ memoryMessages: -4 }).memoryMessages, 0);
    assert.equal(normalizeBrain({ memoryMessages: '7' }).memoryMessages, 7);
    assert.equal(normalizeBrain({ memoryMessages: 'x' }).memoryMessages, 10);
    const store = new Store(':memory:');
    updateBrain(store, { memoryMessages: 4 });
    assert.match(store.getMeta('brain_settings') ?? '', /"memoryMessages":4/);
  });
});

describe('corrections', () => {
  const Q = 'How do I get Condition Overload?';
  const entry = (store: Store, over: object = {}) => {
    const id = store.addAiLog('g', { at: Date.now(), userId: '5', userName: 'Rat', channelId: 'c', via: 'chat', question: Q, intent: 'wiki', source: 'local', model: 'gemma', found: true, ms: 10, answer: 'It drops from Grineer.', messageId: 'm1', ...over });
    return store.getAiLog('g', id)!;
  };

  it('saves a staff correction as approved at once, and drops the saved answer and marks the answer wrong', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    store.saveCachedAnswer('g', { key: normalizeQuestion(Q), question: Q, answer: 'old', model: null, tools: [], now: Date.now() });
    const e = entry(store);
    const r = addCorrection(ctx, { entry: e, text: 'It is a Steel Path Honors purchase.', authorId: '7', authorName: 'Boss', staff: true, source: 'staff_reply' })!;
    assert.equal(r.status, 'approved');
    assert.equal(findCorrection(ctx, 'how do i get condition overload')?.correction, 'It is a Steel Path Honors purchase.');
    assert.equal(store.getCacheRow('g', normalizeQuestion(Q)), null, 'the saved answer for that question is gone');
    assert.equal(store.getAiLog('g', e.id)!.rating, 'wrong');
    assert.equal(store.getCorrection('g', r.id)!.badAnswer, 'It drops from Grineer.');
  });

  it('keeps a member reply pending until staff approve it, with their edit', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    const r = addCorrection(ctx, { entry: entry(store), text: 'Buy it at Teshin.', authorId: '5', authorName: 'Rat', staff: false, source: 'member_reply' })!;
    assert.equal(r.status, 'pending');
    assert.equal(findCorrection(ctx, Q), null, 'a suggestion is never served');
    assert.equal(guidanceFor(ctx, Q), '', 'nor shown to the model');
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

  it('gives the model related corrections and rated answers, and nothing unrelated', () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    addCorrection(ctx, { entry: null, question: Q, text: 'Buy it from Steel Path Honors.', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' });
    const wrong = entry(store, { question: 'Where can I farm Galvanized Aptitude arcane?', answer: 'In the Void, from the Tenno.', messageId: 'm2' });
    store.rateAiLog('g', wrong.id, 'wrong', '7');
    const right = entry(store, { question: 'What does the Kuva Lich weakness mean?', answer: 'It is the element that defeats the lich.', messageId: 'm3' });
    store.rateAiLog('g', right.id, 'right', '7');

    const g = guidanceFor(ctx, 'how can I get the Condition Overload mod');
    assert.match(g, /Staff corrections/);
    assert.match(g, /Steel Path Honors/);
    assert.doesNotMatch(g, /Galvanized/);
    assert.match(guidanceFor(ctx, 'where do I farm galvanized aptitude arcane'), /marked WRONG[\s\S]*Void, from the Tenno/);
    assert.match(guidanceFor(ctx, 'what does the kuva lich weakness do'), /marked RIGHT[\s\S]*element that defeats/);
    assert.equal(guidanceFor(ctx, 'when does baro arrive'), '', 'unrelated questions get nothing');
  });

  it('serves the correction word for word, ahead of everything, except for a follow-up', async () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    addCorrection(ctx, { entry: null, question: Q, text: 'Steel Path Honors, 15 Steel Essence.', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' });
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    const a = await smartAnswer(Q, ctx, { id: '5', name: 'Rat' });
    assert.equal(a.source, 'correction');
    assert.equal(a.content, 'Steel Path Honors, 15 Steel Essence.');
    assert.equal(a.intent, 'correction');
    const operator = await smartAnswer('how do i get condition overload??', ctx, { id: '1', name: 'Boss' });
    assert.equal(operator.source, 'correction', 'operators get it too');
  });

  it('writes the exchange into memory and uses it for the next, short question', async () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    const key = memoryKey('c', '5');
    addCorrection(ctx, { entry: null, question: Q, text: 'Steel Path Honors.', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' });
    await smartAnswer(Q, ctx, { id: '5', name: 'Rat', key });
    assert.deepEqual(recall(key, 10).map((t) => t.content), [Q, 'Steel Path Honors.']);

    // The follow-up goes to the agent with the earlier messages, whoever asks, and is not answered from the pronoun alone.
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/api/show')) return new Response(JSON.stringify({ capabilities: [] }));
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'It costs 15 Steel Essence.' } }] }));
    }) as typeof fetch;
    const a = await smartAnswer('and how much does it cost?', ctx, { id: '5', name: 'Rat', key });
    assert.equal(a.intent, 'agent');
    assert.equal(a.content, 'It costs 15 Steel Essence.');
    const sent = bodies[0]!.messages;
    assert.deepEqual(sent.slice(1, 3).map((m) => [m.role, m.content]), [['user', Q], ['assistant', 'Steel Path Honors.']]);
    assert.match(sent[0]!.content, /Staff corrections/, 'the related correction is in the prompt');
    assert.deepEqual(recall(key, 10).map((t) => t.content).slice(-2), ['and how much does it cost?', 'It costs 15 Steel Essence.']);
  });

  it('keeps conversations apart and does nothing with memory switched off', async () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    addCorrection(ctx, { entry: null, question: Q, text: 'Steel Path Honors.', authorId: '7', authorName: 'Boss', staff: true, source: 'panel' });
    updateBrain(store, { memoryMessages: 0 });
    const key = memoryKey('c', '5');
    await smartAnswer(Q, ctx, { id: '5', name: 'Rat', key });
    assert.deepEqual(recall(key, 10), []);
  });

  it('sends follow-ups to the agent for everyone, but ordinary questions only as the Brain settings say', () => {
    const ctx = ctxOf();
    assert.equal(useAgent(ctx, '5', 'wiki'), false, 'default: operators only');
    assert.equal(useAgent(ctx, '5', 'drops'), false);
    assert.equal(useAgent(ctx, '5', 'drops', true), true, 'a follow-up needs the conversation in front of the model');
    assert.equal(useAgent(ctx, '5', 'help', true), false);
    updateBrain(new Store(':memory:'), { agentFor: 'off' });
    assert.equal(useAgent(ctx, '5', 'drops', true), false, 'switched off means off');
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
