import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { woffToSfnt } from '../src/imaging/font.js';
import { cardCrop, rivenPicture } from '../src/rivens/picture.js';
import { MIN_SAMPLES, gradeRolls, letterFor, weightOf } from '../src/rivens/rolls.js';
import type { RivenListing } from '../src/rivens/types.js';

const listing = (id: string, stats: [string, number, boolean][]): RivenListing => ({ id, weapon: 'arca_scisco', price: 500, polarity: 'madurai', rerolls: 3, stats: stats.map(([slug, value, positive]) => ({ slug, value, positive })) });

/**
 * The Arca Scisco card of the reference picture: +101.3% Heat, +128.7% Puncture, +46.9% Reload Speed and a -167.8% Damage curse (3 bonuses and
 * a curse). Listings whose best rolls are 110% of those averages put the card at the positions the reference tool printed.
 */
const AVERAGE = { heat: 92.8, puncture: 123.7, reload_speed: 51.6, damage: 181.2 };
const scisco = (): RivenListing[] =>
  Array.from({ length: MIN_SAMPLES + 2 }, (_, i) => {
    const f = i === 0 ? 1.1 : 0.93 + i * 0.005;
    return listing(`a${i}`, [['heat', AVERAGE.heat * f, true], ['puncture', AVERAGE.puncture * f, true], ['reload_speed', AVERAGE.reload_speed * f, true], ['damage', -AVERAGE.damage * (i === 0 ? 1.1 : 1.02 - i * 0.01), false]]);
  });

