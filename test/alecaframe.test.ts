import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SHARES, fetchRelics, fetchStats, forgetToken, parseRelicInventory, parseStats, sharedList, tokenFrom } from '../src/alecaframe/api.js';
import { amount, drawStatsChart, statSeries } from '../src/alecaframe/chart.js';
import { Store } from '../src/db.js';
import { alecaStatsEmbed, sharedText, tradeLine } from '../src/discord/alecaframe-embeds.js';
import { UserError } from '../src/services/clan.js';
import { api } from '../src/warframe/fetch.js';

const DAY = 86_400_000;

/** AlecaFrame's relic inventory as its API sends it: base64 of a Uint32LE count, then 9 bytes per relic. */
function inventory(entries: [tier: number, refinement: number, code: string, count: number][], declared = entries.length): string {
  const buf = Buffer.alloc(4 + entries.length * 9);
  buf.writeUInt32LE(declared, 0);
  entries.forEach(([tier, refinement, code, count], i) => {
    const o = 4 + i * 9;
    buf[o] = tier;
    buf[o + 1] = refinement;
    buf.write(code.padEnd(3, '\0'), o + 2, 3, 'latin1');
    buf.writeUInt32LE(count, o + 5);
  });
  return buf.toString('base64');
}

const point = (ts: string, over: Record<string, unknown> = {}) => ({ ts, plat: 1000, credits: 2_000_000, endo: 30_000, ducats: 900, aya: 3, relicOpened: 1000, trades: 40, mr: 28, percentageCompletion: 81, ...over });

const RAW = {
  usernameWhenPublic: ' RatKing ',
  lastUpdate: '2026-11-08T12:00:00Z',
  publicParts: SHARES.trades | SHARES.platinum | SHARES.ducats | SHARES.relics | SHARES.account,
  generalDataPoints: [
    point('2026-11-08T00:00:00Z', { plat: 1500, ducats: 1200, relicOpened: 1200 }),
    point('2026-10-01T00:00:00Z'),
    { ts: 'not a date', plat: 5 },
    point('2026-10-20T00:00:00Z', { plat: 1200, relicOpened: 1100 }),
  ],
  trades: [
    { ts: '2026-11-07T10:00:00Z', type: 0, totalPlat: 45, user: 'SomeoneElse', tx: [{ name: '/Lotus/Types/Recipes/AshPrimeSystems', displayName: 'Ash Prime Systems', cnt: 2, rank: 0 }], rx: [{ name: 'Platinum', cnt: 45 }] },
    { ts: '2026-11-08T09:00:00Z', type: 1, totalPlat: 20, user: 'Other', tx: [{ displayName: 'Platinum', cnt: 20 }], rx: [{ displayName: 'Primed Continuity', cnt: 1, rank: 10 }] },
    { ts: '2026-10-02T00:00:00Z', type: 2, user: 'Third', tx: [{ displayName: 'Lith B1 Relic', cnt: 3 }], rx: [{ displayName: 'Neo V1 Relic', cnt: 1 }] },
  ],
};

