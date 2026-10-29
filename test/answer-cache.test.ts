import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { AgentRun } from '../src/agent/traces.js';
import { AnswerRefresher, REFRESH_AFTER_MS, cacheAllowedFor, cacheable, getCachedAnswer, normalizeQuestion, pickCandidates, quickCheck, refreshAnswers } from '../src/answers/cache.js';
import { smartAnswer } from '../src/answers/smart.js';
import { resetAiToggles, setAiToggle } from '../src/ai/settings.js';
import { type AiLogEntry, Store } from '../src/db.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 26, 12);
const realFetch = globalThis.fetch;
afterEach(() => {
  resetAiToggles();
  globalThis.fetch = realFetch;
});

const Q = 'Where do I get the mod Bite from?';
const ctxOf = (store = new Store(':memory:'), over: object = {}) => ({ store, config: { DISCORD_GUILD_ID: 'g', ANSWER_REFRESH_ENABLED: true, ANSWER_REFRESH_MAX: 8, ANSWER_REFRESH_HOUR_UTC: 4, OPERATOR_IDS: ['1'], ...over } }) as never;
const ask = (store: Store, question: string, over: Partial<Omit<AiLogEntry, 'id'>> = {}) =>
  store.addAiLog('g', { at: NOW - 1000, userId: '2', userName: 'Rat', channelId: null, via: 'chat', question, intent: 'wiki', source: 'local', model: 'gemma', found: true, ms: 10, answer: 'x', ...over });
const run = (calls: { name: string; result?: string; error?: boolean }[], text: string | null = 'Bite drops from Feral Kubrow enemies and is also a transmutation reward in the Foundry.', status: AgentRun['status'] = 'done'): AgentRun =>
  ({ status, text, error: text ? null : 'boom', model: 'gemma', via: 'local', steps: [{ calls: calls.map((c) => ({ name: c.name, args: { q: 'bite' }, result: c.result ?? 'Bite: dropped by Feral Kubrow', error: c.error ?? false, ms: 1 })) }] }) as unknown as AgentRun;

describe('what may be cached', () => {
  it('normalizes questions and refuses anything live', () => {
    assert.equal(normalizeQuestion('How do I unlock Venus?'), normalizeQuestion('how do i  unlock venus'));
    assert.ok(cacheable(Q));
    for (const live of ['what is Baro selling today?', 'price of Wisp Prime', 'what are the fissures right now', 'when is our next clan event?', 'what is in the latest update']) assert.equal(cacheable(live), false, live);
    assert.equal(cacheable('hi'), false);
    assert.ok(!cacheAllowedFor('price') && !cacheAllowedFor('world') && cacheAllowedFor('wiki') && cacheAllowedFor('drops'));
  });

  it('rejects answers that only describe the item, hedge, or are too short', () => {
    assert.match(quickCheck(Q, 'Bite is a mod for Beast Claws. It increases Critical Chance and Critical Damage for your companion.')!, /does not say how it is obtained/);
    assert.equal(quickCheck(Q, 'Bite is a Beast Claws mod. It is dropped by Feral Kubrow and can also be obtained by transmutation.'), null);
    assert.match(quickCheck(Q, 'I could not find where this drops, sorry about that, please check the wiki yourself.')!, /could not find/);
    assert.match(quickCheck(Q, 'Feral Kubrow.')!, /too short/);
    // A non-acquisition question needs no acquisition wording.
    assert.equal(quickCheck('What does the mod Bite do?', 'Bite increases Critical Chance and Critical Damage of Beast Claws attacks.'), null);
  });
});

