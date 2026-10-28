import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { ApiBlockedError, ApiBusyError, ApiClient, ApiHttpError, parseRetryAfter } from '../src/warframe/fetch.js';
import { CETUS, VALLIS, projectCycles, rollTwoPhase } from '../src/warframe/cycles.js';

/** A client with a fake clock (sleeping just moves it forward) and a scripted fetch. */
function setup(script: (url: string, init: RequestInit, n: number) => Response | Promise<Response> | Error) {
  const clock = { t: 1_000_000_000_000 };
  const calls: { url: string; at: number; headers: Record<string, string> }[] = [];
  const sleeps: number[] = [];
  const warns: string[] = [];
  const client = new ApiClient({
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 0.5,
    log: () => {},
    warn: (l) => warns.push(l),
    fetch: async (url, init) => {
      calls.push({ url, at: clock.t, headers: (init.headers ?? {}) as Record<string, string> });
      const r = await script(url, init, calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  client.configure({ limits: { minIntervalMs: 0, perMinute: 600, maxRetries: 2, cooldownMs: 30 * 60_000, priceTtlMs: 60_000, stableTtlMs: 3_600_000 } });
  return { client, clock, calls, sleeps, warns };
}

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

describe('cache', () => {
  it('serves a repeated request from the cache until it expires', async () => {
    const { client, clock, calls } = setup(() => json({ ok: 1 }));
    const a = await client.get('https://x.test/a', { kind: 'price' });
    const b = await client.get('https://x.test/a', { kind: 'price' });
    assert.equal(calls.length, 1);
    assert.equal(a.source, 'network');
    assert.equal(b.source, 'cache');
    assert.equal(b.body, a.body);
    clock.t += 61_000;
    await client.get('https://x.test/a', { kind: 'price' });
    assert.equal(calls.length, 2);
  });

  it('uses a different lifetime per data type', async () => {
    const { client, clock, calls } = setup(() => json({}));
    await client.get('https://x.test/price', { kind: 'price' });
    await client.get('https://x.test/item', { kind: 'stable' });
    clock.t += 120_000;
    await client.get('https://x.test/price', { kind: 'price' });
    await client.get('https://x.test/item', { kind: 'stable' });
    assert.deepEqual(calls.map((c) => c.url), ['https://x.test/price', 'https://x.test/item', 'https://x.test/price']);
  });

  it('shares one request between concurrent identical calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, calls } = setup(async () => {
      await gate;
      return json({ n: 1 });
    });
    const all = [1, 2, 3, 4].map(() => client.get('https://x.test/same', { kind: 'live' }));
    release();
    const results = await Promise.all(all);
    assert.equal(calls.length, 1);
    assert.equal(client.stats.deduped, 3);
    assert.ok(results.every((r) => r.body === results[0]!.body));
  });

  it('never caches an error answer', async () => {
    const { client, calls } = setup((_u, _i, n) => (n === 1 ? new Response('nope', { status: 404 }) : json({ ok: 1 })));
    const a = await client.get('https://x.test/m', { kind: 'stable' });
    assert.equal(a.status, 404);
    const b = await client.get('https://x.test/m', { kind: 'stable' });
    assert.equal(b.status, 200);
    assert.equal(calls.length, 2);
  });

  it('revalidates with ETag and keeps the cached body on a 304', async () => {
    const { client, clock, calls } = setup((_u, init) => {
      const h = init.headers as Record<string, string>;
      return h['If-None-Match'] === 'v1' ? new Response(null, { status: 304 }) : json({ hi: 1 }, { headers: { etag: 'v1' } });
    });
    const first = await client.get('https://x.test/e', { kind: 'price' });
    clock.t += 61_000;
    const second = await client.get('https://x.test/e', { kind: 'price' });
    assert.equal(calls[1]!.headers['If-None-Match'], 'v1');
    assert.equal(second.source, 'revalidated');
    assert.equal(second.body, first.body);
    assert.equal(second.stale, false);
  });

  it('survives a restart through the database', async () => {
    const store = new Store(':memory:');
    const a = setup(() => json({ saved: true }));
    a.client.configure({ store });
    await a.client.get('https://x.test/p', { kind: 'stable' });
    const b = setup(() => json({ other: true }));
    b.client.configure({ store });
    b.clock.t = a.clock.t + 1000;
    const r = await b.client.get('https://x.test/p', { kind: 'stable' });
    assert.equal(b.calls.length, 0);
    assert.equal(r.body, '{"saved":true}');
  });
});

describe('when the API is unavailable', () => {
  it('returns the cached answer flagged as stale instead of failing', async () => {
    const { client, clock } = setup((_u, _i, n) => (n === 1 ? json({ v: 1 }) : new Response('x', { status: 503 })));
    client.configure({ limits: { maxRetries: 0 } });
    await client.get('https://x.test/s', { kind: 'price' });
    clock.t += 5 * 60_000;
    const r = await client.get('https://x.test/s', { kind: 'price' });
    assert.equal(r.stale, true);
    assert.equal(r.source, 'stale');
    assert.equal(r.body, '{"v":1}');
  });

  it('does not serve data older than the maximum age for its type', async () => {
    const { client, clock } = setup((_u, _i, n) => (n === 1 ? json({ v: 1 }) : new Response('x', { status: 503 })));
    client.configure({ limits: { maxRetries: 0 } });
    await client.get('https://x.test/old', { kind: 'price' });
    clock.t += 3 * 3_600_000;
    await assert.rejects(() => client.get('https://x.test/old', { kind: 'price' }), ApiHttpError);
  });

  it('retries temporary failures a bounded number of times with growing, jittered waits', async () => {
    const { client, calls, sleeps } = setup(() => new Response('down', { status: 502 }));
    await assert.rejects(() => client.get('https://x.test/r', { kind: 'live' }), ApiHttpError);
    assert.equal(calls.length, 3, 'one try plus two retries, then it stops');
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1]! > sleeps[0]!, 'exponential');
    assert.ok(sleeps[0]! >= 250 && sleeps[0]! <= 500, 'jitter keeps it between half and the full base');
    assert.equal(client.stats.failures, 1);
  });

  it('retries network errors too, but not forever', async () => {
    const { client, calls } = setup(() => new Error('socket hang up'));
    await assert.rejects(() => client.get('https://x.test/n', { kind: 'live' }), /socket hang up/);
    assert.equal(calls.length, 3);
  });

  it('stops at once on a 429 and honours Retry-After', async () => {
    const { client, clock, calls } = setup(() => new Response('slow down', { status: 429, headers: { 'retry-after': '90' } }));
    await assert.rejects(() => client.get('https://x.test/l', { kind: 'live' }), ApiBlockedError);
    assert.equal(calls.length, 1, 'a 429 is not retried');
    assert.equal(client.blockedFor('x.test'), 90_000);
    await assert.rejects(() => client.get('https://x.test/other', { kind: 'live' }), ApiBlockedError);
    assert.equal(calls.length, 1, 'nothing is sent while the host is on hold');
    clock.t += 91_000;
    assert.equal(client.blockedFor('x.test'), 0);
  });

  it('enters the configured cooldown on a 403 and does not touch the host until it is over', async () => {
    const { client, clock, calls } = setup((_u, _i, n) => (n === 1 ? new Response('forbidden', { status: 403 }) : json({ ok: 1 })));
    client.configure({ limits: { cooldownMs: 10 * 60_000 } });
    await assert.rejects(() => client.get('https://x.test/f', { kind: 'live' }), ApiBlockedError);
    for (let i = 0; i < 5; i++) await assert.rejects(() => client.get(`https://x.test/f${i}`, { kind: 'live' }), ApiBlockedError);
    assert.equal(calls.length, 1);
    assert.equal(client.cooldowns().length, 1);
    clock.t += 10 * 60_000 + 1;
    const r = await client.get('https://x.test/f', { kind: 'live' });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2);
  });

  it('a block on one host does not stop the others', async () => {
    const { client } = setup((u) => (u.includes('blocked.test') ? new Response('no', { status: 403 }) : json({ ok: 1 })));
    await assert.rejects(() => client.get('https://blocked.test/a', { kind: 'live' }), ApiBlockedError);
    const r = await client.get('https://fine.test/a', { kind: 'live' });
    assert.equal(r.status, 200);
  });

  it('serves stale data while blocked', async () => {
    const { client, clock } = setup((_u, _i, n) => (n === 1 ? json({ v: 1 }) : new Response('no', { status: 403 })));
    await client.get('https://x.test/b', { kind: 'live' });
    clock.t += 700_000;
    const r = await client.get('https://x.test/b', { kind: 'live' });
    assert.equal(r.stale, true);
  });
});