describe('reading AlecaFrame', () => {
  it('reads the relic inventory, quoted or bare, merging the same relic and refinement', () => {
    const b64 = inventory([
      [3, 0, 'A1', 5],
      [3, 4, 'A1', 2],
      [3, 1, 'A1', 1],
      [4, 3, 'IV', 2],
      [0, 2, 'B1', 1],
      [9, 0, 'Z1', 1],
      [1, 0, 'x!', 1],
      [2, 0, 'N5', 0],
    ]);
    const want = [
      { tier: 'Axi', code: 'A1', refinement: 'Intact', count: 5 },
      { tier: 'Axi', code: 'A1', refinement: 'Exceptional', count: 3 },
      { tier: 'Requiem', code: 'IV', refinement: 'Radiant', count: 2 },
      { tier: 'Lith', code: 'B1', refinement: 'Flawless', count: 1 },
    ];
    assert.deepEqual(parseRelicInventory(b64), want);
    assert.deepEqual(parseRelicInventory(JSON.stringify(b64)), want);
    assert.deepEqual(parseRelicInventory(''), []);
    assert.deepEqual(parseRelicInventory(JSON.stringify(Buffer.from([1, 0]).toString('base64'))), []);
    assert.equal(parseRelicInventory(inventory([[3, 0, 'A1', 5]], 50)).length, 1, 'a count larger than the data stops at its end');
  });

  it("reads the stats: readings oldest first, trades newest first, without the other player's name or the plat as an item", () => {
    const s = parseStats(RAW);
    assert.equal(s.username, 'RatKing');
    assert.equal(s.updatedAt, Date.parse('2026-11-08T12:00:00Z'));
    assert.deepEqual(sharedList(s.parts), ['trades', 'platinum', 'ducats', 'account', 'relics']);
    assert.deepEqual(s.points.map((p) => p.plat), [1000, 1200, 1500]);
    assert.equal(s.points[0]!.vitus, null);
    assert.deepEqual(s.trades.map((t) => t.kind), ['purchase', 'sale', 'trade']);
    assert.deepEqual(s.trades[1]!.gave, [{ name: 'Ash Prime Systems', count: 2, rank: null }]);
    assert.deepEqual(s.trades[1]!.got, []);
    assert.deepEqual(s.trades[0]!.got, [{ name: 'Primed Continuity', count: 1, rank: 10 }]);
    assert.equal(s.trades[2]!.plat, null);
    assert.ok(!JSON.stringify(s).includes('SomeoneElse'));
    assert.deepEqual(parseStats(null), { username: null, updatedAt: null, parts: 0, points: [], trades: [] });
  });

  it('takes the token from the token itself or from a link that carries it', () => {
    assert.equal(tokenFrom('  abcDEF123456  '), 'abcDEF123456');
    assert.equal(tokenFrom('https://stats.alecaframe.com/stats?token=abc%2BDEF123456'), 'abc+DEF123456');
    assert.equal(tokenFrom('https://stats.alecaframe.com/api/stats/public/getRelicInventory?x=1&publicToken=XYZ12345678'), 'XYZ12345678');
    assert.equal(tokenFrom('hello world'), null);
    assert.equal(tokenFrom('short'), null);
    assert.equal(tokenFrom('https://x.test/?token=%E0%A4%A'), null);
  });
});

describe('asking AlecaFrame', () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const serve = (status: number, body: unknown) => {
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
  };
  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0, hostIntervalMs: {} } });
    forgetToken();
    urls.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('says what to do about a revoked token, after asking once', async () => {
    serve(500, { type: 'https://tools.ietf.org/html/rfc9110#section-15.6.1', title: 'An error occurred while processing your request.', status: 500, detail: 'Invalid token' });
    await assert.rejects(
      () => fetchStats('badtoken123'),
      (err: unknown) => err instanceof UserError && /not valid/.test(err.message) && /Create Public Link/.test(err.message),
    );
    assert.deepEqual(urls, ['https://stats.alecaframe.com/api/stats/public?token=badtoken123']);
    assert.deepEqual(api.cooldowns(), [], 'a bad token does not pause AlecaFrame for everyone');
  });

  it('reads the stats once per token for ten minutes', async () => {
    serve(200, RAW);
    assert.equal((await fetchStats('goodtoken123')).username, 'RatKing');
    await fetchStats('goodtoken123');
    assert.equal(urls.length, 1);
    forgetToken('goodtoken123');
    await fetchStats('goodtoken123');
    assert.equal(urls.length, 2);
  });

  it('reads the relics with the public token', async () => {
    serve(200, JSON.stringify(inventory([[3, 3, 'A1', 2]])));
    assert.deepEqual(await fetchRelics('goodtoken123'), [{ tier: 'Axi', code: 'A1', refinement: 'Radiant', count: 2 }]);
    assert.deepEqual(urls, ['https://stats.alecaframe.com/api/stats/public/getRelicInventory?publicToken=goodtoken123']);
  });

  it('turns an answer that is not JSON into a plain message', async () => {
    serve(200, '<html>maintenance</html>');
    await assert.rejects(() => fetchStats('goodtoken123'), UserError);
  });
});

