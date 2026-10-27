import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** Real tesseract output for a card with two elemental bonuses, whose icons OCR turns into "*" and "&". */
describe('elemental stat lines', () => {
  const real: RivenAttribute[] = ['Cold', 'Corrosive', 'Critical Chance', 'Zoom'].map((name) => ({ slug: name.toLowerCase().replace(/ /g, '_'), name, positiveOnly: false, negativeOnly: false }));
  it('reads a stat whose icon OCR saw as a symbol', () => {
    const lines = [[900, 'Nataruk Crita-corido'], [960, '+98.3% * Cold'], [1010, '+102.6% & Corrosive'], [1060, '+180.1% Critical Chance /'], [1110, '3 -56.9% Zoom'], [1180, '("MR 16 3% O33']].map(([y0, text]) => ({ text: String(text), x0: 0, y0: Number(y0), x1: 900, y1: Number(y0) + 40, confidence: 60 }));
    const r = parseRivenCard(lines, real, [{ slug: 'nataruk', name: 'Nataruk' }]);
    assert.equal(r.weapon!.slug, 'nataruk');
    assert.deepEqual(r.positives, [{ slug: 'cold', value: 98.3 }, { slug: 'corrosive', value: 102.6 }, { slug: 'critical_chance', value: 180.1 }]);
    assert.deepEqual(r.negative, { slug: 'zoom', value: 56.9 });
    assert.deepEqual(r.unknown, []);
  });
});

/** OCR also reads noise in the card's artwork above the name; real output for the Nataruk card. */
describe('noise around the stat lines', () => {
  const real: RivenAttribute[] = ['Ammo Maximum', 'Cold', 'Corrosive', 'Critical Chance', 'Zoom'].map((name) => ({ slug: name.toLowerCase().replace(/ /g, '_'), name, positiveOnly: false, negativeOnly: false }));
  const lines = (rows: string[]) => rows.map((text, i) => ({ text, x0: 0, y0: i * 40, x1: 900, y1: i * 40 + 30, confidence: 60 }));
  const weapons = [{ slug: 'nataruk', name: 'Nataruk' }];
  it('ignores signed numbers in the artwork above the name and the footer below the stats', () => {
    const r = parseRivenCard(lines(['p = 0.0.0.0 p,', '- 2a Pe 3', '+7.5% Fob Barr', '2 Nataruk Crita-corido', '+98.3% *# Cold', '+102.6% & Corrosive', '+180.1% Critical Chance', '-56.9% Zoom', '» MR 16 0 33 V', '-12.5% Ammo Zzz']), real, weapons);
    assert.deepEqual(r.positives.map((p) => p.slug), ['cold', 'corrosive', 'critical_chance']);
    assert.deepEqual(r.negative, { slug: 'zoom', value: 56.9 });
    assert.deepEqual(r.unknown, []);
  });

  it('still reads every line when the name could not be found', () => {
    const r = parseRivenCard(lines(['+98.3% Cold', '+102.6% Corrosive']), real, weapons);
    assert.equal(r.positives.length, 2);
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

  it('shrinks huge pictures before reading them, so a 4K screenshot does not take minutes', () => {
    const big = prepareForOcr(png(3840, 2160, 20, 230), 'image/png')!;
    assert.deepEqual([big.width, big.height, big.scale], [1920, 1080, 1], '3840 wide is halved');
    assert.equal(prepareForOcr(png(2600, 1400, 20, 230), 'image/png')!.scale, 1, 'a 2600 wide picture is left alone');
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

  it('goes by what the file really is, not by the content type Discord gave', async () => {
    const r = await scanCard(ctx(), picture, 'image/webp', async () => card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage'));
    assert.ok(r.report, 'a PNG labelled WebP is still read');
    const { sniffMime } = await import('../src/rivens/scan.js');
    assert.deepEqual([sniffMime(picture), sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), sniffMime(new Uint8Array([1, 2, 3]))], ['image/png', 'image/jpeg', null]);
  });

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
    await assert.rejects(scanCard(ctx(), new Uint8Array([1, 2, 3]), 'image/png', async () => []), /couldn't open this one \(file header: unknown, labelled image\/png, 1 KB\)/);
    await assert.rejects(
      scanCard(ctx(), picture, 'image/png', async () => {
        throw new Error('worker died');
      }),
      /could not read that picture/,
    );
  });
});

describe('WebP screenshots', () => {
  it('decodes a WebP picture and prepares it for OCR like a PNG', async () => {
    const require = createRequire(import.meta.url);
    const wasmWebp = require('@saschazar/wasm-webp') as (o: object) => any;
    const defaults = require('@saschazar/wasm-webp/options') as object;
    const wasmBinary = readFileSync(require.resolve('@saschazar/wasm-webp/wasm_webp.wasm'));
    const { decodeWebp, webpToPng } = await import('../src/imaging/webp.js');
    // Make a WebP with the same module's encoder: a dark picture with light stripes, 120x60.
    const rgb = new Uint8Array(120 * 60 * 3);
    for (let i = 0; i < 120 * 60; i++) rgb.fill((i % 120) % 9 === 0 ? 230 : 20, i * 3, i * 3 + 3);
    const webp: Uint8Array = await new Promise((resolve) => {
      wasmWebp({ wasmBinary, onRuntimeInitialized(this: any) { resolve(Uint8Array.from(this.encode(rgb, 120, 60, 3, defaults))); this.free(); } });
    });
    const px = (await decodeWebp(webp))!;
    assert.deepEqual([px.width, px.height, px.data.length], [120, 60, 120 * 60 * 4]);
    assert.ok(px.data[0]! > 150 && px.data[4 * 1]! < 80, 'the stripe pattern survived');
    const png = (await webpToPng(webp))!;
    const prepared = prepareForOcr(png, 'image/png')!;
    assert.deepEqual([prepared.width, prepared.height, prepared.inverted], [360, 180, true]);
    assert.equal(await decodeWebp(new Uint8Array([1, 2, 3])), null, 'a damaged file is refused');
    assert.ok(await decodeWebp(webp), 'and the decoder still works afterwards');
  });
});