describe('choosing what to research', () => {
  const log = (q: string, n: number, over: Partial<AiLogEntry> = {}): AiLogEntry[] => Array.from({ length: n }, (_, i) => ({ id: i, at: NOW - i * 1000, userId: '2', userName: 'r', channelId: null, via: 'chat', question: q, intent: 'wiki', source: 'local', model: 'g', found: true, ms: 1, answer: null, messageId: null, rating: null, ...over }));

  it('takes the most asked first, only questions asked twice or more, capped', () => {
    const entries = [...log('where do I get bite', 3), ...log('how does arbitrations work', 5), ...log('what is a kuva lich', 1), ...log('how do i get Rhino', 2)];
    const picks = pickCandidates(entries, [], NOW, 2);
    assert.deepEqual(picks.map((p) => [p.key, p.asks]), [['how does arbitrations work', 5], ['where do i get bite', 3]]);
  });

  it('ignores exact lookups, operator answers, failed answers and live questions', () => {
    const entries = [...log('where does neo n16 drop', 3, { source: 'lookup' }), ...log('design me a build', 3, { intent: 'operator' }), ...log('where do I get bite', 3, { found: false }), ...log('what is baro selling today', 3)];
    assert.deepEqual(pickCandidates(entries, [], NOW, 8), []);
  });

  it('leaves fresh answers alone, re-researches old ones that are still asked, and backs off from failures', () => {
    const entries = log('where do I get bite', 3);
    const row = (over: object) => ({ key: 'where do i get bite', question: 'x', answer: 'a', model: null, tools: [], verifiedAt: NOW - DAY, refreshedAt: NOW - DAY, hits: 0, lastAskedAt: null, fails: 0, lastError: null, lastAttemptAt: null, ...over }) as never;
    assert.equal(pickCandidates(entries, [row({})], NOW, 8).length, 0, 'fresh');
    assert.equal(pickCandidates(entries, [row({ refreshedAt: NOW - REFRESH_AFTER_MS - DAY })], NOW, 8).length, 1, 'old and still asked');
    assert.equal(pickCandidates(log('where do I get bite', 3).map((e) => ({ ...e, at: NOW - 30 * DAY })), [row({ refreshedAt: NOW - 20 * DAY })], NOW, 8).length, 0, 'old but nobody asks it any more');
    assert.equal(pickCandidates(entries, [row({ verifiedAt: null, answer: '', fails: 1, lastAttemptAt: NOW - 3_600_000 })], NOW, 8).length, 0, 'a failure is not retried within the day');
    assert.equal(pickCandidates(entries, [row({ verifiedAt: null, answer: '', fails: 1, lastAttemptAt: NOW - 2 * DAY })], NOW, 8).length, 1, 'but is the next day');
    assert.equal(pickCandidates(entries, [row({ verifiedAt: null, answer: '', fails: 3, lastAttemptAt: NOW - 2 * DAY })], NOW, 8).length, 0, 'three failures: leave it for a week');
  });
});

describe('the daily refresh', () => {
  const good = async () => run([{ name: 'search_wiki' }, { name: 'search_drops' }]);
  const pass = async () => 'PASS';

  it('researches, verifies and saves, and the saved answer is then served', async () => {
    const store = new Store(':memory:');
    ask(store, Q);
    ask(store, Q.toLowerCase());
    const ctx = ctxOf(store);
    const prompts: string[] = [];
    const s = await refreshAnswers(ctx, {}, { now: NOW, research: async (_c, p) => (prompts.push(p), good()), judge: pass });
    assert.equal(s!.saved, 1);
    assert.match(prompts[0]!, /state exactly how it is obtained/);
    const hit = getCachedAnswer(ctx, 'where do i get the mod bite from', NOW)!;
    assert.match(hit.answer, /Feral Kubrow/);
    assert.deepEqual(hit.tools, ['search_wiki', 'search_drops']);
    assert.equal(getCachedAnswer(ctx, Q, NOW + 15 * DAY), null, 'expires after two weeks');
    setAiToggle(store, 'cache', false);
    assert.equal(getCachedAnswer(ctx, Q, NOW), null, 'the switch turns serving off');
  });

  it('does not save failed research or unverified guesses, and keeps a previous answer when a refresh fails', async () => {
    const store = new Store(':memory:');
    ask(store, Q);
    ask(store, Q);
    const ctx = ctxOf(store);
    const cases: [string, () => Promise<AgentRun>, (s: string, u: string) => Promise<string | null>, RegExp][] = [
      ['agent failed', async () => run([], null, 'failed'), pass, /boom/],
      ['answered from memory', async () => run([]), pass, /found nothing/],
      ['only failed lookups', async () => run([{ name: 'search_wiki', error: true }, { name: 'search_drops', result: '{"error":"none"}' }]), pass, /found nothing/],
      ['used live data', async () => run([{ name: 'search_wiki' }, { name: 'price_check' }]), pass, /live data/],
      ['describes only', async () => run([{ name: 'search_wiki' }], 'Bite is a mod for Beast Claws that increases Critical Chance and Critical Damage of the attacks.'), pass, /does not say how/],
      ['judge says no', good, async () => 'FAIL: the answer invents a drop rate', /check rejected it: FAIL: the answer invents/],
      ['no judge model', good, async () => null, /no model was available/],
    ];
    let day = 0;
    for (const [name, research, judge, reason] of cases) {
      const s = await refreshAnswers(ctx, {}, { now: NOW + ++day * 8 * DAY, research, judge });
      assert.equal(s!.saved, 0, name);
      assert.match(s!.rejected[0]!.reason, reason, name);
    }
    assert.equal(getCachedAnswer(ctx, Q, NOW), null, 'nothing was cached');
    assert.ok(store.getCacheRow('g', normalizeQuestion(Q))!.fails >= 3);

    // Now a good answer is saved; later a failing refresh leaves it exactly as it was.
    await refreshAnswers(ctx, {}, { now: NOW + 70 * DAY, research: good, judge: pass });
    const saved = store.getCacheRow('g', normalizeQuestion(Q))!;
    assert.ok(saved.verifiedAt);
    const later = NOW + 70 * DAY + REFRESH_AFTER_MS + 2 * DAY;
    ask(store, Q, { at: later - 1000 });
    ask(store, Q, { at: later - 2000 });
    const s = await refreshAnswers(ctx, {}, { now: later, research: async () => run([{ name: 'search_wiki' }], 'Bite is obtained from a completely different place: dropped by a boss.'), judge: async () => 'FAIL: not supported' });
    assert.equal(s!.saved, 0);
    const after = store.getCacheRow('g', normalizeQuestion(Q))!;
    assert.equal(after.answer, saved.answer);
    assert.equal(after.refreshedAt, saved.refreshedAt);
    assert.equal(after.fails, 1);
  });

  it('limits the work per run and makes no model calls when there is nothing to do', async () => {
    const store = new Store(':memory:');
    let calls = 0;
    const deps = { now: NOW, research: async () => (calls++, good()), judge: pass };
    assert.equal((await refreshAnswers(ctxOf(store), {}, deps))!.picked, 0);
    assert.equal(calls, 0);
    for (const q of ['how does arbitrations work', 'how do kuva liches work', 'what are archon shards for']) {
      ask(store, q);
      ask(store, q);
    }
    const s = await refreshAnswers(ctxOf(store, { ANSWER_REFRESH_MAX: 2 }), {}, deps);
    assert.equal(s!.picked, 2);
    assert.equal(calls, 2);
  });

  it('runs once a day, after the set hour, and only when enabled', async () => {
    const store = new Store(':memory:');
    const refresher = (over: object = {}) => new AnswerRefresher(ctxOf(store, over));
    assert.equal(await refresher().check(new Date('2026-10-26T03:00:00Z')), false, 'before the hour');
    assert.equal(await refresher({ ANSWER_REFRESH_ENABLED: false }).check(new Date('2026-10-26T05:00:00Z')), false, 'disabled');
    assert.equal(await refresher().check(new Date('2026-10-26T05:00:00Z')), true);
    assert.equal(await refresher().check(new Date('2026-10-26T09:00:00Z')), false, 'already ran today');
    assert.equal(await refresher().check(new Date('2026-10-27T04:30:00Z')), true, 'and again the next day');
  });
});