describe('stats chart and embed', () => {
  const stats = parseStats(RAW);
  const since = Date.parse('2026-10-15T00:00:00Z');

  it('shows only what the link shares, starting from the last reading before the period', () => {
    const series = statSeries(stats, since);
    assert.deepEqual(series.map((s) => s.key), ['plat', 'ducats']);
    const plat = series[0]!;
    assert.deepEqual(plat.points.map((p) => [p.at, p.v]), [
      [since, 1000],
      [Date.parse('2026-10-20T00:00:00Z'), 1200],
      [Date.parse('2026-11-08T00:00:00Z'), 1500],
    ]);
    assert.deepEqual([plat.now, plat.change], [1500, 500]);
    // A link without flags (an old one) shows every currency that has data.
    assert.ok(statSeries({ ...stats, parts: 0 }, since).some((s) => s.key === 'endo'));
    assert.deepEqual(statSeries({ ...stats, points: [] }, since), []);
  });

  it('writes amounts short when asked', () => {
    assert.equal(amount(1234567), '1,234,567');
    assert.deepEqual([amount(1_234_567, true), amount(12_345, true), amount(950, true), amount(2_500_000_000, true)], ['1.2M', '12k', '950', '2.5B']);
  });

  it('draws a PNG two panels wide', async () => {
    const png = await drawStatsChart(stats, { since, periodLabel: 'Last 30 days' });
    assert.ok(png);
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    // One row of panels: the header, one panel and the footer.
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [960, 96 + 204 + 34]);
    assert.equal(await drawStatsChart({ ...stats, parts: SHARES.trades }, { since, periodLabel: 'x' }), null);
    // A single reading draws its panel with a note instead of a line.
    const one = await drawStatsChart({ ...stats, points: stats.points.slice(-1) }, { since: Date.now() + DAY, periodLabel: 'x' });
    assert.ok(one);
  });

  it('lists the trades of the period without the other player', () => {
    const embed = alecaStatsEmbed(stats, { since, periodLabel: 'Last 30 days', image: 'attachment://x.png' }).toJSON();
    assert.match(embed.title ?? '', /RatKing/);
    assert.match(embed.description ?? '', /\*\*1,500\*\* platinum · \+500/);
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name.replace(/^\S+ /, ''), f.value]));
    assert.match(fields['Trading'] ?? '', /\*\*2\*\* trades · sold for \*\*45p\*\* · bought for \*\*20p\*\*/);
    assert.match(fields['Relics opened'] ?? '', /\*\*200\*\* in this period/);
    assert.ok(!JSON.stringify(embed).includes('SomeoneElse'));
    assert.equal(embed.image?.url, 'attachment://x.png');
    assert.match(tradeLine(stats.trades[1]!), /Sold 2× Ash Prime Systems for \*\*45p\*\*/);
    assert.match(tradeLine(stats.trades[2]!), /Traded 3× Lith B1 Relic for Neo V1 Relic/);
    assert.equal(sharedText(SHARES.platinum | SHARES.relics | SHARES.trades), 'trades, platinum and relics');
    assert.equal(sharedText(0), 'nothing');
  });
});

describe('linked accounts', () => {
  it('keeps one token per member, and forgets it on unlink', () => {
    const store = new Store(':memory:');
    store.setAlecaLink('u1', { token: 'tok-1', username: 'RatKing', parts: 3 }, 1_000);
    store.setAlecaLink('u1', { token: 'tok-2', username: 'RatKing', parts: 131 }, 2_000);
    assert.deepEqual(store.getAlecaLink('u1'), { userId: 'u1', token: 'tok-2', username: 'RatKing', parts: 131, linkedAt: 2_000 });
    store.updateAlecaLink('u1', 'RatQueen', 3);
    assert.deepEqual(store.getAlecaLink('u1'), { userId: 'u1', token: 'tok-2', username: 'RatQueen', parts: 3, linkedAt: 2_000 });
    assert.equal(store.countAlecaLinks(), 1);
    assert.equal(store.removeAlecaLink('u1'), true);
    assert.equal(store.removeAlecaLink('u1'), false);
    assert.equal(store.getAlecaLink('u1'), null);
  });
});
