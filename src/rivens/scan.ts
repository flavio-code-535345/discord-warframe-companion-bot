import type { AppContext } from '../context.js';
import { webpToPng } from '../imaging/webp.js';
import { UserError } from '../services/clan.js';
import type { OcrLine } from '../ssroles/parse.js';
import { ocr } from '../ssroles/ocr.js';
import { type CardReading, parseRivenCard } from './card.js';
import { getRivenAttributes, getRivenWeapons } from './market.js';
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

const enough = (r: CardReading): boolean => r.weapon !== null && r.positives.length >= 2;
const richness = (r: CardReading): number => (r.weapon ? 2 : 0) + r.positives.length + (r.negative ? 1 : 0);

export async function scanCard(ctx: AppContext, picture: Uint8Array, pictureMime: string, recognize: Recognize = (b) => ocr.recognize(b)): Promise<ScanResult> {
  const t0 = Date.now();
  // A WebP is turned into a PNG first; everything after that only knows PNG and JPEG.
  let bytes = picture;
  let mime = pictureMime;
  const [weapons, attrs] = await Promise.all([getRivenWeapons(), getRivenAttributes()]).catch(() => {
    throw new UserError("I couldn't load the riven weapon and stat lists from warframe.market just now. Try again in a minute.");
  });
  if (!weapons.length || !attrs.length) throw new UserError("I couldn't load the riven weapon and stat lists from warframe.market just now. Try again in a minute.");
  if (mime === 'image/webp') {
    const png = await webpToPng(bytes);
    if (!png) throw new UserError('I could not open that WebP file (is it damaged?). Try a PNG or JPG.');
    bytes = png;
    mime = 'image/png';
  }
  const prepared = prepareForOcr(bytes, mime);
  if (!prepared) throw new UserError('I can read PNG, JPEG and WebP screenshots (not other formats, or damaged files).');

  const read = async (image: Uint8Array) => {
    try {
      const t = Date.now();
      const lines = await recognize(image);
      console.log(`[riven] OCR ${Date.now() - t} ms, ${lines.length} lines (picture ${prepared.width}x${prepared.height}, from ${Math.round(picture.length / 1024)} KB ${pictureMime})`);
      return { lines: lines.length, reading: parseRivenCard(lines, attrs, weapons) };
    } catch (err) {
      console.error('[riven] OCR failed:', err instanceof Error ? err.message : err);
      throw new UserError('I could not read that picture (the text reader failed). Try again, or use /riven grade.');
    }
  };
  let best = await read(prepared.png);
  // (not for a huge picture: reading it unshrunk takes minutes)
  if (!enough(best.reading) && !prepared.shrunk) {
    const original = await read(bytes);
    if (richness(original.reading) > richness(best.reading)) best = original;
  }
  const { reading } = best;
  const names = attributeNames(attrs);
  const done = (report: GradeReport | null, problem: string | null): ScanResult => ({ reading, names, report, problem, ms: Date.now() - t0, lines: best.lines });

  if (!reading.weapon) return done(null, "I couldn't find the weapon's name on the card. Crop the picture to the riven card (its name is at the top), unveiled and in focus.");
  if (reading.unknown.length) {
    // A stat line that can't be read means the reading is incomplete, and a missing stat changes the grade: never grade around it.
    const read = [...reading.positives.map((p) => `${names[p.slug] ?? p.slug}${p.value != null ? ` ${p.value}` : ''}`), ...(reading.negative ? [`curse ${names[reading.negative.slug] ?? reading.negative.slug}`] : [])];
    const lines = reading.unknown.map((u) => `"${u}"`).join(', ');
    return done(
      null,
      `I couldn't read ${reading.unknown.length === 1 ? 'one of the stat lines' : 'some of the stat lines'} (${lines}), and a missing stat changes the grade, so I won't guess. If the mouse pointer or something else covers the text, move it away and take the screenshot again. Or type it in with /riven grade: weapon ${reading.weapon.name}, ${read.join(', ')}${read.length ? ' and ' : ''}the stat I couldn't read.`,
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