describe('rate limiting', () => {
  it('spaces requests to one host by the minimum gap', async () => {
    const { client, calls } = setup(() => json({}));
    client.configure({ limits: { minIntervalMs: 500 } });
    for (const i of [1, 2, 3]) await client.get(`https://x.test/${i}`, { kind: 'live' });
    const at = calls.map((c) => c.at);
    assert.ok(at[1]! - at[0]! >= 500);
    assert.ok(at[2]! - at[1]! >= 500);
  });

  it('delays requests beyond the global per-minute limit until the window has room', async () => {
    const { client, calls, clock, sleeps } = setup(() => json({}));
    client.configure({ limits: { perMinute: 5, minIntervalMs: 0 } });
    const start = clock.t;
    for (let i = 0; i < 5; i++) await client.get(`https://${i}.test/`, { kind: 'live' });
    clock.t += 52_000;
    await client.get('https://six.test/', { kind: 'live' });
    assert.equal(calls.length, 6);
    assert.ok(calls[5]!.at - start >= 60_000, 'the sixth request waits for the first to leave the one-minute window');
    assert.ok(sleeps.length === 1 && sleeps[0]! <= 8_000);
  });

  it('refuses instead of queueing for a long time', async () => {
    const { client } = setup(() => json({}));
    client.configure({ limits: { perMinute: 5, minIntervalMs: 0 } });
    for (let i = 0; i < 5; i++) await client.get(`https://${i}.test/`, { kind: 'live' });
    await assert.rejects(() => client.get('https://six.test/', { kind: 'live' }), ApiBusyError);
  });

  it('background work only gets half the budget', async () => {
    const { client, clock, calls } = setup(() => json({}));
    client.configure({ limits: { perMinute: 10, minIntervalMs: 0 } });
    const start = clock.t;
    for (let i = 0; i < 5; i++) await client.get(`https://bg${i}.test/`, { kind: 'live', background: true });
    assert.ok(calls.every((c) => c.at - start < 1000));
    await assert.rejects(() => client.get('https://bg6.test/', { kind: 'live', background: true }), ApiBusyError);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    assert.equal(parseRetryAfter('30', 0), 30_000);
    assert.equal(parseRetryAfter(new Date(60_000).toUTCString(), 0), 60_000);
    assert.equal(parseRetryAfter(null, 0), null);
    assert.equal(parseRetryAfter('soon', 0), null);
  });
});