describe('grading every stat of a riven', () => {
  it('puts each roll where its position in the 90%-110% range is, like the reference picture', () => {
    const r = gradeRolls(scisco(), [{ slug: 'reload_speed', value: 46.9 }, { slug: 'heat', value: 101.3 }, { slug: 'puncture', value: 128.7 }], { slug: 'damage', value: 167.8 });
    const by = Object.fromEntries(r.map((x) => [x.slug, x]));
    assert.ok(Math.abs(by.heat!.deviation! - 9.159) < 0.15, `heat ${by.heat!.deviation}`);
    assert.equal(by.heat!.letter, 'A+');
    assert.ok(Math.abs(by.puncture!.deviation! - 4.042) < 0.15, `puncture ${by.puncture!.deviation}`);
    assert.equal(by.puncture!.letter, 'A-');
    assert.ok(Math.abs(by.reload_speed!.deviation! - -9.109) < 0.15, `reload ${by.reload_speed!.deviation}`);
    assert.equal(by.reload_speed!.letter, 'C-');
    // A curse is better the milder it is: 167.8 against an average of 181.2 is +7.4%.
    assert.ok(Math.abs(by.damage!.deviation! - 7.395) < 0.15, `curse ${by.damage!.deviation}`);
    assert.equal(by.damage!.letter, 'A');
    assert.equal(by.damage!.curse, true);
    assert.deepEqual(r.map((x) => x.slug), ['reload_speed', 'heat', 'puncture', 'damage'], 'in the order of the card');
  });

  it('never rates a roll above +10%, because the card itself counts as a sample of the range', () => {
    const r = gradeRolls(scisco(), [{ slug: 'reload_speed', value: 70 }, { slug: 'heat', value: 101.3 }, { slug: 'puncture', value: 128.7 }], { slug: 'damage', value: 167.8 });
    assert.equal(r.find((x) => x.slug === 'reload_speed')!.deviation, 10);
  });

  it('brings listings with other numbers of bonuses and curses to the same scale', () => {
    // The same roll quality shows up with a different multiplier on a riven with two bonuses and a curse (1.2375 instead of 0.9375).
    const other = Array.from({ length: MIN_SAMPLES }, (_, i) => listing(`b${i}`, [['heat', (i === 0 ? 1.1 : 0.95) * 100 * 1.2375, true], ['zoom', 10, true], ['damage', -50, false]]));
    const r = gradeRolls(other, [{ slug: 'heat', value: 100 * 1.2375 }, { slug: 'zoom', value: 10 }], { slug: 'damage', value: 50 });
    // The best seen is 110 (so the average is 100), and the card rolled exactly 100: dead centre, whatever multiplier it was rolled with.
    assert.ok(Math.abs(r[0]!.deviation!) < 0.01, `heat ${r[0]!.deviation}`);
    assert.equal(r[0]!.letter, letterFor(r[0]!.deviation!));
    assert.equal(weightOf(2, true, false), 1.2375);
    assert.equal(weightOf(3, true, true), 0.75);
    assert.equal(weightOf(3, false, true), null, 'no curse in that structure');
    assert.equal(weightOf(1, false, false), null);
  });

  it('gives no grade when too few listings show the stat (instead of inventing a range) or when no value was read', () => {
    const few = scisco().slice(0, MIN_SAMPLES - 1);
    const r = gradeRolls(few, [{ slug: 'heat', value: 101.3 }, { slug: 'puncture' }, { slug: 'reload_speed', value: 46.9 }], { slug: 'damage', value: 167.8 });
    assert.ok(r.every((x) => x.letter === null && x.deviation === null));
    assert.equal(r[0]!.samples, MIN_SAMPLES - 1);
    const none = gradeRolls(scisco(), [{ slug: 'puncture' }, { slug: 'heat', value: 101.3 }, { slug: 'reload_speed', value: 46.9 }], null);
    assert.equal(none[0]!.letter, null, 'no value on the card for that stat');
  });

  it('turns a deviation into a letter', () => {
    assert.deepEqual([10, 9.159, 7.395, 4.042, 2, 0, -1, -3, -5, -7, -9.109, -9.9].map(letterFor), ['A+', 'A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'C-', 'D']);
  });
});

describe('the picture', () => {
  it('crops a big screenshot to the card, and leaves a small one alone', () => {
    assert.deepEqual(cardCrop(400, 600, { x0: 50, y0: 400, x1: 300, y1: 500 }), { x: 0, y: 0, w: 400, h: 600 });
    const crop = cardCrop(1920, 1080, { x0: 800, y0: 600, x1: 1100, y1: 780 });
    assert.ok(crop.x < 800 && crop.x + crop.w > 1100 && crop.y < 600 && crop.y + crop.h > 780, 'the text block is inside the crop');
    assert.ok(crop.w < 1920 / 2 && crop.h < 1080, 'and the crop is much smaller than the screen');
    assert.deepEqual(cardCrop(1920, 1080, null), { x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('is drawn for a graded card, and not when there is nothing to draw next to', async () => {
    const shot = new PNG({ width: 300, height: 400 });
    shot.data.fill(120);
    const bytes = PNG.sync.write(shot);
    const names = { heat: 'Heat', zoom: 'Zoom' };
    const base = {
      reading: { weapon: { slug: 'arca_scisco', name: 'Arca Scisco' }, positives: [{ slug: 'heat', value: 101.3 }, { slug: 'puncture', value: 128.7 }], negative: { slug: 'zoom', value: 20 }, unsureSign: [], unknown: [], statLines: [], guessed: [] },
      names,
      report: { rolls: [{ slug: 'heat', value: 101.3, curse: false, deviation: 9.159, letter: 'A+', samples: 30 }, { slug: 'puncture', value: 128.7, curse: false, deviation: null, letter: null, samples: 2 }, { slug: 'zoom', value: 20, curse: true, deviation: -9.109, letter: 'C-', samples: 30 }] },
      image: { bytes, mime: 'image/png' },
      box: null,
    };
    const out = await rivenPicture(base as never);
    const png = PNG.sync.read(out!);
    assert.ok(png.width > 700 && png.height >= 300, 'the card on the left (300 px wide, scaled up a little), a 400 px panel on the right');
    // Green for the A+ row and red for the C- row: look for strongly green and strongly red pixels in the panel.
    let green = 0;
    let red = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i + 1]! > 200 && png.data[i]! < 90 && png.data[i + 2]! < 120) green++;
      if (png.data[i]! > 200 && png.data[i + 1]! < 110 && png.data[i + 2]! < 90) red++;
    }
    assert.ok(green > 50 && red > 50, `green ${green} red ${red}`);
    assert.equal(await rivenPicture({ ...base, report: null } as never), null);
    assert.equal(await rivenPicture({ ...base, image: null } as never), null);
  });
});

describe('fonts', () => {
  it('converts the WOFF in @fontsource/roboto to a TTF the drawing library can read', () => {
    const woff = readFileSync(createRequire(import.meta.url).resolve('@fontsource/roboto/files/roboto-latin-400-normal.woff'));
    const ttf = woffToSfnt(woff);
    assert.deepEqual([...ttf.subarray(0, 4)], [0, 1, 0, 0], 'TrueType header');
    assert.ok(ttf.length > woff.length, 'tables are no longer compressed');
    assert.throws(() => woffToSfnt(new Uint8Array(64)), /not a WOFF/);
  });
});
