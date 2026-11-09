import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { EMOJI_SIZE, cycleIcon, omniaIcon, shade, tierBadge } from '../src/imaging/badges.js';
import { boltIcon, coldIcon, crescent, dayIcon, fassIcon, moodIcon, nightIcon, starIcon, vomeIcon, warmIcon } from '../src/imaging/icons.js';

/** One pixel's red, green, blue and alpha. */
function pixel(img: PNG, x: number, y: number) {
  const i = (y * img.width + x) * 4;
  return { r: img.data[i]!, g: img.data[i + 1]!, b: img.data[i + 2]!, a: img.data[i + 3]! };
}

describe('drawn emojis', () => {
  it('draws a tier badge: 128 px, transparent corners, the tier colour around a dark letter', async () => {
    const buf = await tierBadge('S', '#f5c542');
    assert.ok(buf.length < 256 * 1024, 'under Discord’s emoji limit');
    const img = PNG.sync.read(buf);
    assert.equal(img.width, EMOJI_SIZE);
    assert.equal(img.height, EMOJI_SIZE);
    assert.equal(pixel(img, 0, 0).a, 0, 'a corner outside the rounded square is transparent');
    assert.equal(pixel(img, 127, 127).a, 0);
    const fill = pixel(img, 20, 64);
    assert.equal(fill.a, 255);
    assert.ok(fill.r > 200 && fill.g > 150 && fill.b < 140, `gold at the left edge, got ${JSON.stringify(fill)}`);
    // Somewhere in the middle row the letter's near-black stroke crosses.
    const row = Array.from({ length: 60 }, (_, i) => pixel(img, 34 + i, 66));
    assert.ok(row.some((p) => p.a === 255 && p.r < 40 && p.g < 40), 'the letter is drawn');
  });

  it('draws the Omnia icon in white and the cycle icon in two halves', async () => {
    const omnia = PNG.sync.read(await omniaIcon());
    assert.equal(pixel(omnia, 0, 0).a, 0);
    const ring = pixel(omnia, 64 - 43, 64);
    assert.ok(ring.a > 200 && ring.r > 240 && ring.g > 240 && ring.b > 240, `white ring, got ${JSON.stringify(ring)}`);

    const cycle = PNG.sync.read(await cycleIcon());
    const day = pixel(cycle, 40, 64);
    const night = pixel(cycle, 88, 64);
    assert.ok(day.r > 200 && day.b < 150, `the left half is the sun, got ${JSON.stringify(day)}`);
    assert.ok(night.b > night.r, `the right half is the night, got ${JSON.stringify(night)}`);
  });

  it('draws the cycle states, the moods and the markers: 128 px, transparent corners, something drawn in the middle', async () => {
    const all = [dayIcon, nightIcon, warmIcon, coldIcon, fassIcon, vomeIcon, starIcon, boltIcon, () => moodIcon('joy'), () => moodIcon('anger'), () => moodIcon('envy'), () => moodIcon('sorrow'), () => moodIcon('fear')];
    for (const draw of all) {
      const buf = await draw();
      assert.ok(buf.length < 256 * 1024, 'under Discord’s emoji limit');
      const img = PNG.sync.read(buf);
      assert.equal(img.width, EMOJI_SIZE);
      assert.equal(img.height, EMOJI_SIZE);
      assert.equal(pixel(img, 0, 0).a, 0, 'the corner is transparent');
      const filled = Array.from({ length: 128 }, (_, i) => pixel(img, i, 64)).filter((p) => p.a > 200).length;
      assert.ok(filled > 20, 'the middle row has something drawn');
    }
    const fass = PNG.sync.read(await fassIcon());
    const vome = PNG.sync.read(await vomeIcon());
    assert.ok(pixel(fass, 30, 64).r > pixel(fass, 30, 64).b, 'Fass is orange');
    assert.ok(pixel(vome, 30, 64).b > pixel(vome, 30, 64).r, 'Vome is blue');
  });

  it('cuts a crescent out of a circle', () => {
    const c = crescent([58, 66], 46, [82, 52], 38);
    const inside = (x: number, y: number) => {
      // Even-odd test against the polygon.
      let hit = false;
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
        const [xi, yi] = c[i]!;
        const [xj, yj] = c[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    assert.ok(inside(24, 80), 'the left of the moon is lit');
    assert.ok(!inside(86, 50), 'the part taken out by the second circle is empty');
  });

  it('mixes colours towards white or black', () => {
    assert.equal(shade('#000000', 0.5), '#808080');
    assert.equal(shade('#ffffff', -0.5), '#808080');
    assert.equal(shade('#3b82f6', 0), '#3b82f6');
  });
});
