import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { AskLimiter } from '../src/ai/limits.js';
import { OrdisBrain, splitForDiscord } from '../src/ai/ordis.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { stripMention } from '../src/discord/chat.js';

const GUILD = '111111111111111111';

function message(content: unknown[], stop_reason: string) {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

test('OrdisBrain runs a tool round-trip against the Messages API and returns the final text', async () => {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const replies = [
    message([{ type: 'tool_use', id: 'toolu_1', name: 'get_clan_info', input: {} }], 'tool_use'),
    message([{ type: 'text', text: 'Your clan has one event, Operator.' }], 'end_turn'),
  ];
  const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(replies.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD, ANTHROPIC_API_KEY: 'test-key' });
  const store = new Store(':memory:');
  store.createEvent({ guildId: GUILD, title: 'Eidolon hunt', description: null, startsAt: Date.now() + 3_600_000, createdBy: 'u1' });
  const client = new Anthropic({ apiKey: 'test-key', fetch: fakeFetch as typeof fetch, maxRetries: 0 });

  const result = await new OrdisBrain(config, store, client).ask({
    question: 'What events do we have?',
    history: [{ role: 'assistant', text: 'Hello Operator!' }],
    askerName: 'Flavio',
    askerIgn: 'RatKing',
    where: '#general',
  });

  assert.equal(result.text, 'Your clan has one event, Operator.');
  assert.deepEqual(result.toolsUsed, ['get_clan_info']);
  assert.equal(requests.length, 2);

  const first = requests[0]!;
  assert.equal(first.body.model, 'claude-opus-5-5');
  assert.equal(first.body.fallbacks, 'default');
  assert.match(first.headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  assert.deepEqual(first.body.output_config, { effort: 'medium' });
  assert.deepEqual(first.body.cache_control, { type: 'ephemeral' });
  const tools = first.body.tools as { name: string; type?: string }[];
  assert.ok(tools.some((t) => t.type === 'web_search_20260209'));
  assert.ok(tools.some((t) => t.name === 'lookup_item'));
  // A history that starts with Ordis's own answer gets a user stub so the API sees a user turn first.
  const msgs = first.body.messages as { role: string; content: unknown }[];
  assert.equal(msgs[0]!.role, 'user');
  assert.match(String(msgs.at(-1)!.content), /RatKing/);

  // The second request carries the tool result produced by our get_clan_info implementation.
  const second = requests[1]!.body.messages as { role: string; content: { type: string; content?: unknown }[] }[];
  const toolResult = second.at(-1)!.content.find((b) => b.type === 'tool_result');
  assert.match(JSON.stringify(toolResult), /Eidolon hunt/);
});

test('OrdisBrain reports refusals without leaking partial content', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify(message([], 'refusal')), { status: 200, headers: { 'content-type': 'application/json' } });
  const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD, ANTHROPIC_API_KEY: 'k', AI_MODEL: 'claude-haiku-5-5', AI_WEB_SEARCH: 'false' });
  const client = new Anthropic({ apiKey: 'k', fetch: fakeFetch as typeof fetch, maxRetries: 0 });
  const result = await new OrdisBrain(config, new Store(':memory:'), client).ask({ question: 'x', history: [], askerName: 'a', askerIgn: null, where: 'dm' });
  assert.equal(result.refused, true);
});

test('AskLimiter enforces per-user hourly and global daily limits', () => {
  const limiter = new AskLimiter(2, 3);
  const t0 = Date.UTC(2026, 9, 25, 12);
  assert.equal(limiter.take('a', t0).ok, true);
  assert.equal(limiter.take('a', t0 + 1).ok, true);
  const blocked = limiter.take('a', t0 + 2);
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.reason, 'user');
  assert.equal(limiter.take('a', t0 + 3_600_001).ok, true); // window slid; this is the 3rd of the day
  const daily = limiter.take('b', t0 + 3_600_002);
  assert.equal(!daily.ok && daily.reason, 'daily');
  assert.equal(limiter.take('b', Date.UTC(2026, 9, 26, 0, 1)).ok, true); // new UTC day
});

test('splitForDiscord keeps chunks under the limit at natural boundaries', () => {
  const para = 'word '.repeat(300).trim();
  const chunks = splitForDiscord(`${para}\n\n${para}`, 1900);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 1900));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), `${para} ${para}`);
});

test('stripMention removes both mention forms of the bot only', () => {
  assert.equal(stripMention('<@123> hi <@!123> there <@456>', '123'), 'hi  there <@456>');
});
