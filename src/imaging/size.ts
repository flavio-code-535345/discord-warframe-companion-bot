import { UserError } from '../services/clan.js';

/**
 * How big a member's picture claims to be, read from its header before anything is decoded. A PNG or WebP of a few kilobytes can declare
 * tens of thousands of pixels per side, and decoding it needs about four bytes for every one of them (a 6000x6000 PNG of 43 KB cost
 * 330 MB), so a screenshot is refused up front instead of letting one message exhaust the bot's memory.
 */

/** Most pixels a picture may declare. A 4K screenshot is 8.3 million, an ultra-wide 5K one 14.7 million. */
export const MAX_PIXELS = 40_000_000;

export interface Size {
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const le32 = (b: Uint8Array, i: number): number => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const tag = (b: Uint8Array, i: number): string => String.fromCharCode(b[i]!, b[i + 1]!, b[i + 2]!, b[i + 3]!);

/** The size a PNG, JPEG or WebP header declares; null for anything else or a header that is cut short. Decodes nothing. */
export function declaredSize(b: Uint8Array): Size | null {
  // PNG: the 8-byte signature, then the IHDR chunk (length, "IHDR", width, height).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: be32(b, 16), height: be32(b, 20) };

  // JPEG: walk the segments up to the first start-of-frame marker.
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 <= b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++; // fill byte
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2; // markers that carry no length
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: be16(b, i + 5), width: be16(b, i + 7) };
      i += 2 + be16(b, i + 2);
    }
    return null;
  }

  // WebP: "RIFF", the size, "WEBP", then the first chunk says which flavour it is.
  if (b.length >= 30 && tag(b, 0) === 'RIFF' && tag(b, 8) === 'WEBP') {
    const chunk = tag(b, 12);
    if (chunk === 'VP8X') return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
    if (chunk === 'VP8L') {
      const bits = le32(b, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ') return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  return null;
}

/** False when the header declares more pixels than a screenshot can have. Unknown formats pass: their decoders have limits of their own. */
export function fitsPixelBudget(b: Uint8Array): boolean {
  const size = declaredSize(b);
  return !size || size.width * size.height <= MAX_PIXELS;
}

/** Throws a message for the member when the picture is far larger than any screenshot. */
export function assertPictureSize(b: Uint8Array): void {
  const size = declaredSize(b);
  if (size && size.width * size.height > MAX_PIXELS) {
    throw new UserError(`That picture claims to be ${size.width.toLocaleString('en-US')}x${size.height.toLocaleString('en-US')} pixels, far larger than a screenshot. Post a normal screenshot of the game.`);
  }
}
