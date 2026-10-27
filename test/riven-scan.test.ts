import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { Store } from '../src/db.js';
import { findWeapon, parseRivenCard } from '../src/rivens/card.js';
import { resetRivenFilter, resetRivenLists } from '../src/rivens/market.js';
import { prepareForOcr, scaleFor } from '../src/rivens/prepare.js';
import { scanCard } from '../src/rivens/scan.js';
import type { RivenAttribute, RivenWeapon } from '../src/rivens/types.js';
import type { OcrLine } from '../src/ssroles/parse.js';
import { api } from '../src/warframe/fetch.js';

const attrs: RivenAttribute[] = [
  ['critical_chance', 'Critical Chance'],
  ['critical_damage', 'Critical Damage'],
  ['multishot', 'Multishot'],
  ['status_chance', 'Status Chance'],
  ['zoom', 'Zoom'],
  ['weapon_recoil', 'Weapon Recoil'],
  ['punch_through', 'Punch Through'],
].map(([slug, name]) => ({ slug: slug!, name: name!, positiveOnly: slug === 'punch_through', negativeOnly: false }));
const weapons: RivenWeapon[] = [
  { slug: 'bramma', name: 'Bramma' },
  { slug: 'kuva_bramma', name: 'Kuva Bramma' },
  { slug: 'soma', name: 'Soma' },
];

/** OCR lines top to bottom, as tesseract would hand them over. */
const card = (...texts: string[]): OcrLine[] => texts.map((text, i) => ({ text, x0: 10, y0: 20 + i * 30, x1: 300, y1: 40 + i * 30, confidence: 90 }));

