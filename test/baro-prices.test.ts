import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { BARO_PRICE_MS, baroPriceLookup, baroPriceState, priceBaroStock } from '../src/warframe/baro.js';
import { api } from '../src/warframe/fetch.js';
import { type MarketOrder, marketPrice } from '../src/warframe/market.js';
import { configureWorldState, getWorldState } from '../src/warframe/worldstate.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const MARKET = 'https://api.warframe.market/v2';

const order = (platinum: number, status = 'ingame'): MarketOrder => ({ platinum, quantity: 1, user: { ingameName: `Seller${platinum}`, status, reputation: 3 } });

describe('marketPrice', () => {
  it('is the median of the five cheapest sellers, so one seller far off does not set it', () => {
    assert.equal(marketPrice([30, 10, 12, 15, 20, 50].map((p) => order(p))), 15);
    assert.equal(marketPrice([1, 40, 41, 42, 43].map((p) => order(p))), 41);
  });

  it('rounds the middle two of an even count', () => {
    assert.equal(marketPrice([10, 12, 15, 20].map((p) => order(p))), 14);
  });

  it('is null without a real price', () => {
    assert.equal(marketPrice([]), null);
    assert.equal(marketPrice([order(0)]), null);
  });
});

// --- A fake world state relay and warframe.market. ---

let world: Record<string, unknown> = {};
let orders: Record<string, { status: number; sell?: MarketOrder[] }> = {};
let requests: string[] = [];

const ITEMS = {
  data: [
    { slug: 'primed_fury', i18n: { en: { name: 'Primed Fury' } }, maxRank: 10 },
    { slug: 'prisma_grakata', i18n: { en: { name: 'Prisma Grakata' } } },
  ],
};

async function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  requests.push(url);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.startsWith('http://relay.test/')) return json(world);
  if (url === `${MARKET}/items`) return json(ITEMS);
  const slug = /\/orders\/item\/([^/?]+)\/top/.exec(url)?.[1];
  const o = slug ? orders[slug] : undefined;
  if (!o) return json({ error: 'not found' }, 404);
  return o.status === 200 ? json({ data: { sell: o.sell ?? [], buy: [] } }) : new Response('', { status: o.status });
}

/** Baro at a relay since an hour ago, with a mod, a weapon and a bundle warframe.market doesn't list. */
const baroWorld = (now: number, trader: Record<string, unknown> = {}) => ({
  timestamp: new Date(now).toISOString(),
  cetusCycle: { isDay: true, expiry: new Date(now + 30 * MIN).toISOString() },
  fissures: [],
  voidTrader: {
    id: 'baro1',
    activation: new Date(now - HOUR).toISOString(),
    expiry: new Date(now + 47 * HOUR).toISOString(),
    location: 'Strata Relay (Earth)',
    inventory: [
      { item: 'Primed Fury', ducats: 350, credits: 110_000 },
      { item: 'Prisma Grakata', ducats: 500, credits: 200_000 },
      { item: 'Void Surplus Bundle', ducats: 100, credits: 50_000 },
    ],
    ...trader,
  },
});

/** Serves a new world state: a new relay URL, so the one held in memory is not used. */
function serveWorld(w: Record<string, unknown>): void {
  world = w;
  configureWorldState({ enabled: true, intervalSeconds: 600, url: `http://relay.test/${Math.random()}`, store: new Store(':memory:') });
}

const ctx = (store: Store) => ({ store, config: { WARFRAME_PLATFORM: 'pc' } });
const marketCalls = () => requests.filter((u) => u.startsWith(MARKET)).map((u) => u.slice(MARKET.length));

