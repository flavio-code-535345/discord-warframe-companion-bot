import type { AppContext } from '../context.js';
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

export async function scanCard(ctx: AppContext, bytes: Uint8Array, mime: string, recognize: Recognize = (b) => ocr.recognize(b)): Promise<ScanResult> {
  const t0 = Date.now();
  const [weapons, attrs] = await Promise.all([getRivenWeapons(), getRivenAttributes()]).catch(() => {
    throw new UserError("I couldn't load the riven weapon and stat lists from warframe.market just now. Try again in a minute.");
  });
  if (!weapons.length || !attrs.length) throw new UserError("I couldn't load the riven weapon and stat lists from warframe.market just now. Try again in a minute.");
  const prepared = prepareForOcr(bytes, mime);
  if (!prepared) throw new UserError('I can read PNG and JPEG screenshots (not other formats, or damaged files).');

  const read = async (image: Uint8Array) => {
    try {
      const lines = await recognize(image);
      return { lines: lines.length, reading: parseRivenCard(lines, attrs, weapons) };
    } catch (err) {
      console.error('[riven] OCR failed:', err instanceof Error ? err.message : err);
      throw new UserError('I could not read that picture (the text reader failed). Try again, or use /riven grade.');
    }
  };
  let best = await read(prepared.png);
  if (!enough(best.reading)) {
    const original = await read(bytes);
    if (richness(original.reading) > richness(best.reading)) best = original;
  }
  const { reading } = best;
  const names = attributeNames(attrs);
  const done = (report: GradeReport | null, problem: string | null): ScanResult => ({ reading, names, report, problem, ms: Date.now() - t0, lines: best.lines });

  if (!reading.weapon) return done(null, "I couldn't find the weapon's name on the card. Crop the picture to the riven card (its name is at the top), unveiled and in focus.");
  if (reading.positives.length < 2) return done(null, `I only found ${reading.positives.length} bonus stat${reading.positives.length === 1 ? '' : 's'} (a riven has 2 or 3). Crop the picture to the card so every stat line is readable.`);
  try {
    return done(await gradeResolved(ctx, reading.weapon, attrs, reading.positives, reading.negative), null);
  } catch (err) {
    if (err instanceof UserError) return done(null, `${err.message} (That usually means a stat or a sign was misread: use /riven grade to type it in.)`);
    throw err;
  }
}
