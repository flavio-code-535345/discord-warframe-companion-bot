import type { AppContext } from '../context.js';
import { webpToPng } from '../imaging/webp.js';
import { UserError } from '../services/clan.js';
import type { OcrLine } from '../ssroles/parse.js';
import { ocr } from '../ssroles/ocr.js';
import { type CardReading, interpretUnknown, parseRivenCard } from './card.js';
import { getRivenAttributes, getRivenWeapons } from './market.js';
import { erasePointer } from './pointer.js';
import { prepareForOcr } from './prepare.js';
import { type GradeReport, attributeNames, gradeResolved } from './service.js';

/**
 * Grades a riven from a screenshot: OCR the picture (enlarged and cleaned first; the unmodified picture is tried too when that finds
 * nothing), find the weapon and the stat lines, and hand them to the same grader as /riven grade. Nothing is stored, and the picture only
 * lives in memory. What was read is always returned with the grade, because the person has to be able to check it.
 */

export type Recognize = (image: Uint8Array) => Promise<OcrLine[]>;

export interface ScanResult {
  reading: CardReading;
  names: Record<string, string>;
  /** Null when too little was read to grade (see `problem`). */
  report: GradeReport | null;
  problem: string | null;
  ms: number;
  /** How many text lines OCR found in the picture it used. */
  lines: number;
}

/** What the bytes really are (from the file header); Discord's content type can be wrong, e.g. a PNG labelled WebP. Null when unknown. */
export function sniffMime(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** A line of OCR text the way the card parser sees it (single spaces, trimmed). */
const tidy = (text: string): string => text.replace(/\s+/g, ' ').trim();

const enough = (r: CardReading): boolean => r.weapon !== null && r.positives.length >= 2;
const richness = (r: CardReading): number => (r.weapon ? 2 : 0) + r.positives.length + (r.negative ? 1 : 0);

export async function scanCard(ctx: AppContext, picture: Uint8Array, pictureMime: string, recognize: Recognize = (b) => ocr.recognize(b)): Promise<ScanResult> {
  const t0 = Date.now();
  // A WebP is turned into a PNG first; everything after that only knows PNG and JPEG.
  let bytes = picture;
  const sniffed = sniffMime(picture);
  let mime = sniffed ?? pictureMime;
  // Shown when a picture can't be opened, so the problem can be told apart (a wrong label, a damaged file, a format nobody reads).
  const what = `file header: ${sniffed ?? 'unknown'}, labelled ${pictureMime || 'nothing'}, ${Math.max(1, Math.round(picture.length / 1024))} KB`;
  const [weapons, attrs] = await Promise.all([getRivenWeapons(), getRivenAttributes()]).catch(() => {
    throw new UserError("I couldn't load the riven weapon and stat lists from warframe.market just now. Try again in a minute.");
  });
  if (!weapons.length || !attrs.length) throw new UserError("I couldn't load the riven weapon and stat lists from warframe.market just now. Try again in a minute.");
  if (mime === 'image/webp') {
    const png = await webpToPng(bytes);
    if (!png) {
      console.error(`[riven] WebP decode failed (${what})`);
      throw new UserError(`I could not open that WebP file (${what}). Try saving it as a PNG or JPG.`);
    }
    bytes = png;
    mime = 'image/png';
  }
  const prepared = prepareForOcr(bytes, mime);
  if (!prepared) {
    console.error(`[riven] could not decode the picture (${what})`);
    throw new UserError(`I can read PNG, JPEG and WebP screenshots, but I couldn't open this one (${what}). Is it damaged or another format?`);
  }

  const variants: OcrLine[][] = [];
  const read = async (image: Uint8Array, scale: number) => {
    try {
      const t = Date.now();
      const lines = await recognize(image);
      console.log(`[riven] OCR ${Date.now() - t} ms, ${lines.length} lines (picture ${prepared.width}x${prepared.height}, from ${Math.round(picture.length / 1024)} KB ${pictureMime})`);
      variants.push(lines);
      return { lines: lines.length, ocrLines: lines, scale, reading: parseRivenCard(lines, attrs, weapons) };
    } catch (err) {
      console.error('[riven] OCR failed:', err instanceof Error ? err.message : err);
      throw new UserError('I could not read that picture (the text reader failed). Try again, or use /riven grade.');
    }
  };
  let best = await read(prepared.png, prepared.scale);
  // (not for a huge picture: reading it unshrunk takes minutes)
  if (!enough(best.reading) && !prepared.shrunk) {
    const original = await read(bytes, 1);
    if (richness(original.reading) > richness(best.reading)) best = original;
  }
  // Something unreadable on a stat line is usually the mouse pointer: paint it out of the picture and read again.
  if (best.reading.weapon && best.reading.unknown.length && !prepared.shrunk) {
    const first = best.reading.unknown[0]!;
    const line = best.ocrLines.find((l) => tidy(l.text) === first);
    const erased = line ? erasePointer(bytes, mime, { x0: line.x0 / best.scale, y0: line.y0 / best.scale, x1: line.x1 / best.scale, y1: line.y1 / best.scale }) : null;
    const again = erased ? prepareForOcr(erased, 'image/png') : null;
    if (again) {
      const fixed = await read(again.png, again.scale);
      if (fixed.reading.unknown.length < best.reading.unknown.length || richness(fixed.reading) > richness(best.reading)) best = fixed;
    }
  }
  // Whatever is still unreadable is interpreted from the value, the sign and what is left of the name, and shown with a "?".
  const reading = interpretUnknown(best.reading, variants.flatMap((v) => v.map((l) => tidy(l.text))), attrs);
  const names = attributeNames(attrs);
  const done = (report: GradeReport | null, problem: string | null): ScanResult => ({ reading, names, report, problem, ms: Date.now() - t0, lines: best.lines });

  if (!reading.weapon) return done(null, "I couldn't find the weapon's name on the card. Crop the picture to the riven card (its name is at the top), unveiled and in focus.");
  if (reading.unknown.length) {
    // A stat line that can't be read means the reading is incomplete, and a missing stat changes the grade: never grade around it.
    const read = [...reading.positives.map((p) => `${names[p.slug] ?? p.slug}${p.value != null ? ` ${p.value}` : ''}`), ...(reading.negative ? [`curse ${names[reading.negative.slug] ?? reading.negative.slug}`] : [])];
    const lines = reading.unknown.map((u) => `"${u}"`).join(', ');
    return done(
      null,
      `I couldn't read ${reading.unknown.length === 1 ? 'one of the stat lines' : 'some of the stat lines'} (${lines}), and a missing stat changes the grade. Move the mouse pointer (or whatever covers the text) away and screenshot again, or type it in with /riven grade: weapon ${reading.weapon.name}, ${read.join(', ')}${read.length ? ' and ' : ''}the stat I couldn't read.`,
    );
  }
  if (reading.positives.length < 2) return done(null, `I only found ${reading.positives.length} bonus stat${reading.positives.length === 1 ? '' : 's'} (a riven has 2 or 3). Crop the picture to the card so every stat line is readable.`);
  try {
    return done(await gradeResolved(ctx, reading.weapon, attrs, reading.positives, reading.negative), null);
  } catch (err) {
    if (err instanceof UserError) return done(null, `${err.message} (That usually means a stat or a sign was misread: use /riven grade to type it in.)`);
    throw err;
  }
}
