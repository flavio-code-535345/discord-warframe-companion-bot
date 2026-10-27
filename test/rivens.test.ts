import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { RivenCrawler, pickWeapon } from '../src/rivens/crawler.js';
import { gradeRiven, highBracket, topRolls } from '../src/rivens/grade.js';
import { parseAuctions, resetRivenFilter, resetRivenLists } from '../src/rivens/market.js';
import { gradeFor, rivenStatus, topFor } from '../src/rivens/service.js';
import { parseStatList, resolveStat } from '../src/rivens/stats.js';
import type { RivenAttribute, RivenListing } from '../src/rivens/types.js';
import { api } from '../src/warframe/fetch.js';

const attrs: RivenAttribute[] = [
  ['critical_chance', 'Critical Chance'],
  ['critical_damage', 'Critical Damage'],
  ['multishot', 'Multishot'],
  ['status_chance', 'Status Chance'],
  ['base_damage_/_melee_damage', 'Damage'],
  ['fire_rate_/_attack_speed', 'Fire Rate / Attack Speed'],
  ['zoom', 'Zoom'],
  ['recoil', 'Recoil'],
  ['punch_through', 'Punch Through'],
].map(([slug, name]) => ({ slug: slug!, name: name!, positiveOnly: slug === 'punch_through', negativeOnly: false }));

let n = 0;
const listing = (price: number, positives: string[], negative?: string, weapon = 'bramma'): RivenListing => ({
  id: `a${n++}`,
  weapon,
  price,
  polarity: 'madurai',
  rerolls: 3,
  stats: [...positives.map((slug, i) => ({ slug, value: 100 + i * 10 + (n % 7), positive: true })), ...(negative ? [{ slug: negative, value: -40, positive: false }] : [])],
});

/** 10 expensive rivens (mostly cc/cd/ms) and 10 cheap, random-looking ones. */
const market = (): RivenListing[] => [
  ...Array.from({ length: 6 }, () => listing(1500, ['critical_chance', 'critical_damage', 'multishot'], 'zoom')),
  ...Array.from({ length: 2 }, () => listing(1200, ['critical_chance', 'multishot', 'status_chance'])),
  listing(1100, ['critical_chance', 'critical_damage', 'status_chance'], 'recoil'),
  listing(1000, ['critical_chance', 'critical_damage', 'multishot']),
  ...Array.from({ length: 4 }, () => listing(80, ['zoom', 'recoil', 'status_chance'])),
  ...Array.from({ length: 4 }, () => listing(40, ['punch_through', 'recoil'])),
  listing(300, ['critical_chance', 'status_chance']),
  listing(250, ['critical_damage', 'zoom']),
];

describe('reading auctions', () => {
  it('reads the v1 shape, both spellings of the bonus flag, and skips closed, private and non-riven ones', () => {
    const body = {
      payload: {
        auctions: [
          { id: 'x1', buyout_price: 900, starting_price: 1, item: { type: 'riven', polarity: 'vazarin', re_rolls: 5, attributes: [{ url_name: 'critical_chance', value: 150, positive: true }, { url_name: 'multishot', value: 100, postive: true }, { url_name: 'zoom', value: -30, postive: false }] } },
          { id: 'x2', buyout_price: null, starting_price: 50, item: { type: 'riven', attributes: [{ url_name: 'a', value: 1, positive: true }, { url_name: 'b', value: 1, positive: true }] } },
          { id: 'x3', buyout_price: 100, closed: true, item: { type: 'riven', attributes: [{ url_name: 'a', value: 1, positive: true }, { url_name: 'b', value: 1, positive: true }] } },
          { id: 'x4', buyout_price: 100, private: true, item: { type: 'riven', attributes: [{ url_name: 'a', value: 1, positive: true }, { url_name: 'b', value: 1, positive: true }] } },
          { id: 'x5', buyout_price: 100, item: { type: 'lich', attributes: [] } },
          { id: 'x6', buyout_price: 100, item: { type: 'riven', attributes: [{ url_name: 'a', value: 1, positive: true }] } },
          { buyout_price: 100, item: { type: 'riven', attributes: [] } },
        ],
      },
    };
    const out = parseAuctions(body, 'bramma');
    assert.deepEqual(out.map((l) => [l.id, l.price]), [['x1', 900], ['x2', 50]]);
    assert.deepEqual(out[0]!.stats.map((s) => s.positive), [true, true, false]);
    assert.equal(out[0]!.rerolls, 5);
    assert.deepEqual(parseAuctions('nonsense', 'x'), []);
  });
});

