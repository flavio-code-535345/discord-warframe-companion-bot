import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { planRelics } from '../src/alecaframe/planner.js';
import { api } from '../src/warframe/fetch.js';
import {
  type BookRelic,
  REFINEMENTS,
  type Refinement,
  type WfinfoPrice,
  type WfinfoTable,
  bestRelics,
  buildRelicBook,
  findRelic,
  loadRelicBook,
  priceOf,
  relicBookState,
  relicValue,
  resetRelicBook,
  slotChance,
} from '../src/warframe/relics.js';

/** WFInfo's two lists, cut down: the relic table (with a relic that lacks its rare, like Axi K1) and the price list. */
const TABLE: WfinfoTable = {
  relics: {
    Axi: {
      A1: { vaulted: false, rare1: 'Ash Prime Systems', uncommon1: 'Boar Prime Barrel', uncommon2: 'Forma Blueprint', common1: 'Paris Prime String', common2: 'Bronco Prime Barrel', common3: 'Lex Prime Receiver' },
      K1: { vaulted: true, rare1: null, uncommon1: 'Boar Prime Barrel', uncommon2: 'Forma Blueprint', common1: 'Paris Prime String', common2: 'Bronco Prime Barrel', common3: 'Lex Prime Receiver' },
    },
    Lith: {
      B1: { vaulted: false, rare1: 'Braton Prime Receiver', uncommon1: 'Forma Blueprint', uncommon2: 'Paris Prime String', common1: 'Bronco Prime Barrel', common2: 'Lex Prime Receiver', common3: 'Forma Blueprint' },
    },
    Neo: {
      V1: { vaulted: true, rare1: 'Valkyr Prime Systems', uncommon1: 'Boar Prime Barrel', uncommon2: 'Paris Prime String', common1: 'Bronco Prime Barrel', common2: 'Lex Prime Receiver', common3: 'Forma Blueprint' },
    },
  },
  eqmt: {
    'Ash Prime': { parts: { 'Ash Prime Systems': { ducats: 100 } } },
    'Boar Prime': { parts: { 'Boar Prime Barrel': { ducats: 45 } } },
    'Paris Prime': { parts: { 'Paris Prime String': { ducats: 15 } } },
  },
  ignored_items: { 'Forma Blueprint': { plat: 0, ducats: 0, volume: 0 } },
};

const PRICES: WfinfoPrice[] = [
  // The price list names Warframe parts "… Blueprint"; the relic table does not.
  { name: 'Ash Prime Systems Blueprint', custom_avg: '40', yesterday_vol: '12' },
  { name: 'Valkyr Prime Systems Blueprint', custom_avg: '60', yesterday_vol: '2' },
  { name: 'Boar Prime Barrel', custom_avg: '10.5', yesterday_vol: '3' },
  { name: 'Paris Prime String', custom_avg: '4', yesterday_vol: '30' },
  { name: 'Bronco Prime Barrel', custom_avg: 2, yesterday_vol: 50 },
  { name: 'Lex Prime Receiver', custom_avg: '3', yesterday_vol: '20' },
  { name: 'Braton Prime Receiver', custom_avg: '25', yesterday_vol: '5' },
  { name: 'Broken', custom_avg: 'n/a' },
  { name: 'Zero', custom_avg: '0' },
];

const book = buildRelicBook(TABLE, PRICES, 1_000, false);
const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);

/** Every outcome counted: each of four players draws one reward (a reward the table lacks is worth nothing), the best one counts. */
function counted(relic: BookRelic, refinement: Refinement): { solo: number; radshare: number } {
  const outcomes = relic.rewards.map((r) => ({ v: r.plat ?? 0, p: slotChance(refinement, r.rarity) }));
  const missing = 1 - outcomes.reduce((s, o) => s + o.p, 0);
  if (missing > 1e-12) outcomes.push({ v: 0, p: missing });
  const solo = outcomes.reduce((s, o) => s + o.v * o.p, 0);
  let radshare = 0;
  for (const a of outcomes) for (const b of outcomes) for (const c of outcomes) for (const d of outcomes) radshare += a.p * b.p * c.p * d.p * Math.max(a.v, b.v, c.v, d.v);
  return { solo, radshare };
}

describe('relic chances', () => {
  it("adds a relic's six rewards up to a whole at every refinement", () => {
    for (const r of REFINEMENTS) close(3 * slotChance(r, 'Common') + 2 * slotChance(r, 'Uncommon') + slotChance(r, 'Rare'), 1, r);
    close(slotChance('Intact', 'Common'), 0.76 / 3, 'intact common');
    close(slotChance('Radiant', 'Rare'), 0.1, 'radiant rare');
  });
});