describe('cycle projection', () => {
  it('computes the exact phase and expiry', () => {
    const t0 = 5_000_000;
    // Day ends at t0: night until +50 min, day until +150 min.
    const night = rollTwoPhase(true, t0, CETUS.day, CETUS.night, t0 + 10 * 60_000);
    assert.deepEqual([night.first, night.expiry], [false, t0 + 50 * 60_000]);
    const day = rollTwoPhase(true, t0, CETUS.day, CETUS.night, t0 + 60 * 60_000);
    assert.deepEqual([day.first, day.expiry], [true, t0 + 150 * 60_000]);
  });

  it('leaves a phase that has not ended alone, and refuses very old data', () => {
    assert.equal(rollTwoPhase(true, 10_000, 1, 1, 5_000).projected, false);
    assert.equal(rollTwoPhase(true, 1_000, VALLIS.warm, VALLIS.cold, 1_000 + 30 * 24 * 3_600_000).projected, false);
  });

  it('keeps Cambion Drift in step with Cetus', () => {
    const now = 9_000_000_000;
    const ws = {
      cetusCycle: { isDay: true, expiry: new Date(now - 10 * 60_000) },
      vallisCycle: { isWarm: true, expiry: new Date(now + 60_000) },
      earthCycle: { isDay: true, expiry: new Date(now + 60_000) },
      cambionCycle: { state: 'fass', expiry: new Date(now - 10 * 60_000) },
      zarimanCycle: { state: 'grineer', expiry: new Date(now + 60_000) },
    } as unknown as Parameters<typeof projectCycles>[0];
    const p = projectCycles(ws, now);
    assert.equal(p.cetus.isDay, false);
    assert.equal(p.cambion.state, 'vome');
    assert.equal(p.cambion.expiry, p.cetus.expiry);
    assert.equal(p.vallis.projected, false);
  });
});

describe('JSON answers', () => {
  const html = () => new Response('<html>Maintenance</html>', { status: 200 });

  it('does not cache a 200 answer that is not JSON, so the next call asks again', async () => {
    let n = 0;
    const { client, calls } = setup(() => (++n === 1 ? html() : json({ ok: 1 })));
    await assert.rejects(client.get('https://x.test/items', { kind: 'stable', json: true }), /not JSON/);
    const again = await client.get('https://x.test/items', { kind: 'stable', json: true });
    assert.equal(again.body, '{"ok":1}');
    assert.equal(again.source, 'network');
    assert.equal(calls.length, 2, 'the page must not have been kept as the answer');
  });

  it('uses the older JSON while the host answers with a page instead of data', async () => {
    let n = 0;
    const { client, clock } = setup(() => (++n === 1 ? json({ ok: 1 }) : html()));
    await client.get('https://x.test/items', { kind: 'stable', json: true });
    clock.t += 2 * 3_600_000;
    const second = await client.get('https://x.test/items', { kind: 'stable', json: true });
    assert.equal(second.body, '{"ok":1}');
    assert.equal(second.stale, true);
  });

  it('still caches plain bodies for callers that do not parse JSON', async () => {
    const { client, calls } = setup(() => html());
    await client.get('https://x.test/page', { kind: 'stable' });
    const again = await client.get('https://x.test/page', { kind: 'stable' });
    assert.equal(again.source, 'cache');
    assert.equal(calls.length, 1);
  });
});

describe('answers that are given up on', () => {
  it('cancels the body of a 5xx answer before retrying', async () => {
    let cancelled = 0;
    const bodies = [0, 1, 2].map(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { status: 503 },
        ),
    );
    let n = 0;
    const { client } = setup(() => bodies[n++] ?? json({}));
    await assert.rejects(client.get('https://x.test/down', { kind: 'live' }), ApiHttpError);
    assert.equal(cancelled, 3, 'every refused answer frees its connection');
  });
});
