import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Pixels, MATCH_THRESHOLD, findEmblem, fingerprint, similarity } from '../src/ssroles/emblem.js';
import { type OcrLine, parseCard, parsePoints, pointsForRank, rankFromPoints } from '../src/ssroles/parse.js';

const line = (text: string, y0: number, confidence = 95, x0 = 100, x1 = 500): OcrLine => ({ text, x0, y0, x1, y1: y0 + 20, confidence });

// What Tesseract actually returned for a real card (headers come out garbled; the useful lines are clean).
const CARD: OcrLine[] = [
  line('ema ACCOLADES em ————', 13, 30),
  line('HEIRLOOM', 166, 96),
  line('Ten Year Supporter', 191, 96),
  line('EE I S|MASTERY/RANK@', 279, 0),
  line('LEGENDARY 3', 436, 96),
  line('2692721', 479, 95),
  line('NEXT RANK: LEGENDARY 4 IN 147 279', 522, 95),
  line('EE = CAN me', 586, 31),
  line('The Rats Den 69#043', 741, 92, 217, 482),
  line('GHOST CLAN RANK 10', 776, 95),
  line('— em MARKED FORDEATHBY wm', 839, 33),
  line('STALKER', 965, 96),
];

test('rank follows the mastery point curve, Legendary ranks every 147,500', () => {
  assert.equal(pointsForRank(28), 1_960_000);
  assert.equal(rankFromPoints(1_960_000), 28);
  assert.equal(rankFromPoints(1_959_999), 27);
  assert.equal(rankFromPoints(2_250_000), 30);
  assert.equal(rankFromPoints(2_692_721), 33);
  assert.equal(rankFromPoints(2_637_138), 32);
  assert.equal(parsePoints('2 692 721'), 2692721);
  assert.equal(parsePoints('2,637,138'), 2637138);
});

test('parses a real OCR result into a card reading', () => {
  const p = parseCard(CARD);
  assert.equal(p.complete, true);
  assert.equal(p.reading.mastery_rank_title, 'Legendary 3');
  assert.equal(p.reading.mastery_rank_number, 33);
  assert.equal(p.reading.mastery_points, '2,692,721');
  assert.equal(p.reading.next_rank, 'LEGENDARY 4');
  assert.equal(p.reading.points_to_next_rank, '147,279');
  assert.equal(p.reading.clan_name, 'The Rats Den 69');
  assert.equal(p.reading.clan_tag, '043');
  assert.equal(p.reading.clan_tier_rank, 'GHOST CLAN RANK 10');
  assert.deepEqual(p.reading.accolades, ['Ten Year Supporter']);
  assert.equal(p.clanLine?.text, 'The Rats Den 69#043');
});

test('the player name at the top is not mistaken for the clan', () => {
  const p = parseCard([line('Flavio11113#108', 5), ...CARD]);
  assert.equal(p.reading.in_game_name, 'Flavio11113#108');
  assert.equal(p.reading.clan_name, 'The Rats Den 69');
});

test('a title that disagrees with the points is treated as unreadable, so the fallback reader gets a go', () => {
  const p = parseCard(CARD.map((l) => (l.text === 'LEGENDARY 3' ? { ...l, text: 'LEGENDARY 7' } : l)));
  assert.equal(p.complete, false);
});

test('an unrelated screenshot is not a complete card', () => {
  assert.equal(parseCard([line('Hello world this is a meme', 10), line('lol', 50)]).complete, false);
});

/** A dark panel with a patterned square emblem drawn at the given centre and size. */
function panel(size: number, seed: number): { img: Pixels; name: OcrLine } {
  const width = 400;
  const height = 400;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([18, 28, 38, 255], i * 4);
  const left = 200 - Math.round(size / 2);
  const top = 100;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x / size) * 8);
      const gy = Math.floor((y / size) * 8);
      const v = ((gx * 7 + gy * 13 + seed * (gx ^ gy)) * 37) % 200;
      data.set([55 + v, 60 + (v * 2) % 150, 80 + (v * 3) % 120, 255], ((top + y) * width + left + x) * 4);
    }
  }
  return { img: { width, height, data }, name: { text: 'x', x0: 120, x1: 280, y0: top + size + 12, y1: top + size + 12 + Math.round(size / 4), confidence: 90 } };
}

test('the emblem is found above the name and compares equal at another size, different from another picture', () => {
  const big = panel(96, 3);
  const small = panel(58, 3);
  const other = panel(96, 11);
  const box = findEmblem(big.img, big.name)!;
  assert.ok(box && box.x1 - box.x0 >= 90 && box.x1 - box.x0 <= 100);
  const fp = fingerprint(big.img, box);
  assert.ok(similarity(fp, fingerprint(small.img, findEmblem(small.img, small.name)!)) >= MATCH_THRESHOLD);
  assert.ok(similarity(fp, fingerprint(other.img, findEmblem(other.img, other.name)!)) < MATCH_THRESHOLD);
});