describe('relic book', () => {
  it('prices Warframe parts whether or not the name says Blueprint, and skips prices that are not numbers', () => {
    assert.equal(priceOf(book.prices, 'Ash Prime Systems')?.plat, 40);
    assert.equal(priceOf(book.prices, 'ash prime systems blueprint')?.plat, 40);
    assert.equal(priceOf(book.prices, 'Boar Prime Barrel Blueprint')?.plat, 10.5);
    assert.equal(priceOf(book.prices, 'Bronco Prime Barrel')?.volume, 50);
    assert.equal(priceOf(book.prices, 'Broken'), null);
    assert.equal(priceOf(book.prices, 'Zero'), null);
  });

  it('reads each relic with its rewards, their ducats, Forma as worth nothing, and a relic missing a reward', () => {
    const a1 = findRelic(book, 'Axi A1')!;
    assert.ok(a1.complete && !a1.vaulted);
    const ash = a1.rewards.find((r) => r.rarity === 'Rare')!;
    assert.deepEqual([ash.item, ash.plat, ash.ducats, ash.volume], ['Ash Prime Systems', 40, 100, 12]);
    const forma = a1.rewards.find((r) => r.item === 'Forma Blueprint')!;
    assert.deepEqual([forma.plat, forma.ducats], [0, 0]);
    const k1 = findRelic(book, 'axi k1')!;
    assert.deepEqual([k1.complete, k1.vaulted, k1.rewards.length], [false, true, 5]);
  });

  it('finds a relic by any spelling of its name', () => {
    for (const name of ['Axi A1', 'axi a1', 'AXI A1 Relic', 'Axi A1 Radiant', '  axi a1 ']) assert.equal(findRelic(book, name)?.name, 'Axi A1', name);
    assert.equal(findRelic(book, 'Axi Z9'), null);
  });

  it('values a run alone and in a radshare exactly as counting every outcome does', () => {
    for (const relic of book.relics.values()) {
      for (const r of REFINEMENTS) {
        const want = counted(relic, r);
        const got = relicValue(relic, r);
        close(got.solo, want.solo, `${relic.name} ${r} alone`);
        close(got.radshare, want.radshare, `${relic.name} ${r} radshare`);
        assert.ok(got.radshare >= got.solo, `${relic.name} ${r}: a radshare is worth at least a solo run`);
      }
    }
    const a1 = relicValue(findRelic(book, 'Axi A1')!, 'Intact');
    // Commons 0.2533 × (4 + 2 + 3), uncommons 0.11 × 10.5, rare 0.02 × 40.
    close(a1.solo, 4.235, 'Axi A1 intact');
    // Ducats: Paris 15 × 0.2533, Boar 45 × 0.11, Ash 100 × 0.02.
    close(a1.ducats, 10.75, 'Axi A1 ducats');
    assert.equal(a1.best?.item, 'Ash Prime Systems');
  });

  it('lists the relics worth the most, best first, with the vaulted and tier filters', () => {
    const names = (opts: Parameters<typeof bestRelics>[1]) =>
      bestRelics(book, opts)
        .map((r) => r.relic.name)
        .sort();
    assert.deepEqual(names({ refinement: 'Radiant', squad: 'solo', vaulted: 'exclude' }), ['Axi A1', 'Lith B1']);
    assert.deepEqual(names({ refinement: 'Radiant', squad: 'solo', vaulted: 'only' }), ['Axi K1', 'Neo V1']);
    assert.deepEqual(names({ refinement: 'Radiant', squad: 'radshare', vaulted: 'include', tier: 'axi' }), ['Axi A1', 'Axi K1']);
    const all = bestRelics(book, { refinement: 'Radiant', squad: 'radshare', vaulted: 'include' });
    assert.equal(all.length, 4);
    assert.equal(all[0]!.relic.name, 'Neo V1');
    for (let i = 1; i < all.length; i++) assert.ok(all[i - 1]!.value.radshare >= all[i]!.value.radshare);
    assert.equal(bestRelics(book, { refinement: 'Intact', squad: 'solo', vaulted: 'include', limit: 2 }).length, 2);
  });
});