describe('serving', () => {
  it('answers a repeat question from the cache without a model, except for operators and live intents', async () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    store.saveCachedAnswer('g', { key: normalizeQuestion(Q), question: Q, answer: 'Bite drops from Feral Kubrow.', model: 'gemma', tools: ['search_wiki'], now: Date.now() });
    globalThis.fetch = async () => new Response('{}', { status: 500 });
    const hit = await smartAnswer(Q, ctx, { id: '2', name: 'Rat' });
    assert.equal(hit.source, 'cache');
    assert.equal(hit.content, 'Bite drops from Feral Kubrow.');
    assert.equal(hit.model, 'gemma');
    assert.equal(store.getCacheRow('g', normalizeQuestion(Q))!.hits, 1);

    // Operators always get a fresh answer (no model is set up here, so it is the plain path, not the cache).
    assert.notEqual((await smartAnswer(Q, ctx, { id: '1', name: 'Boss' })).source, 'cache');
    // A live question never reads the cache, even when a row exists for it.
    store.saveCachedAnswer('g', { key: normalizeQuestion('price of wisp prime'), question: 'price of wisp prime', answer: 'stale 100p', model: null, tools: [], now: Date.now() });
    assert.notEqual((await smartAnswer('price of wisp prime', ctx, { id: '2', name: 'Rat' })).content, 'stale 100p');
  });

  it('forgets one answer and prunes old ones', () => {
    const store = new Store(':memory:');
    store.saveCachedAnswer('g', { key: 'a', question: 'a', answer: 'x', model: null, tools: [], now: NOW });
    store.saveCachedAnswer('g', { key: 'b', question: 'b', answer: 'y', model: null, tools: [], now: NOW - 60 * DAY });
    store.recordCacheFailure('g', { key: 'c', question: 'c', reason: 'nope', now: NOW - 60 * DAY });
    assert.equal(store.pruneCache('g', NOW - 45 * DAY), 2);
    assert.deepEqual(store.listCacheRows('g').map((r) => r.key), ['a']);
    assert.ok(store.deleteCacheRow('g', 'a'));
    assert.equal(store.deleteCacheRow('g', 'a'), false);
  });
});
