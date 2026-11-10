import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { calculate } from '../src/answers/calc.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { DEFAULT_MENTIONS, createClient } from '../src/discord/bot.js';
import { type EmojiName, cycleEmoji, e, emojiFor, emojiUrl, loadEmojis, shardEmoji, tierEmoji } from '../src/discord/emoji.js';
import { STATUS_TTL_MS, startHttpServer } from '../src/http.js';
import { ApiClient, readText } from '../src/warframe/fetch.js';
import { type WorldState, archimedeaName } from '../src/warframe/worldstate.js';
import { buildStatus, escapeHtml, renderStatusPage } from '../src/web/status.js';
import { cleanWikitext } from '../src/wiki/clean.js';

/**
 * What the code and security audit of 2026-11-10 fixed. The common thread: text and numbers that come from outside (a member, the
 * wiki, the world state feed) must never be trusted to have the shape the code expects.
 */

const GUILD = '111111111111111111';
const HOUR = 3_600_000;

describe('names that every JavaScript object inherits are not table entries', () => {
  it('the calculator knows only its own functions and constants', () => {
    assert.throws(() => calculate('constructor(2)+1'), /unknown function "constructor"/);
    assert.throws(() => calculate('constructor+1'), /unknown name "constructor"/);
    assert.equal(calculate('sqrt(16)+1'), 5);
    assert.ok(Math.abs(calculate('2*pi') - 2 * Math.PI) < 1e-12);
  });

  it('the wiki text keeps an entity it does not know as it is', () => {
    assert.equal(cleanWikitext('Fish &amp; chips &constructor; done'), 'Fish & chips &constructor; done');
  });

  it('an unknown relic tier, cycle state or emoji name is "no emoji", not an exception', () => {
    loadEmojis([]);
    assert.equal(tierEmoji('constructor'), e('fissure'));
    assert.equal(tierEmoji(42 as never), e('fissure'));
    assert.equal(cycleEmoji(7 as never), '');
    assert.equal(shardEmoji({} as never), e('archon'));
    assert.equal(e('constructor' as EmojiName), '');
    assert.equal(emojiUrl('toString' as EmojiName), null);
    assert.ok(emojiFor('nothing' as EmojiName).name);
    assert.equal(archimedeaName('constructor'), 'constructor');
    assert.equal(archimedeaName('C T_ L A B'), 'Deep Archimedea');
  });
});

describe('the public status page with a feed that sends the wrong things', () => {
  const soon = () => new Date(Date.now() + 10 * 60_000);
  const attack = '<img src=x onerror=alert(1)>';
  /** A world state whose numbers are HTML and whose names are inherited property names. */
  const hostile = () =>
    ({
      cetusCycle: { isDay: true, expiry: soon() },
      vallisCycle: { isWarm: false, expiry: soon() },
      cambionCycle: { state: 'constructor', expiry: soon() },
      zarimanCycle: { state: 'corpus', expiry: soon() },
      earthCycle: { isDay: false, expiry: soon() },
      duviriCycle: { state: 'joy', expiry: soon(), choices: [] },
      voidTrader: { location: 'Larunda Relay', activation: new Date(Date.now() - HOUR), expiry: soon(), inventory: [{ item: 'Primed Fury', ducats: attack, credits: 1 }] },
      steelPath: { currentReward: { name: 'Umbra Forma', cost: attack }, rotation: [], expiry: soon() },
      dailyDeals: [{ item: 'Ignis', salePrice: attack, originalPrice: attack, discount: attack, total: attack, sold: 1, expiry: soon() }],
      nightwave: { season: attack, expiry: soon(), activeChallenges: [{ title: 'Sortie Expert', isDaily: false, isElite: true, reputation: attack }] },
      fissures: [{ tier: 'constructor', missionType: 'Capture', node: 'Hepit (Void)', enemy: 'Corrupted', expiry: soon(), isHard: false, isStorm: false }],
      archimedeas: [{ type: 'constructor', missions: [] }],
      invasions: [],
      events: [],
      alerts: [],
    }) as unknown as WorldState;

  const ctx = (): AppContext => ({
    config: loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }),
    store: new Store(':memory:'),
    client: { isReady: () => false } as unknown as Client,
  });

  it('writes numbers as numbers and survives names it has no entry for', async () => {
    loadEmojis([]);
    const status = await buildStatus(ctx(), async () => hostile(), () => null);
    assert.equal(status.world?.baro?.items[0]?.ducats, 0, 'a ducat price that is not a number counts as 0');
    assert.equal(status.world?.nightwave?.season, 0);
    assert.equal(status.world?.nightwave?.challenges[0]?.reputation, 0);
    assert.equal(status.world?.steelPath?.cost, 0);
    assert.deepEqual([status.world?.darvo?.price, status.world?.darvo?.original, status.world?.darvo?.total], [0, 0, 0]);

    const html = renderStatusPage(status, 'nonce');
    assert.ok(!html.includes('<img src=x'), 'nothing from the feed is written as markup');
    assert.ok(!html.includes('[native code]'), 'no built-in function ends up as text');
    assert.match(html, /data-tier="constructor"/, 'the odd fissure is still listed, by its name');
    assert.match(html, /Primed Fury/);
  });

  it('escapes whatever it is given', () => {
    assert.equal(escapeHtml('<b>"x" & \'y\'</b>'), '&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
    assert.equal(escapeHtml(12), '12');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml({ toString: () => '<i>' }), '&lt;i&gt;');
  });
});

