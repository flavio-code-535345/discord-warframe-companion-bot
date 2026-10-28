import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { woffToSfnt } from '../src/imaging/font.js';
import { cardCrop, rivenPicture } from '../src/rivens/picture.js';
import { categoryOf, rawNames, statKey } from '../src/rivens/ranges.js';
import { MIN_SAMPLES, fitsTable, gradeRolls, letterFor, repairValues, weightOf } from '../src/rivens/rolls.js';
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

describe('grading from the game ranges', () => {
  const near = (actual: number | null | undefined, expected: number, label: string) => assert.ok(actual !== null && actual !== undefined && Math.abs(actual - expected) < 0.05, `${label}: ${actual} vs ${expected}`);
  const devs = (r: ReturnType<typeof gradeRolls>) => Object.fromEntries(r.map((x) => [x.slug, x.deviation]));

  it('grades a rifle card (Zarr) from the table, finding the kind of weapon by what fits', () => {
    const d = devs(gradeRolls([], [{ slug: 'critical_chance', value: 183.5 }, { slug: 'ammo_efficiency', value: 54.4 }, { slug: 'damage', value: 172.2 }], { slug: 'zoom', value: 50.9 }));
    near(d.critical_chance, 8.75, 'cc');
    near(d.ammo_efficiency, 7.46, 'ammo efficiency');
    near(d.damage, -7.23, 'damage');
    near(d.zoom, 5.72, 'zoom (a curse: milder is better)');
  });

  it('grades a pistol card (Nukor): a rifle can not have 228% damage, so the pistol ranges are used', () => {
    const r = gradeRolls([], [{ slug: 'damage', value: 228.3 }, { slug: 'multishot', value: 138.6 }, { slug: 'status_damage', value: 95.2 }], { slug: 'zoom', value: 71.6 });
    const d = devs(r);
    near(d.damage, -7.59, 'damage');
    near(d.multishot, 2.92, 'multishot');
    near(d.status_damage, -5.98, 'status damage');
    near(d.zoom, 0.68, 'zoom');
    assert.deepEqual(r.map((x) => x.letter), ['C-', 'B+', 'C', 'B']);
  });

  it('reproduces the reference card with the weapon\'s disposition (1.1) and the kind the market names', () => {
    const r = gradeRolls([], [{ slug: 'reload_speed', value: 46.9 }, { slug: 'heat', value: 101.3 }, { slug: 'puncture', value: 128.7 }], { slug: 'damage', value: 167.8 }, { type: 'pistol', disposition: 1.1 });
    const d = devs(r);
    near(d.heat, 9.159, 'heat');
    near(d.puncture, 4.042, 'puncture');
    assert.ok(Math.abs(d.reload_speed! - -9.109) < 0.1, 'reload ' + d.reload_speed);
    near(d.damage, 7.395, 'damage curse');
    assert.deepEqual(r.map((x) => x.letter), ['C-', 'A+', 'A-', 'A']);
  });

  it('grades a melee card with a faction multiplier as the curse (Ripkas)', () => {
    const r = gradeRolls([], [{ slug: 'slash', value: 194.1 }, { slug: 'base_damage_melee_damage', value: 252.6 }], { slug: 'damage_vs_infested', value: 0.75 }, { type: 'melee' });
    const d = devs(r);
    near(d.slash, 8.92, 'slash');
    near(d.base_damage_melee_damage, 3.28, 'melee damage');
    near(d.damage_vs_infested, 6.48, 'faction curse: x0.75 is milder than the average x0.733');
    assert.deepEqual(r.map((x) => x.letter), ['A+', 'B+', 'A']);
  });

  it('grades the Aklex card (a pistol) from the table', () => {
    const d = devs(gradeRolls([], [{ slug: 'damage', value: 244.2 }, { slug: 'multishot', value: 123.7 }, { slug: 'electricity', value: 101.5 }], { slug: 'zoom', value: 74.6 }, { type: 'pistol' }));
    near(d.damage, -1.15, 'damage');
    near(d.multishot, -8.14, 'multishot');
    near(d.electricity, 0.25, 'electricity');
    near(d.zoom, -3.49, 'zoom (a curse, worse than the average)');
  });

  it('puts right a misread value when that makes every stat fit (Nukor: "d 195.2%" for +95.2%), and only then', () => {
    const nukor = { type: 'pistol', disposition: 1.45 };
    const bonuses = (status: number) => [{ slug: 'damage', value: 228.3 }, { slug: 'multishot', value: 138.6 }, { slug: 'status_damage', value: status }];
    const curse = { slug: 'zoom', value: 71.6 };
    assert.equal(fitsTable(bonuses(95.2), curse, nukor), true);
    assert.equal(fitsTable(bonuses(195.2), curse, nukor), false);
    assert.equal(repairValues(bonuses(95.2), curse, nukor), null, 'nothing to repair on a card that fits');
    const byDigit = repairValues(bonuses(195.2), curse, nukor)!;
    assert.equal(byDigit.positives[2]!.value, 95.2, 'one stray digit removed');
    assert.deepEqual(byDigit.positives.slice(0, 2).map((p) => p.value), [228.3, 138.6], 'the stats that were right are left alone');
    const byReading = repairValues(bonuses(195.2), curse, nukor, new Map([['status_damage', [95.2]]]))!;
    assert.equal(byReading.positives[2]!.value, 95.2, 'or the value another reading of the picture gave');
    assert.equal(repairValues(bonuses(150), curse, nukor), null, 'no correction makes it fit: it stays as read');
    // The corrected card is graded from the table like any other.
    const r = gradeRolls([], byDigit.positives, byDigit.negative, nukor);
    assert.ok(r.every((x) => x.deviation !== null && Math.abs(x.deviation) < 10.7));
  });

  it('falls back to the listings when no kind of weapon fits (here: a stat the table does not have)', () => {
    const odd = gradeRolls(scisco(), [{ slug: 'reload_speed', value: 46.9 }, { slug: 'heat', value: 101.3 }, { slug: 'puncture', value: 128.7 }], { slug: 'damage', value: 167.8 });
    assert.ok(Math.abs(odd.find((x) => x.slug === 'heat')!.deviation! - 9.159) < 0.15, 'the older, listing-based estimate');
  });

  it('knows every stat name of the wiki, and the market spellings of them', () => {
    for (const { category, name } of rawNames()) assert.notEqual(statKey(name), null, `${category}: ${name}`);
    const same: [string, string][] = [['Heat', 'elemental'], ['Viral', 'combined'], ['Fire Rate / Attack Speed', 'rate'], ['fire_rate_attack_speed', 'rate'], ['Weapon Recoil', 'recoil'], ['Base Damage / Melee Damage', 'damage'], ['Weak Point Damage', 'weakpoint'], ['Puncture', 'physical'], ['Critical Chance on Slide Attack', 'crit_slide']];
    for (const [market, key] of same) assert.equal(statKey(market), key, market);
    assert.equal(statKey('Damage vs Grineer'), 'faction');
    assert.equal(statKey('Damage to Infested'), 'faction');
    assert.equal(statKey('Melee Damage'), 'damage');
    assert.equal(statKey('Melee Damage on Heavy Attack'), 'heavy_damage');
    assert.equal(categoryOf('Primary'), 'rifle');
    assert.equal(categoryOf('SECONDARY'), 'pistol');
    assert.equal(categoryOf('kitgun'), 'pistol');
    assert.equal(categoryOf('zaw'), 'melee');
    assert.equal(categoryOf('archgun'), 'archgun');
    assert.equal(categoryOf(undefined), null);
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
