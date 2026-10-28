import { assertPictureSize } from './size.js';
import { webpToPng } from './webp.js';

/**
 * Discord's content type for an attachment can be wrong (a pasted PNG arrives labelled image/webp), so the file header decides what a
 * picture really is. Every reader of member screenshots (rivens, profile cards, reference pictures) goes through this first, which is
 * also where a picture that declares an absurd size is refused (see size.ts).
 */

/** What the bytes really are (from the file header); null when unknown. */
export function sniffMime(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * The picture with its real type; a genuine WebP is turned into a PNG, because OCR and the emblem reader only know PNG and JPEG (when it
 * can't be converted it is returned as it is, and the vision models, which accept WebP, get it).
 */
export async function normalizeImage(bytes: Uint8Array, labelled: string): Promise<{ bytes: Uint8Array; mime: string }> {
  assertPictureSize(bytes);
  const mime = sniffMime(bytes) ?? labelled;
  if (mime === 'image/webp') {
    const png = await webpToPng(bytes).catch(() => null);
    if (png) return { bytes: png, mime: 'image/png' };
  }
  return { bytes, mime };
}
