import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import * as PImage from 'pureimage';

/**
 * Text for generated pictures. pureimage (pure JavaScript, no native canvas) reads TTF files only, and the Roboto files in the npm package
 * `@fontsource/roboto` are WOFF (a TTF with each table compressed), so they are converted once and written to the temp directory.
 */

/** WOFF 1.0 to a plain sfnt (TTF/OTF) file. */
export function woffToSfnt(woff: Uint8Array): Buffer {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (view.getUint32(0) !== 0x774f4646) throw new Error('not a WOFF file');
  const flavor = view.getUint32(4);
  const count = view.getUint16(12);
  const tables = Array.from({ length: count }, (_, i) => {
    const at = 44 + i * 20;
    return { tag: view.getUint32(at), offset: view.getUint32(at + 4), compressed: view.getUint32(at + 8), length: view.getUint32(at + 12), checksum: view.getUint32(at + 16) };
  });
  const dirSize = 12 + count * 16;
  let size = dirSize;
  const datas = tables.map((t) => {
    const raw = Buffer.from(woff.subarray(t.offset, t.offset + t.compressed));
    const data = t.compressed < t.length ? inflateSync(raw) : raw;
    size += Math.ceil(data.length / 4) * 4;
    return data;
  });
  const out = Buffer.alloc(size);
  let entrySelector = 0;
  while (2 ** (entrySelector + 1) <= count) entrySelector++;
  const searchRange = 2 ** entrySelector * 16;
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(count, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(count * 16 - searchRange, 10);
  let offset = dirSize;
  tables.forEach((t, i) => {
    const at = 12 + i * 16;
    out.writeUInt32BE(t.tag, at);
    out.writeUInt32BE(t.checksum, at + 4);
    out.writeUInt32BE(offset, at + 8);
    out.writeUInt32BE(t.length, at + 12);
    datas[i]!.copy(out, offset);
    offset += Math.ceil(datas[i]!.length / 4) * 4;
  });
  return out;
}

export const FONT = 'OrdisSans';
export const FONT_BOLD = 'OrdisSansBold';
let ready = false;

/** Registers Roboto regular as `FONT` and bold as `FONT_BOLD` (separate families: the weight matching of the drawing library is unreliable). Safe to call many times. */
export function loadFonts(): void {
  if (ready) return;
  const require = createRequire(import.meta.url);
  const dir = join(tmpdir(), 'ordis-fonts');
  mkdirSync(dir, { recursive: true });
  for (const [family, file] of [[FONT, 'roboto-latin-400-normal'], [FONT_BOLD, 'roboto-latin-700-normal']] as const) {
    const target = join(dir, `${file}.ttf`);
    writeFileSync(target, woffToSfnt(readFileSync(require.resolve(`@fontsource/roboto/files/${file}.woff`))));
    PImage.registerFont(target, family).loadSync();
  }
  ready = true;
}