describe('pings', () => {
  it('a message that does not say otherwise can ping the members it names, never a role or everyone', async () => {
    assert.deepEqual(DEFAULT_MENTIONS, { parse: ['users'], repliedUser: true });
    const client = createClient({ ENABLE_WELCOME: false, ENABLE_MESSAGE_CONTENT: false, ENABLE_MEMBER_LOGGING: false });
    try {
      assert.deepEqual(client.options.allowedMentions, { parse: ['users'], repliedUser: true });
    } finally {
      await client.destroy();
    }
  });
});

describe('addresses in the configuration', () => {
  const base = { DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD };

  it('must be web addresses', () => {
    for (const key of ['WORLDSTATE_URL', 'LOCAL_AI_URL', 'FREE_AI_URL', 'SEARXNG_URL', 'WATCHTOWER_URL', 'PUBLIC_URL']) {
      assert.throws(() => loadConfig({ ...base, [key]: 'file:///etc/passwd' }), new RegExp(`${key}: must start with http`), key);
      assert.throws(() => loadConfig({ ...base, [key]: 'data:text/plain,hello' }), /must start with http/, key);
    }
    const ok = loadConfig({ ...base, WORLDSTATE_URL: 'http://relay.lan:8080/pc', SEARXNG_URL: 'HTTPS://search.example', PUBLIC_URL: 'https://ratsden.example///' });
    assert.equal(ok.WORLDSTATE_URL, 'http://relay.lan:8080/pc');
    assert.equal(ok.SEARXNG_URL, 'HTTPS://search.example');
    assert.equal(ok.PUBLIC_URL, 'https://ratsden.example', 'the trailing slashes are still dropped');
  });
});

describe('the API client keeps what it holds within bounds', () => {
  const quiet = (script: (url: string) => Response) =>
    new ApiClient({ now: () => 1_000_000_000_000, sleep: async () => {}, random: () => 0.5, log: () => {}, warn: () => {}, fetch: async (url) => script(url) });
  const MB = 1024 * 1024;

  it('gives up on an answer that is too large instead of reading it whole', async () => {
    await assert.rejects(readText(new Response('x'.repeat(5000)), 1000), /larger than/);
    // The declared length alone is enough: nothing is read.
    const declared = new Response('abc', { headers: { 'content-length': '999999' } });
    await assert.rejects(readText(declared, 10), /larger than/);
    assert.equal(await readText(new Response('héllo wörld ✓'), 1000), 'héllo wörld ✓');
    assert.equal(await readText(new Response(null), 1000), '');
  });

  it('does not keep one enormous answer in memory, and drops the oldest when the total is too much', async () => {
    let calls = 0;
    const client = quiet((url) => {
      calls++;
      const size = url.includes('huge') ? 13 * MB : 11 * MB;
      return new Response(`"${'x'.repeat(size)}"`);
    });
    client.configure({ limits: { minIntervalMs: 0, perMinute: 600 } });

    await client.get('https://x.test/huge', { kind: 'stable' });
    assert.equal(client.memoryUse().entries, 0, 'over a quarter of the budget: not held');
    await client.get('https://x.test/huge', { kind: 'stable' });
    assert.equal(calls, 2, 'so it is asked for again');

    for (const n of [1, 2, 3, 4, 5]) await client.get(`https://x.test/big${n}`, { kind: 'stable' });
    const use = client.memoryUse();
    assert.ok(use.chars <= 48 * MB, `within the budget, got ${use.chars}`);
    assert.equal(use.entries, 4, 'the first of the five made room for the last');
    const before = calls;
    await client.get('https://x.test/big5', { kind: 'stable' });
    assert.equal(calls, before, 'the newest is still served from memory');
    await client.get('https://x.test/big1', { kind: 'stable' });
    assert.equal(calls, before + 1, 'the oldest was dropped');
  });

  it('trims the stored cache to a size, oldest first', () => {
    const store = new Store(':memory:');
    const put = (n: number) => store.putApiCache(`https://x.test/${n}`, { body: 'x'.repeat(1000), status: 200, etag: null, lastModified: null, fetchedAt: 1_000 + n });
    for (const n of [3, 1, 5, 2, 4]) put(n);
    assert.equal(store.trimApiCache(10_000), 0, 'nothing to do while it fits');
    assert.equal(store.trimApiCache(2_500), 3);
    assert.deepEqual(store.apiCacheSize(), { entries: 2, bytes: 2000 });
    assert.equal(store.getApiCache('https://x.test/1'), null);
    assert.equal(store.getApiCache('https://x.test/3'), null);
    assert.ok(store.getApiCache('https://x.test/4'));
    assert.ok(store.getApiCache('https://x.test/5'));
    store.close();
  });
});

