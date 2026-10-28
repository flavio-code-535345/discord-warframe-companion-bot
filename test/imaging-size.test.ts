import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { normalizeImage } from '../src/imaging/sniff.js';
import { MAX_PIXELS, assertPictureSize, declaredSize, fitsPixelBudget } from '../src/imaging/size.js';
import { decodeWebp } from '../src/imaging/webp.js';
import { UserError } from '../src/services/clan.js';
import { decodeImage } from '../src/ssroles/emblem.js';

const be32 = (n: number) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const be16 = (n: number) => Buffer.from([(n >>> 8) & 0xff, n & 0xff]);
const le24 = (n: number) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff]);

/** Only the header of a PNG: enough for it to declare any size, which is exactly what a decompression bomb does. */
const pngHeader = (w: number, h: number) =>
  new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), be32(w), be32(h), Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0])]));

/** SOI, an APP0 segment and a baseline start-of-frame that declares the size. */
const jpegHeader = (w: number, h: number) =>
  new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]), be16(h), be16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])]));

const riff = (chunk: string, payload: Buffer) => new Uint8Array(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), payload, Buffer.alloc(8)]));
const webpX = (w: number, h: number) => riff('VP8X', Buffer.concat([Buffer.alloc(4), le24(w - 1), le24(h - 1)]));
const webpL = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff('VP8L', Buffer.concat([Buffer.from([0x2f]), Buffer.from([bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff])]));
};
const webpLossy = (w: number, h: number) => riff('VP8 ', Buffer.concat([Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), Buffer.from([w & 0xff, w >>> 8, h & 0xff, h >>> 8])]));

describe('picture size from the header', () => {
  it('reads the size of a PNG, a JPEG and the three kinds of WebP without decoding anything', () => {
    const real = new PNG({ width: 3, height: 2 });
    assert.deepEqual(declaredSize(new Uint8Array(PNG.sync.write(real))), { width: 3, height: 2 });
    assert.deepEqual(declaredSize(pngHeader(1920, 1080)), { width: 1920, height: 1080 });
    assert.deepEqual(declaredSize(jpegHeader(2560, 1440)), { width: 2560, height: 1440 });
    assert.deepEqual(declaredSize(webpX(3840, 2160)), { width: 3840, height: 2160 });
    assert.deepEqual(declaredSize(webpL(1000, 500)), { width: 1000, height: 500 });
    assert.deepEqual(declaredSize(webpLossy(800, 600)), { width: 800, height: 600 });
  });

  it('knows nothing about other data or a header that is cut short', () => {
    assert.equal(declaredSize(new Uint8Array([1, 2, 3, 4, 5])), null);
    assert.equal(declaredSize(pngHeader(10, 10).slice(0, 18)), null);
    assert.equal(declaredSize(jpegHeader(10, 10).slice(0, 12)), null);
    assert.equal(declaredSize(new Uint8Array(0)), null);
  });

  it('lets screenshots through and refuses a picture that claims to be gigapixels large', () => {
    assert.ok(fitsPixelBudget(pngHeader(3840, 2160)));
    assert.ok(fitsPixelBudget(new Uint8Array([1, 2, 3])), 'unknown formats are left to their decoders');
    assert.ok(3840 * 2160 < MAX_PIXELS);
    for (const bomb of [pngHeader(60_000, 60_000), jpegHeader(60_000, 60_000), webpX(16_384, 16_384), webpL(16_384, 16_384)]) {
      assert.equal(fitsPixelBudget(bomb), false);
      assert.throws(() => assertPictureSize(bomb), (err) => err instanceof UserError && /far larger than a screenshot/.test(err.message));
    }
  });

  it('stops the decoders and the shared entry point before any pixel is allocated', async () => {
    assert.equal(decodeImage(pngHeader(60_000, 60_000), 'image/png'), null);
    assert.equal(decodeImage(jpegHeader(60_000, 60_000), 'image/jpeg'), null);
    assert.equal(await decodeWebp(webpX(16_384, 16_384)), null);
    await assert.rejects(normalizeImage(pngHeader(60_000, 60_000), 'image/png'), UserError);
  });

  it('still decodes an ordinary picture', async () => {
    const png = new PNG({ width: 4, height: 3 });
    png.data.fill(200);
    const bytes = new Uint8Array(PNG.sync.write(png));
    assert.deepEqual(decodeImage(bytes, 'image/png')?.width, 4);
    assert.deepEqual((await normalizeImage(bytes, 'image/png')).mime, 'image/png');
  });
});
