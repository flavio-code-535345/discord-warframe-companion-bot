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
function panel(size: number, seed: number, withHeading = false): { img: Pixels; name: OcrLine } {
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
  if (withHeading) {
    // the CLAN heading: some text-like pixels and a full-width rule, a little above the emblem
    for (let x = left; x < left + size; x += 3) for (let y = top - 22; y < top - 8; y++) data.set([230, 230, 230, 255], (y * width + x) * 4);
    for (let x = 0; x < width; x++) data.set([200, 200, 200, 255], ((top - 16) * width + x) * 4);
  }
  return { img: { width, height, data }, name: { text: 'x', x0: 120, x1: 280, y0: top + size + 12, y1: top + size + 12 + Math.round(size / 4), confidence: 90 } };
}

test('a heading and rule just above the emblem do not enlarge it', () => {
  const p = panel(96, 3, true);
  const box = findEmblem(p.img, p.name)!;
  assert.ok(box, 'emblem found');
  assert.ok(Math.abs(box.y0 - 100) <= 2 && Math.abs(box.x1 - box.x0 - 96) <= 3 && Math.abs(box.y1 - box.y0 - 96) <= 3, JSON.stringify(box));
});

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

// A real card (Legendary 2) of a whole screen: OCR put stray characters in front of the points ("Nd 2,637,138") and in front of the clan
// name ("ph The Rats Den 69#043"), which made the card look unreadable and sent it to the vision model (which misread the clan).
test('reads a whole-screen card whose points and clan lines have stray characters in front', () => {
  const lines = [
    line('~ Flavio11113#10858', 48, 39), line("Vay Hek's Nightmare", 95, 75), line('pS SYNDICATES CHALLENGES ~~ WISHLIST', 144, 56),
    line('"3 — ACCOLADES w—m', 207, 58), line('DEN HEIRLOOM', 377, 68), line('| Wily \ Ten Year Supporter', 380, 72),
    line('i — &MASTERYRANK —m', 497, 28), line('RY LEGENDARY 2', 677, 76), line('Nd 2,637,138', 708, 71),
    line('NEXT RANK: LEGENDARY 3 IN 55,362', 751, 83), line('4 CLAN', 835, 65), line('ph The Rats Den 69#043', 1015, 78), line('; GHOST CLAN RANK 10', 1050, 73),
  ];
  const p = parseCard(lines);
  assert.equal(p.complete, true);
  assert.equal(p.reading.clan_name, 'The Rats Den 69');
  assert.equal(p.reading.clan_tag, '043');
  assert.equal(p.reading.mastery_rank_number, 32);
  assert.equal(p.reading.mastery_points, '2,637,138');
  // A real clan whose name merely contains ours is not accepted by dropping words: only short lowercase junk in front is removed.
  assert.equal(parseCard([...lines.slice(0, 11), line('Fake The Rats Den 69#043', 1015, 78), line('; GHOST CLAN RANK 10', 1050, 73)]).reading.clan_name, 'Fake The Rats Den 69');
  // And the "NEXT RANK" line is still not taken for the points.
  assert.equal(parseCard([line('NEXT RANK: LEGENDARY 3 IN 55,362', 10)]).reading.mastery_points, null);
});

test('the clan line box ignores a stray word far to its left, so the emblem is looked for above the name', () => {
  const w = (text: string, x0: number, x1: number, y0 = 1015, y1 = 1041) => ({ text, x0, x1, y0, y1 });
  const clan: OcrLine = {
    text: 'ph The Rats Den 69#043',
    x0: 71, x1: 1134, y0: 1015, y1: 1050, confidence: 78,
    words: [w('ph', 71, 100, 1020, 1050), w('The', 840, 900), w('Rats', 915, 990), w('Den', 1005, 1060), w('69#043', 1075, 1134)],
  };
  const p = parseCard([line('LEGENDARY 2', 677), line('2,637,138', 708), line('NEXT RANK: LEGENDARY 3 IN 55,362', 751), line('CLAN', 835), clan, line('GHOST CLAN RANK 10', 1050)]);
  assert.deepEqual([p.clanLine!.x0, p.clanLine!.x1, p.clanLine!.y0, p.clanLine!.y1], [840, 1134, 1015, 1041]);
  // Without word boxes (or with nothing stray) the line is left as it is.
  const plain = parseCard([line('2,637,138', 708), line('The Rats Den 69#043', 1015, 90, 840, 1134), line('GHOST CLAN RANK 10', 1050)]);
  assert.deepEqual([plain.clanLine!.x0, plain.clanLine!.x1], [840, 1134]);
});