describe('stat names', () => {
  it('understands short forms, loose names and lists', () => {
    assert.equal(resolveStat(attrs, 'cc')?.slug, 'critical_chance');
    assert.equal(resolveStat(attrs, 'crit dmg')?.slug, 'critical_damage');
    assert.equal(resolveStat(attrs, 'DMG')?.slug, 'base_damage_/_melee_damage');
    assert.equal(resolveStat(attrs, 'fire rate')?.slug, 'fire_rate_/_attack_speed');
    assert.equal(resolveStat(attrs, 'nonsense'), null);
    assert.deepEqual(parseStatList('cc cd ms', attrs).map((s) => s.slug), ['critical_chance', 'critical_damage', 'multishot']);
    assert.deepEqual(parseStatList('Critical Chance 180.5, multishot 120%, sc', attrs), [
      { slug: 'critical_chance', value: 180.5 },
      { slug: 'multishot', value: 120 },
      { slug: 'status_chance', value: null },
    ]);
    assert.throws(() => parseStatList('cc, flurble', attrs), /don't know the riven stat "flurble"/);
  });
});

describe('grading', () => {
  it('needs enough listings to compare with, and widens the bracket to the top quarter when few reach the price line', () => {
    assert.equal(highBracket(market().slice(0, 5), 1000), null);
    const b = highBracket(market(), 1000)!;
    assert.equal(b.high.length, 10);
    assert.equal(b.adaptive, false);
    const cheap = Array.from({ length: 20 }, (_, i) => listing(100 + i, ['critical_chance', 'multishot']));
    const widened = highBracket(cheap, 1000)!;
    assert.equal(widened.adaptive, true);
    assert.equal(widened.high.length, 8);
    assert.equal(widened.threshold, 112);
  });

  it('gives S to the combination the expensive rivens have and D to one they never use', () => {
    const s = gradeRiven(market(), { positives: [{ slug: 'critical_chance' }, { slug: 'critical_damage' }, { slug: 'multishot' }], negative: { slug: 'zoom' } }, 1000)!;
    assert.equal(s.letter, 'S');
    assert.equal(s.exact, 7);
    assert.equal(s.stats[0]!.rank, 1);
    assert.equal(s.negative!.rank, 1);
    assert.equal(s.comparable!.sameNegative, true);
    assert.equal(s.comparable!.median, 1500);
    const d = gradeRiven(market(), { positives: [{ slug: 'zoom' }, { slug: 'recoil' }, { slug: 'punch_through' }] }, 1000)!;
    assert.equal(d.letter, 'D');
    assert.equal(d.exact, 0);
    assert.equal(d.stats.every((x) => x.rank === null), true);
    assert.equal(d.comparable, null);
  });

  it('grades in between when only some stats are the popular ones', () => {
    const g = gradeRiven(market(), { positives: [{ slug: 'critical_chance' }, { slug: 'zoom' }, { slug: 'recoil' }] }, 1000)!;
    assert.equal(g.letter, 'C');
    assert.equal(gradeRiven(market(), { positives: [{ slug: 'critical_chance' }, { slug: 'critical_damage' }] }, 1000)!.letter, 'A');
  });

  it('compares a rolled value with the other rolls of that stat', () => {
    const g = gradeRiven(market(), { positives: [{ slug: 'critical_chance', value: 1000 }, { slug: 'multishot', value: -5 }] }, 1000)!;
    assert.equal(g.stats[0]!.percentile, 1);
    assert.equal(g.stats[1]!.percentile, 0);
  });

  it('prices from what warframe.market says is for sale, and is honest when that is cut off or empty', () => {
    const want = [{ slug: 'critical_chance' }, { slug: 'critical_damage' }, { slug: 'multishot' }];
    const cheap = (price: number) => listing(price, ['critical_chance', 'critical_damage', 'multishot']);
    const whole = gradeRiven(market(), { positives: want }, 1000, { listings: [cheap(300), cheap(500), cheap(900), listing(50, ['zoom', 'recoil'])], complete: true })!;
    assert.deepEqual([whole.comparable!.source, whole.comparable!.complete, whole.comparable!.count, whole.comparable!.min, whole.comparable!.median, whole.comparable!.max], ['market', true, 3, 300, 500, 900]);
    const cut = gradeRiven(market(), { positives: want }, 1000, { listings: Array.from({ length: 12 }, (_, i) => cheap(100 + i * 10)), complete: false })!;
    assert.deepEqual([cut.comparable!.complete, cut.comparable!.min, cut.comparable!.tenth], [false, 100, 190]);
    assert.equal(gradeRiven(market(), { positives: want }, 1000, { listings: [], complete: true })!.comparable, null, 'complete and empty: nobody is selling it');
    assert.equal(gradeRiven(market(), { positives: want }, 1000, { listings: [], complete: false })!.comparable!.source, 'top', 'cut off and empty: fall back to what is stored');
    assert.equal(gradeRiven(market(), { positives: want }, 1000)!.comparable!.source, 'top');
  });

  it('summarizes what sells', () => {
    const t = topRolls(market(), 1000)!;
    assert.equal(t.stats[0]!.slug, 'critical_chance');
    assert.equal(t.combos[0]!.count, 7);
    assert.equal(t.negatives[0]!.slug, 'zoom');
    assert.equal(topRolls([], 1000), null);
  });
});

describe('the slow read', () => {
  const w = (slug: string) => ({ slug, name: slug });
  const row = (weapon: string, fetchedAt: number | null, attemptedAt: number) => ({ weapon, fetchedAt, attemptedAt, listings: 5, error: null });
  const DAY = 86_400_000;

  it('reads never-read weapons first, then the one read longest ago that is due, and leaves recent or recently failed ones alone', () => {
    const now = 10 * DAY;
    const weapons = [w('a'), w('b'), w('c'), w('d')];
    assert.equal(pickWeapon(weapons, [row('a', now - DAY, now - DAY), row('b', 1 * DAY, 1 * DAY)], now, 3 * DAY)?.slug, 'c');
    assert.equal(pickWeapon(weapons, [row('a', 5 * DAY, 5 * DAY), row('b', 2 * DAY, 2 * DAY), row('c', 8 * DAY, 8 * DAY), row('d', 9 * DAY, 9 * DAY)], now, 3 * DAY)?.slug, 'b');
    assert.equal(pickWeapon(weapons, weapons.map((x) => row(x.slug, now - DAY, now - DAY)), now, 3 * DAY), null);
    // b just failed: not retried for hours, so the next one is picked.
    assert.equal(pickWeapon([w('b'), w('c')], [row('b', null, now - 1000), row('c', 1 * DAY, 1 * DAY)], now, 3 * DAY)?.slug, 'c');
  });
});

describe('with a fake warframe.market', () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];
  let mode: 'ok' | 'forbidden' | 'filter400' = 'ok';
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
    resetRivenLists();
    resetRivenFilter();
    urls = [];
    mode = 'ok';
    n = 0;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const u = new URL(String(url));
      if (u.pathname === '/v2/riven/weapons') return json({ data: [{ slug: 'kuva_bramma', i18n: { en: { name: 'Kuva Bramma' } } }, { slug: 'soma', i18n: { en: { name: 'Soma' } } }] });
      if (u.pathname === '/v2/riven/attributes') return json({ data: attrs.map((a) => ({ slug: a.slug, positiveOnly: a.positiveOnly, i18n: { en: { name: a.name } } })) });
      if (u.pathname === '/v1/auctions/search') {
        if (mode === 'forbidden') return new Response('Deprecated', { status: 403 });
        const weapon = u.searchParams.get('weapon_url_name')!;
        let listings = market();
        const wanted = u.searchParams.get('positive_stats');
        if (wanted) {
          if (mode === 'filter400') return new Response('bad request', { status: 400 });
          const want = wanted.split(',');
          const neg = u.searchParams.get('negative_stats');
          listings = listings.filter((l) => want.every((w) => l.stats.some((x) => x.positive && x.slug === w)) && (!neg || l.stats.some((x) => !x.positive && x.slug === neg)));
          if (u.searchParams.get('sort_by') === 'price_asc') listings.sort((a, b) => a.price - b.price);
        }
        return json({ payload: { auctions: listings.map((l, i) => ({ id: `${weapon}-${i}`, buyout_price: l.price, item: { type: 'riven', polarity: l.polarity, re_rolls: l.rerolls, attributes: l.stats.map((s) => ({ url_name: s.slug, value: s.value, positive: s.positive })) } })) } });
      }
      return new Response('?', { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const ctxOf = (store: Store, over: Record<string, unknown> = {}) =>
    ({ store, config: { RIVEN_CRAWL_ENABLED: true, RIVEN_CRAWL_INTERVAL_SECONDS: 45, RIVEN_REFRESH_DAYS: 3, RIVEN_HIGH_PRICE: 1000, ...over } }) as never;
  const auctionCalls = () => urls.filter((u) => u.includes('/v1/auctions/search') && !u.includes('positive_stats'));
  const filteredCalls = () => urls.filter((u) => u.includes('positive_stats'));

  it('grades from one gentle read of the weapon, then from what is stored', async () => {
    const store = new Store(':memory:');
    const ctx = ctxOf(store);
    const r = await gradeFor(ctx, { weapon: 'kuva bramma', positives: 'cc cd ms', negative: 'zoom -40' });
    assert.equal(r.weapon.slug, 'kuva_bramma');
    assert.equal(r.grade!.letter, 'S');
    assert.equal(r.names.critical_chance, 'Critical Chance');
    assert.equal(auctionCalls().length, 1);
    assert.match(auctionCalls()[0]!, /type=riven&weapon_url_name=kuva_bramma&sort_by=price_desc/);
    // The price comes from warframe.market's own filtered search, cheapest first, not from the stored priciest listings.
    assert.equal(filteredCalls().length, 1);
    assert.match(filteredCalls()[0]!, /positive_stats=critical_chance,critical_damage,multishot&negative_stats=zoom/);
    assert.match(filteredCalls()[0]!, /sort_by=price_asc/);
    assert.deepEqual(
      { source: r.grade!.comparable!.source, complete: r.grade!.comparable!.complete, count: r.grade!.comparable!.count, min: r.grade!.comparable!.min, same: r.grade!.comparable!.sameNegative },
      { source: 'market', complete: true, count: 6, min: 1500, same: true },
    );
    const none = await gradeFor(ctx, { weapon: 'kuva_bramma', positives: 'cc, ms' });
    assert.equal(auctionCalls().length, 1, 'the second grade used the stored listings');
    assert.equal(none.grade!.comparable, null);
    assert.equal(none.grade!.marketChecked, true);
    const top = await topFor(ctx, 'Kuva Bramma');
    assert.equal(top.top!.combos[0]!.count, 7);
    assert.equal(auctionCalls().length, 1);
    const status = await rivenStatus(ctx);
    assert.equal(status.weaponsRead, 1);
    assert.equal(status.weaponsKnown, 2);
  });

  it('falls back to the stored listings, and says so, when the filtered search is refused, and does not keep asking', async () => {
    mode = 'filter400';
    const ctx = ctxOf(new Store(':memory:'));
    const r = await gradeFor(ctx, { weapon: 'kuva bramma', positives: 'cc cd ms' });
    assert.equal(r.grade!.comparable!.source, 'top');
    assert.equal(r.grade!.comparable!.complete, false);
    assert.equal(r.grade!.marketChecked, false);
    assert.equal(filteredCalls().length, 1);
    await gradeFor(ctx, { weapon: 'kuva bramma', positives: 'cc cd sc' });
    assert.equal(filteredCalls().length, 1, 'not tried again after a bad request');
  });

  it('explains bad input in words', async () => {
    const ctx = ctxOf(new Store(':memory:'));
    await assert.rejects(gradeFor(ctx, { weapon: 'zzzz nothing', positives: 'cc cd' }), /No weapon with a riven matches/);
    await assert.rejects(gradeFor(ctx, { weapon: 'soma', positives: 'cc' }), /2 or 3 bonus stats/);
    await assert.rejects(gradeFor(ctx, { weapon: 'soma', positives: 'cc cc' }), /only appear once/);
    await assert.rejects(gradeFor(ctx, { weapon: 'soma', positives: 'cc cd', negative: 'punch through' }), /can only be a bonus/);
    assert.equal(auctionCalls().length, 0);
  });

  it('crawls one weapon per step, and a 403 pauses riven reads only, not the rest of warframe.market', async () => {
    const store = new Store(':memory:');
    const crawler = new RivenCrawler(ctxOf(store));
    const t0 = Date.now();
    assert.equal(await crawler.tick(t0), 'read');
    assert.equal(auctionCalls().length, 1);
    assert.equal(await crawler.tick(t0 + 1000), 'read');
    assert.equal(auctionCalls().length, 2);
    assert.equal(await crawler.tick(t0 + 2000), 'idle', 'both weapons were just read');
    assert.equal(auctionCalls().length, 2);

    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
    const fresh = new Store(':memory:');
    const failing = new RivenCrawler(ctxOf(fresh));
    mode = 'forbidden';
    assert.equal(await failing.tick(t0), 'failed');
    const calls = auctionCalls().length;
    assert.equal(await failing.tick(t0 + 1000), 'paused');
    assert.equal(auctionCalls().length, calls, 'nothing is sent while paused');
    assert.equal(api.blockedFor('api.warframe.market'), 0, 'prices and the rest of the host are unaffected');
    assert.ok(api.blockedFor('api.warframe.market#rivens') > 0);
    assert.match(fresh.rivenCrawlRows()[0]!.error ?? '', /not being called/);
    await assert.rejects(gradeFor(ctxOf(fresh), { weapon: 'soma', positives: 'cc cd' }), /asked the bot to back off/);
  });

  it('does nothing when switched off', async () => {
    const crawler = new RivenCrawler(ctxOf(new Store(':memory:'), { RIVEN_CRAWL_ENABLED: false }));
    assert.equal(await crawler.tick(), 'off');
    assert.equal(urls.length, 0);
  });
});