describe('the web server', () => {
  /** A server on a free port; `stop()` closes it. */
  async function serve(overrides: Record<string, string> = {}): Promise<{ url: string; store: Store; stop: () => void }> {
    const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD, HTTP_HOST: '127.0.0.1', MCP_AUTH_TOKEN: 'a-long-enough-test-token-0123', ...overrides });
    const store = new Store(':memory:');
    const client = { isReady: () => false, guilds: { cache: new Map() } } as unknown as Client;
    const server = startHttpServer({ config: { ...config, HTTP_PORT: 0 }, store, client });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, stop: () => server.close() };
  }

  it('sends the protective headers on every answer, and HSTS only when it is published over HTTPS', async () => {
    const plain = await serve();
    const secure = await serve({ PUBLIC_URL: 'https://ratsden.example', DISCORD_CLIENT_SECRET: 'secret' });
    try {
      for (const path of ['/health', '/status.json', '/', '/nothing-here']) {
        const res = await fetch(`${plain.url}${path}`);
        await res.arrayBuffer();
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
        assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
        assert.equal(res.headers.get('strict-transport-security'), null, path);
        assert.equal(res.headers.get('x-powered-by'), null, path);
      }
      const res = await fetch(`${secure.url}/health`);
      await res.arrayBuffer();
      assert.equal(res.headers.get('strict-transport-security'), 'max-age=15552000');
      // The panel keeps its own, stricter-for-its-use policy.
      const admin = await fetch(`${secure.url}/admin/`);
      await admin.arrayBuffer();
      assert.equal(admin.headers.get('referrer-policy'), 'same-origin');
      assert.equal(admin.headers.get('x-frame-options'), 'DENY');
    } finally {
      plain.stop();
      secure.stop();
    }
  });

  it('shares one reading of the status data between visitors for a few seconds', async () => {
    const s = await serve();
    try {
      const first = (await (await fetch(`${s.url}/status.json`)).json()) as { generatedAt: string; registeredMembers: number };
      s.store.upsertMember({ guildId: GUILD, userId: 'u1', ign: 'RatKing', masteryRank: null, platform: null });
      const second = (await (await fetch(`${s.url}/status.json`)).json()) as { generatedAt: string; registeredMembers: number };
      assert.equal(second.generatedAt, first.generatedAt, 'the same reading');
      assert.equal(second.registeredMembers, 0);
      const page = await (await fetch(`${s.url}/`)).text();
      assert.ok(page.includes(first.generatedAt), 'the page is drawn from it too');
      assert.ok(STATUS_TTL_MS >= 1000 && STATUS_TTL_MS <= 15_000, 'short enough that nobody notices');
    } finally {
      s.stop();
    }
  });

  it('answers a failure with a short text and nothing of its insides, and tries again for the next visitor', async () => {
    const s = await serve();
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      s.store.close();
      const res = await fetch(`${s.url}/status.json`);
      const text = await res.text();
      assert.equal(res.status, 500);
      assert.equal(text, 'Something went wrong. The error has been logged.');
      assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
      assert.ok(!/\bat\b.*\.(ts|js)/.test(text), 'no stack trace');
      assert.ok(errors.some((a) => String(a[0]).includes('[http] GET /status.json failed')), 'the failure is in the log');
      // The failed reading was not kept: the page asks again (and fails again, rather than serving nothing forever).
      assert.equal((await fetch(`${s.url}/`)).status, 500);
    } finally {
      console.error = original;
      s.stop();
    }
  });

  it('turns a body it cannot read into a JSON-RPC error on the MCP endpoint', async () => {
    const s = await serve();
    try {
      const res = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { authorization: 'Bearer a-long-enough-test-token-0123', 'content-type': 'application/json' }, body: '{not json' });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { jsonrpc: '2.0', error: { code: -32700, message: 'That request could not be read.' }, id: null });
      const unauthorised = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(unauthorised.status, 401);
      await unauthorised.arrayBuffer();
    } finally {
      s.stop();
    }
  });
});