describe('reading a riven card', () => {
  it('finds the weapon, the bonuses with their values and the curse', () => {
    const r = parseRivenCard(card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112,5% Critical Damage', '+95.3% Multishot', '-42.1% Zoom', 'Rank 0/8', 'MR 14', '12 Rerolls'), attrs, weapons);
    assert.equal(r.weapon!.slug, 'kuva_bramma', 'the longer name wins over "Bramma"');
    assert.deepEqual(r.positives, [
      { slug: 'critical_chance', value: 168.7 },
      { slug: 'critical_damage', value: 112.5 },
      { slug: 'multishot', value: 95.3 },
    ]);
    assert.deepEqual(r.negative, { slug: 'zoom', value: 42.1 });
    assert.deepEqual(r.unsureSign, []);
    assert.deepEqual(r.unknown, []);
  });

  it('works from the position of the lines, not the order OCR returned them in', () => {
    const lines = card('Kuva Bramma Crita-lexitis', '+10% Critical Chance', '+20% Critical Damage');
    const r = parseRivenCard([lines[2]!, lines[0]!, lines[1]!], attrs, weapons);
    assert.deepEqual(r.positives.map((p) => p.slug), ['critical_chance', 'critical_damage']);
  });

  it('forgives the usual OCR slips: a wrong letter, a different minus sign, a stray symbol', () => {
    const r = parseRivenCard(card('© Kuva Brarma Hexa-tox', '+168.7% Crltical Chance', '+ 95.3 % Multishot', '— 42.1% Zoom'), attrs, weapons);
    assert.equal(r.weapon!.slug, 'kuva_bramma');
    assert.deepEqual(r.positives.map((p) => p.slug), ['critical_chance', 'multishot']);
    assert.equal(r.negative!.slug, 'zoom');
  });

  it('says so when it cannot see the sign, and takes a fourth line as the curse', () => {
    const r = parseRivenCard(card('Soma Visi-cron', '168.7% Critical Chance', '112.5% Critical Damage', '95.3% Multishot', '42.1% Zoom'), attrs, weapons);
    assert.deepEqual(r.positives.map((p) => p.slug), ['critical_chance', 'critical_damage', 'multishot']);
    assert.equal(r.negative!.slug, 'zoom');
    assert.equal(r.unsureSign.length, 4);
    const three = parseRivenCard(card('Soma Visi-cron', '168.7% Critical Chance', '112.5% Critical Damage', '42.1% Zoom'), attrs, weapons);
    assert.equal(three.positives.length, 3, 'with three unsigned lines it can only guess they are all bonuses (and says so)');
    assert.equal(three.unsureSign.length, 3);
  });

  it('knows that less recoil is the bonus and more recoil the curse', () => {
    const r = parseRivenCard(card('Soma Visi-cron', '+100% Critical Chance', '-55.3% Weapon Recoil', '+90% Multishot'), attrs, weapons);
    assert.deepEqual(r.positives.map((p) => p.slug), ['critical_chance', 'weapon_recoil', 'multishot']);
    assert.equal(r.negative, null);
    const cursed = parseRivenCard(card('Soma Visi-cron', '+100% Critical Chance', '+90% Multishot', '+30.1% Weapon Recoil'), attrs, weapons);
    assert.equal(cursed.negative!.slug, 'weapon_recoil');
  });

  it('reports stat lines it cannot match, ignores lines that are not stats, and counts a repeated stat once', () => {
    const r = parseRivenCard(card('Soma Visi-cron', '+10% Frobnicate Rate', '+100% Critical Chance', '+100% Critical Chance', '+90% Multishot', 'Rerolls: 3'), attrs, weapons);
    assert.deepEqual(r.unknown, ['+10% Frobnicate Rate']);
    assert.deepEqual(r.positives.map((p) => p.slug), ['critical_chance', 'multishot']);
  });

  it('returns nothing for a screenshot that is not a riven card', () => {
    const r = parseRivenCard(card('Inventory', 'Mods', 'Search'), attrs, weapons);
    assert.equal(r.weapon, null);
    assert.deepEqual(r.positives, []);
  });

  it('matches weapon names only as whole words', () => {
    assert.equal(findWeapon(weapons, ['Somatic Visi-cron']), null);
    assert.equal(findWeapon(weapons, ['Soma Visi-cron'])!.slug, 'soma');
  });
});

/** What the real OCR engine returned for a real in-game riven card (Zarr Crita-parciata), with the mouse pointer over "Critical Chance". */
describe('a real screenshot', () => {
  const real: RivenAttribute[] = ['Critical Chance', 'Critical Damage', 'Ammo Efficiency', 'Damage', 'Zoom', 'Multishot'].map((name) => ({ slug: name.toLowerCase().replace(/ /g, '_'), name, positiveOnly: false, negativeOnly: false }));
  const zarr: RivenWeapon[] = [{ slug: 'zarr', name: 'Zarr' }, { slug: 'zakti', name: 'Zakti' }];
  const at = (rows: [number, string][]): OcrLine[] => rows.map(([y0, text]) => ({ text, x0: 0, y0, x1: 900, y1: y0 + 60, confidence: 50 }));

  const cleaned = at([
    [75, '. ’ ; CR , — ag ='], [149, 'Lh % BAA - KE 9='], [675, '% 4 NY > ve ) § Py sal A'], [802, 'ANE CI'],
    [960, '2 Zarr Crita-parciata'], [1080, '+183.5% clk] al'], [1173, '+54.4% Ammo ETiiciency'], [1262, '+172.2% Damage p'], [1351, 'vy & -50.9% Zoom'], [1477, '“1% MR 9 O 141 2%’'],
  ]);
  const original = at([
    [41, 'ARN. Tend'], [320, '2 Zar Crita-parciata'], [360, '+183.5% SHlic hares'], [389, '+54.4% Ammo ENiciency'], [418, '+172.2% Damage Ps'], [446, 'vy -50.9% Zoom b'], [493, '(7% MR 9 O 141'],
  ]);

  it('reads the weapon, the stats it can, forgives the stray letters, and flags the line the pointer covers', () => {
    for (const lines of [cleaned, original]) {
      const r = parseRivenCard(lines, real, zarr);
      assert.equal(r.weapon!.slug, 'zarr', 'also from "2 Zar Crita-parciata", because the name before a hyphenated word is the weapon');
      assert.deepEqual(r.positives, [{ slug: 'ammo_efficiency', value: 54.4 }, { slug: 'damage', value: 172.2 }]);
      assert.deepEqual(r.negative, { slug: 'zoom', value: 50.9 });
      assert.equal(r.unknown.length, 1, 'the covered Critical Chance line, and not the footer "MR 9"');
      assert.match(r.unknown[0]!, /^\+183\.5%/);
    }
  });

  it('refuses to grade around a stat it could not read, and explains how to fix it', async () => {
    const store = new Store(':memory:');
    const ctx = { store, config: { RIVEN_HIGH_PRICE: 1000 } } as never;
    const realFetch = globalThis.fetch;
    api.reset();
    resetRivenLists();
    globalThis.fetch = (async (url: string) => {
      const p = new URL(String(url)).pathname;
      if (p === '/v2/riven/weapons') return new Response(JSON.stringify({ data: zarr.map((w) => ({ slug: w.slug, i18n: { en: { name: w.name } } })) }));
      if (p === '/v2/riven/attributes') return new Response(JSON.stringify({ data: real.map((a) => ({ slug: a.slug, i18n: { en: { name: a.name } } })) }));
      return new Response('?', { status: 500 });
    }) as typeof fetch;
    try {
      const pic = new PNG({ width: 30, height: 30 });
      pic.data.fill(255);
      const result = await scanCard(ctx, PNG.sync.write(pic), 'image/png', async () => cleaned);
      assert.equal(result.report, null);
      assert.match(result.problem!, /couldn't read one of the stat lines.*\+183\.5%.*won't guess.*mouse pointer/);
      assert.match(result.problem!, /weapon Zarr, Ammo Efficiency 54\.4, Damage 172\.2, curse Zoom and the stat I couldn't read/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('grades it once nothing covers the text', () => {
    const clear = at([[960, '2 Zarr Crita-parciata'], [1080, '+183.5% Critical Chance'], [1173, '+54.4% Ammo Efficiency'], [1262, '+172.2% Damage'], [1351, '-50.9% Zoom']]);
    const r = parseRivenCard(clear, real, zarr);
    assert.deepEqual(r.positives.map((p) => p.slug), ['critical_chance', 'ammo_efficiency', 'damage']);
    assert.deepEqual(r.unknown, []);
  });
});

describe('preparing a picture for OCR', () => {
  const png = (width: number, height: number, background: number, ink: number): Uint8Array => {
    const p = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) {
      const v = (i % width) % 7 === 0 ? ink : background;
      p.data[i * 4] = v;
      p.data[i * 4 + 1] = v;
      p.data[i * 4 + 2] = v;
      p.data[i * 4 + 3] = 255;
    }
    return PNG.sync.write(p);
  };

  it('enlarges small pictures, and turns light-on-dark into dark-on-light', () => {
    const dark = prepareForOcr(png(300, 200, 20, 230), 'image/png')!;
    assert.deepEqual([dark.width, dark.height, dark.scale, dark.inverted], [900, 600, 3, true]);
    assert.equal(PNG.sync.read(Buffer.from(dark.png)).width, 900);
    const light = prepareForOcr(png(300, 200, 240, 20), 'image/png')!;
    assert.equal(light.inverted, false);
  });

  it('keeps big pictures at their size, never builds a huge one, and refuses what it cannot decode', () => {
    assert.equal(scaleFor(1920, 1080), 1);
    assert.equal(scaleFor(1000, 600), 2);
    assert.equal(scaleFor(5000, 2000), 1);
    assert.equal(prepareForOcr(new Uint8Array([1, 2, 3]), 'image/png'), null);
    assert.equal(prepareForOcr(png(10, 10, 0, 255), 'image/webp'), null);
  });
});

describe('scanning a riven', () => {
  const realFetch = globalThis.fetch;
  const json = (data: unknown) => new Response(JSON.stringify(data));
  const listings = (): { price: number; stats: [string, boolean][] }[] => [
    ...Array.from({ length: 10 }, () => ({ price: 1500, stats: [['critical_chance', true], ['critical_damage', true], ['multishot', true], ['zoom', false]] as [string, boolean][] })),
    ...Array.from({ length: 10 }, () => ({ price: 60, stats: [['zoom', true], ['weapon_recoil', true], ['status_chance', true]] as [string, boolean][] })),
  ];

  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
    resetRivenLists();
    resetRivenFilter();
    globalThis.fetch = (async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === '/v2/riven/weapons') return json({ data: weapons.map((w) => ({ slug: w.slug, i18n: { en: { name: w.name } } })) });
      if (u.pathname === '/v2/riven/attributes') return json({ data: attrs.map((a) => ({ slug: a.slug, positiveOnly: a.positiveOnly, i18n: { en: { name: a.name } } })) });
      if (u.pathname === '/v1/auctions/search') {
        const want = u.searchParams.get('positive_stats')?.split(',');
        const rows = listings().filter((l) => !want || want.every((w) => l.stats.some(([s, p]) => p && s === w)));
        return json({ payload: { auctions: rows.map((l, i) => ({ id: `a${i}`, buyout_price: l.price, item: { type: 'riven', polarity: 'madurai', re_rolls: 2, attributes: l.stats.map(([url_name, positive]) => ({ url_name, value: 100, positive })) } })) } });
      }
      return new Response('?', { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const ctx = () => ({ store: new Store(':memory:'), config: { RIVEN_HIGH_PRICE: 1000 } }) as never;
  const picture = (() => {
    const p = new PNG({ width: 40, height: 40 });
    p.data.fill(255);
    return PNG.sync.write(p);
  })();

  it('reads a card with OCR and grades what it found', async () => {
    const calls: number[] = [];
    const r = await scanCard(ctx(), picture, 'image/png', async (image) => {
      calls.push(image.length);
      return card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage', '+95.3% Multishot', '-42.1% Zoom');
    });
    assert.equal(calls.length, 1);
    assert.equal(r.problem, null);
    assert.equal(r.report!.grade!.letter, 'S');
    assert.equal(r.report!.weapon.slug, 'kuva_bramma');
    assert.equal(r.reading.negative!.slug, 'zoom');
  });

  it('tries the original picture when the cleaned one gives nothing, and keeps the better reading', async () => {
    let n = 0;
    const r = await scanCard(ctx(), picture, 'image/png', async () => {
      n++;
      return n === 1 ? card('garbage', 'noise') : card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage');
    });
    assert.equal(n, 2);
    assert.equal(r.reading.positives.length, 2);
    assert.ok(r.report);
  });

  it('says what is missing instead of grading a guess', async () => {
    const noWeapon = await scanCard(ctx(), picture, 'image/png', async () => card('+168.7% Critical Chance', '+112.5% Critical Damage'));
    assert.equal(noWeapon.report, null);
    assert.match(noWeapon.problem!, /couldn't find the weapon/);
    const oneStat = await scanCard(ctx(), picture, 'image/png', async () => card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance'));
    assert.equal(oneStat.report, null);
    assert.match(oneStat.problem!, /only found 1 bonus stat\b/);
    const silly = await scanCard(ctx(), picture, 'image/png', async () => card('Kuva Bramma Crita-lexitis', '+10% Punch Through', '+20% Critical Chance', '+30% Multishot', '-40% Punch Through'));
    assert.equal(silly.reading.positives.length, 3);
  });

  it('turns an unreadable picture or a failing reader into a plain explanation', async () => {
    await assert.rejects(scanCard(ctx(), new Uint8Array([1, 2, 3]), 'image/png', async () => []), /PNG and JPEG/);
    await assert.rejects(
      scanCard(ctx(), picture, 'image/png', async () => {
        throw new Error('worker died');
      }),
      /could not read that picture/,
    );
  });
});