describe('loading the book', () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
    resetRelicBook();
    urls.length = 0;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetRelicBook();
  });

  it("reads WFInfo's two lists from warframestat.us once, and reuses the book", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify(String(url).endsWith('/prices') ? PRICES : TABLE), { status: 200 });
    }) as typeof fetch;
    assert.equal(relicBookState(), null);
    const [a, b] = await Promise.all([loadRelicBook(), loadRelicBook()]);
    assert.equal(a, b, 'two askers at once share one read');
    assert.equal((await loadRelicBook()).relics.size, 4);
    assert.deepEqual(urls.sort(), ['https://api.warframestat.us/wfinfo/filtered_items', 'https://api.warframestat.us/wfinfo/prices']);
    assert.deepEqual({ ...relicBookState(), fetchedAt: 0 }, { relics: 4, prices: 7, fetchedAt: 0, stale: false });
  });

  it('fails plainly when the answer is not the table', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ errors: ['down'] }), { status: 200 })) as typeof fetch;
    await assert.rejects(() => loadRelicBook(), /could not be read/);
  });
});

describe('relic planner', () => {
  const plan = planRelics(
    [
      { tier: 'Axi', code: 'A1', refinement: 'Intact', count: 5 },
      { tier: 'Axi', code: 'A1', refinement: 'Radiant', count: 1 },
      { tier: 'Neo', code: 'V1', refinement: 'Flawless', count: 2 },
      { tier: 'Lith', code: 'B1', refinement: 'Exceptional', count: 1 },
      { tier: 'Requiem', code: 'IV', refinement: 'Intact', count: 3 },
    ],
    book,
  );

  it('counts what is owned, what it is worth, the vaulted ones and the ones without prices', () => {
    assert.deepEqual({ ...plan.totals, value: 0 }, { relics: 12, kinds: 5, value: 0, vaulted: 2, unknown: 3 });
    const a1 = findRelic(book, 'Axi A1')!;
    const want = 5 * relicValue(a1, 'Intact').solo + relicValue(a1, 'Radiant').solo + 2 * relicValue(findRelic(book, 'Neo V1')!, 'Flawless').solo + relicValue(findRelic(book, 'Lith B1')!, 'Exceptional').solo;
    close(plan.totals.value, want, 'total');
  });

  it('puts the relics worth the most to open first, at the refinement owned', () => {
    // Axi A1 radiant: 0.1667 × 9 + 0.2 × 10.5 + 0.1 × 40 = 7.6; Neo V1 flawless: 0.2 × 5 + 0.17 × 14.5 + 0.06 × 60 = 7.065.
    assert.deepEqual(
      plan.open.map((r) => `${r.name} ${r.refinement}`),
      ['Axi A1 Radiant', 'Neo V1 Flawless', 'Axi A1 Intact', 'Lith B1 Exceptional'],
    );
    close(plan.open[0]!.solo, 7.6, 'Axi A1 radiant');
    close(plan.open[1]!.solo, 7.065, 'Neo V1 flawless');
    for (let i = 1; i < plan.open.length; i++) assert.ok(plan.open[i - 1]!.solo >= plan.open[i]!.solo);
    const v1 = plan.open[1]!;
    assert.equal(v1.vaulted, true);
    close(v1.radshare, relicValue(findRelic(book, 'Neo V1')!, 'Radiant').radshare, 'radshare at radiant');
  });

  it('suggests refining only what is below Radiant, with the traces it takes', () => {
    assert.ok(plan.refine.every((t) => t.relic.refinement !== 'Radiant' && t.gain >= 1));
    const a1 = plan.refine.find((t) => t.relic.name === 'Axi A1');
    assert.ok(a1, 'Axi A1 gains enough from refining');
    assert.equal(a1.traces, 100);
    close(a1.gain, relicValue(findRelic(book, 'Axi A1')!, 'Radiant').solo - relicValue(findRelic(book, 'Axi A1')!, 'Intact').solo, 'gain');
    const v1 = plan.refine.find((t) => t.relic.name === 'Neo V1');
    if (v1) assert.equal(v1.traces, 50);
    for (let i = 1; i < plan.refine.length; i++) assert.ok(plan.refine[i - 1]!.gain / plan.refine[i - 1]!.traces >= plan.refine[i]!.gain / plan.refine[i]!.traces);
  });

  it('keeps the lists short', () => {
    assert.equal(planRelics([{ tier: 'Axi', code: 'A1', refinement: 'Intact', count: 1 }], book, 0).open.length, 0);
    assert.deepEqual(planRelics([], book).totals, { relics: 0, kinds: 0, value: 0, vaulted: 0, unknown: 0 });
  });
});