describe('Baro price job', () => {
  const realFetch = globalThis.fetch;
  before(() => {
    globalThis.fetch = fakeFetch as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
    configureWorldState({ enabled: false });
  });
  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0, cooldownMs: 30 * MIN } });
    requests = [];
    orders = {
      // The offline seller at 30p does not count: the five cheapest online are 40, 45, 50, 55, 60.
      primed_fury: { status: 200, sell: [order(45), order(40), order(30, 'offline'), order(50), order(55), order(60), order(90)] },
      prisma_grakata: { status: 200, sell: [order(25), order(20), order(22)] },
    };
  });

  it('prices one item per step, a mod unranked, and skips what the market does not list', async () => {
    const store = new Store(':memory:');
    const now = Date.now();
    serveWorld(baroWorld(now));

    assert.equal(await priceBaroStock(ctx(store), now), BARO_PRICE_MS);
    assert.deepEqual(marketCalls(), ['/items', '/orders/item/primed_fury/top?rank=0']);
    assert.equal(await priceBaroStock(ctx(store), now + 20_000), BARO_PRICE_MS);
    assert.deepEqual(marketCalls().slice(2), ['/orders/item/prisma_grakata/top']);
    // The bundle is not on warframe.market: recorded without a request, and then everything is priced until the 6-hour refresh.
    assert.equal(await priceBaroStock(ctx(store), now + 40_000), 30 * MIN);
    assert.equal(marketCalls().length, 3);
    assert.deepEqual(baroPriceState(store), { visit: now - HOUR, items: 3, priced: 2 });

    const seen = requests.length;
    assert.equal(await priceBaroStock(ctx(store), now + 60_000), 30 * MIN);
    assert.equal(requests.length, seen, 'nothing is read again before the refresh');

    const lookup = baroPriceLookup(store, await getWorldState())!;
    assert.equal(lookup('Primed Fury'), 50);
    assert.equal(lookup('PRISMA GRAKATA'), 22, 'any case');
    assert.equal(lookup('Void Surplus Bundle'), null);
    assert.equal(lookup('Something Else'), null);
  });

  it('reads an item again after six hours, and starts over for a new visit', async () => {
    const store = new Store(':memory:');
    const now = Date.now();
    serveWorld(baroWorld(now));
    for (let i = 0; i < 3; i++) await priceBaroStock(ctx(store), now + i * 20_000);
    assert.equal(await priceBaroStock(ctx(store), now + 6 * HOUR + MIN), BARO_PRICE_MS, 'the Primed Fury price is six hours old');

    const old = await getWorldState();
    serveWorld(baroWorld(now, { id: 'baro2', activation: new Date(now - 10 * MIN).toISOString() }));
    assert.equal(await priceBaroStock(ctx(store), now), BARO_PRICE_MS);
    assert.deepEqual(baroPriceState(store), { visit: now - 10 * MIN, items: 1, priced: 1 });
    assert.equal(baroPriceLookup(store, old), null, 'the prices of another visit are never shown');
    assert.equal(baroPriceLookup(store, await getWorldState())!('primed fury'), 50);
  });

  it('sleeps until Baro lands, at most half an hour at a time', async () => {
    const store = new Store(':memory:');
    const now = Date.now();
    serveWorld(baroWorld(now, { activation: new Date(now + 5 * MIN).toISOString(), expiry: new Date(now + 53 * HOUR).toISOString(), inventory: [] }));
    assert.equal(await priceBaroStock(ctx(store), now), 5 * MIN);
    serveWorld(baroWorld(now, { activation: new Date(now + 3 * 24 * HOUR).toISOString(), expiry: new Date(now + 5 * 24 * HOUR).toISOString(), inventory: [] }));
    assert.equal(await priceBaroStock(ctx(store), now), 30 * MIN);
    assert.deepEqual(marketCalls(), [], 'nothing is read while he is away');

    configureWorldState({ enabled: false });
    assert.equal(await priceBaroStock(ctx(store), now), 30 * MIN);
    assert.equal(baroPriceState(store), null);
  });

  it('waits out a market cooldown without recording anything', async () => {
    const store = new Store(':memory:');
    api.configure({ limits: { cooldownMs: 10 * MIN } });
    orders.primed_fury = { status: 403 };
    const now = Date.now();
    serveWorld(baroWorld(now));
    const delay = await priceBaroStock(ctx(store), now);
    assert.ok(Math.abs(delay - 10 * MIN) < 5_000, `waits ${delay} ms`);
    assert.deepEqual(baroPriceState(store), { visit: now - HOUR, items: 0, priced: 0 });
  });

  it('tries a failed item again in half an hour and lets the job report the failure', async () => {
    const store = new Store(':memory:');
    orders.primed_fury = { status: 404 };
    const now = Date.now();
    serveWorld(baroWorld(now));
    await assert.rejects(priceBaroStock(ctx(store), now), /not found/i);
    assert.deepEqual(baroPriceState(store), { visit: now - HOUR, items: 1, priced: 0 });

    assert.equal(await priceBaroStock(ctx(store), now + MIN), BARO_PRICE_MS, 'the next item is read meanwhile');
    assert.ok(marketCalls().includes('/orders/item/prisma_grakata/top'));
    assert.equal(await priceBaroStock(ctx(store), now + 2 * MIN), 28 * MIN, 'then it sleeps until the failed item is due again');

    orders.primed_fury = { status: 200, sell: [order(70)] };
    assert.equal(await priceBaroStock(ctx(store), now + 31 * MIN), BARO_PRICE_MS);
    assert.equal(baroPriceLookup(store, await getWorldState())!('Primed Fury'), 70);
  });
});
