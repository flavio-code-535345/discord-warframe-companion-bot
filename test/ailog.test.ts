import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAiLog, formatAiLogEntry, logAnswer, sourceLabel } from '../src/answers/log.js';
import { Store } from '../src/db.js';

const ctxOf = (store: Store) => ({ store, config: { DISCORD_GUILD_ID: 'g' } }) as never;
const asker = { id: '42', name: 'Flavio', channelId: 'c1', via: 'chat' as const };
const answer = { content: '> Talk to **Teshin**.', embeds: [], found: true, source: 'excerpt' as const, model: null, intent: 'wiki', ms: 4200 };

describe('ai log', () => {
  it('stores questions with how they were answered and lists newest first', () => {
    const store = new Store(':memory:');
    logAnswer(ctxOf(store), asker, 'how do i unlock steel path?', answer);
    logAnswer(ctxOf(store), { ...asker, id: '7', name: 'Other' }, 'price of rhino prime', { content: 'x', embeds: [], found: true, source: 'lookup', intent: 'price', ms: 300 });
    const all = store.recentAiLog('g', 10);
    assert.equal(all.length, 2);
    assert.equal(all[0]!.question, 'price of rhino prime');
    assert.equal(all[1]!.source, 'excerpt');
    assert.equal(all[1]!.model, null);
    assert.equal(all[1]!.ms, 4200);
    assert.deepEqual(store.recentAiLog('g', 10, '42').map((e) => e.userId), ['42']);
    assert.deepEqual(store.aiLogStats('g', 0), { excerpt: 1, lookup: 1 });
  });

  it('forgets entries older than the retention window', () => {
    const store = new Store(':memory:');
    const old = { at: 1000, userId: '1', userName: 'a', channelId: null, via: 'ask' as const, question: 'old', intent: null, source: 'excerpt' as const, model: null, found: true, ms: 1, answer: null };
    store.addAiLog('g', old);
    store.addAiLog('g', { ...old, at: 1000 + 31 * 86_400_000, question: 'new' });
    assert.deepEqual(store.recentAiLog('g', 10).map((e) => e.question), ['new']);
  });

  it('never throws when the database refuses', () => {
    const store = new Store(':memory:');
    store.close();
    assert.doesNotThrow(() => logAnswer(ctxOf(store), asker, 'q', answer));
  });

  it('formats an entry and fits the embed limit', () => {
    const store = new Store(':memory:');
    logAnswer(ctxOf(store), asker, 'how do i unlock steel path?', answer);
    const [e] = store.recentAiLog('g', 1);
    const text = formatAiLogEntry(e!);
    assert.match(text, /<@42>/);
    assert.match(text, /📄 wiki excerpt/);
    assert.match(text, /4\.2s/);
    assert.match(text, /how do i unlock steel path\?/);
    assert.equal(sourceLabel({ source: 'cloud' as never, model: 'gemma' }), 'cloud (gemma)', 'an old row keeps its stored source');
    const many = Array.from({ length: 40 }, () => e!);
    assert.ok(formatAiLog(many).length <= 3800);
  });
});
