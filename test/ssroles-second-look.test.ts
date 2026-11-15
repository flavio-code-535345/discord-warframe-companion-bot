import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { PNG } from 'pngjs';
import { decodeImage, enlargeTo, type Pixels } from '../src/ssroles/emblem.js';
import { ocr } from '../src/ssroles/ocr.js';
import type { OcrLine } from '../src/ssroles/parse.js';
import { readWithOcr } from '../src/ssroles/service.js';

const line = (text: string, y0: number, confidence = 95, x0 = 100, x1 = 500): OcrLine => ({ text, x0, y0, x1, y1: y0 + 20, confidence });
const CARD: OcrLine[] = [
  line('HEIRLOOM', 166),
  line('Ten Year Supporter', 191),
  line('MASTERY RANK', 279),
  line('LEGENDARY 3', 436),
  line('2692721', 479),
  line('NEXT RANK: LEGENDARY 4 IN 147 279', 522),
  line('The Rats Den 69#043', 741, 92, 217, 482),
  line('GHOST CLAN RANK 10', 776),
];
const small = (() => {
  const p = new PNG({ width: 100, height: 80 });
  p.data.fill(255);
  return PNG.sync.write(p);
})();

afterEach(() => mock.restoreAll());

test('enlarges a small picture to about 1200 px and leaves a big one alone', () => {
  const img: Pixels = { width: 100, height: 50, data: new Uint8Array(100 * 50 * 4).fill(200) };
  const big = enlargeTo(img)!;
  assert.equal(big.scale, 12);
  const back = decodeImage(big.png, 'image/png')!;
  assert.deepEqual([back.width, back.height], [1200, 600]);
  assert.equal(enlargeTo({ width: 1200, height: 700, data: new Uint8Array(1200 * 700 * 4) }), null);
});

test('reads a small card a second time, enlarged, when the first reading is incomplete', async () => {
  const sizes: number[] = [];
  mock.method(ocr, 'recognize', async (bytes: Uint8Array) => {
    sizes.push(decodeImage(bytes, 'image/png')!.width);
    return sizes.length === 1 ? [line('The Rats Den 69#043', 60)] : CARD;
  });
  const attempt = await readWithOcr(small, 'image/png', null);
  assert.deepEqual(sizes, [100, 1200]);
  assert.ok(attempt.read, attempt.note);
  assert.equal(attempt.read.reader, 'ocr');
  assert.equal(attempt.read.reading.mastery_rank_title, 'Legendary 3');
});

test('a complete first reading is not read again', async () => {
  let n = 0;
  mock.method(ocr, 'recognize', async () => {
    n++;
    return CARD;
  });
  const attempt = await readWithOcr(small, 'image/png', null);
  assert.equal(n, 1);
  assert.ok(attempt.read);
});
