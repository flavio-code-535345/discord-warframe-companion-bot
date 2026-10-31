import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Store } from '../src/db.js';
import { levelOf, xpForLevel } from '../src/leveling/xp.js';
import { normalizeQuestion, registerInsightTools, summarizeAiLog } from '../src/mcp/insights.js';

type Handler = (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;

function setup(store: Store, members: Record<string, { bot?: boolean; name: string }> = {}) {
  const guild = {
    id: 'g',
    memberCount: 3,
    members: {
      cache: new Map(Object.entries(members).map(([id, m]) => [id, { displayName: m.name }])),
      me: null,
      fetch: async (id: string) => (members[id] ? { id, displayName: members[id]!.name, user: { bot: Boolean(members[id]!.bot) }, roles: { cache: new Map() } } : Promise.reject(new Error('unknown'))),
    },
    roles: { cache: new Map() },
  };
  const client = { isReady: () => true, ws: { ping: 42 }, guilds: { cache: new Map([['g', guild]]), fetch: async () => guild } };
  const ctx = { store, client, config: { DISCORD_GUILD_ID: 'g', LOCAL_AI_URL: 'http://h/v1', LOCAL_AI_MODEL: 'gemma', FREE_AI_MODEL: 'gem', FREE_AI_DAILY_LIMIT: 150 }, ai: null };
  const server = new McpServer({ name: 't', version: '1' });
  registerInsightTools(server, ctx as never);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools;
  const call = async (name: string, args: unknown = {}) => JSON.parse((await tools[name]!.handler(args)).content[0]!.text);
  return { call, tools };
}

const entry = (over: Partial<Parameters<Store['addAiLog']>[1]> = {}) => ({
  at: Date.now(),
  userId: '1',
  userName: 'A',
  channelId: 'c',
  via: 'chat' as const,
  question: 'How do I unlock Venus?',
  intent: 'wiki',
  source: 'excerpt' as const,
  model: null,
  found: true,
  ms: 4000,
  answer: 'Do things.',
  ...over,
});

describe('ai log tool', () => {
  it('normalizes questions and finds repeats and unanswered ones', () => {
    assert.equal(normalizeQuestion('  How do I unlock Venus?! '), 'how do i unlock venus');
    const s = summarizeAiLog([
      { source: 'excerpt', intent: 'wiki', found: true, question: 'How do I unlock Venus?' },
      { source: 'excerpt', intent: 'wiki', found: true, question: 'how do i unlock venus' },
      { source: 'lookup', intent: 'price', found: false, question: 'price of nothing' },
    ]);
    assert.equal(s.count, 3);
    assert.deepEqual(s.bySource, { excerpt: 2, lookup: 1 });
    assert.equal(s.unanswered, 1);
    assert.deepEqual(s.repeatedQuestions, [{ question: 'how do i unlock venus', times: 2 }]);
  });

  it('filters by member, source and unanswered', async () => {
    const store = new Store(':memory:');
    store.addAiLog('g', entry());
    store.addAiLog('g', entry({ userId: '2', userName: 'B', source: 'lookup', question: 'price of rhino', found: false }));
    const { call } = setup(store);
    assert.equal((await call('get_ai_log', { limit: 10 })).entries.length, 2);
    assert.deepEqual((await call('get_ai_log', { limit: 10, user_id: '2' })).entries.map((e: { user: string }) => e.user), ['B']);
    assert.equal((await call('get_ai_log', { limit: 10, source: 'excerpt' })).entries.length, 1);
    assert.equal((await call('get_ai_log', { limit: 10, only_unanswered: true })).entries.length, 1);
  });
});

describe('bot health tool', () => {
  it('reports models, lifecycle and answer counts', async () => {
    const store = new Store(':memory:');
    store.addAiLog('g', entry());
    store.setMeta('lifecycle_state', 'running');
    const out = await setup(store).call('get_bot_health');
    assert.equal(out.discord.ready, true);
    assert.equal(out.lifecycle.state, 'running');
    assert.equal(out.ai.localModel, 'gemma');
    assert.deepEqual(out.answersLast24h, { excerpt: 1 });
    assert.equal(out.features.leveling, true);
  });
});

describe('member level tools', () => {
  it('lists members by level range and lifts them with only_raise', async () => {
    const store = new Store(':memory:');
    store.setXp('g', '1', xpForLevel(3));
    store.setXp('g', '2', xpForLevel(12));
    const { call } = setup(store, { '1': { name: 'Low' }, '2': { name: 'High' }, '3': { name: 'Newbie' }, '4': { name: 'Bot', bot: true } });
    const low = await call('list_member_levels', { max_level: 9 });
    assert.deepEqual(low.members.map((m: { name: string }) => m.name), ['Low']);

    const out = await call('set_member_level', { user_ids: ['1', '2', '3', '4', '999'], level: 10, only_raise: true });
    const by = Object.fromEntries(out.results.map((r: { userId: string; result: string }) => [r.userId, r.result]));
    assert.equal(by['1'], 'updated');
    assert.equal(by['2'], 'already at or above this level');
    assert.equal(by['3'], 'updated');
    assert.equal(by['4'], 'bots do not level up');
    assert.equal(by['999'], 'not in the server');
    assert.equal(levelOf(store.getMemberXp('g', '1')!.xp), 10);
    assert.equal(levelOf(store.getMemberXp('g', '2')!.xp), 12);
    assert.equal(levelOf(store.getMemberXp('g', '3')!.xp), 10);
  });
});
