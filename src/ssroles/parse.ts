import { CLAN_RANKS, type CardReading, type ClanRank } from './roles.js';

/** Turns OCR'd lines of a Warframe profile screen into a CardReading. Pure, so it is tested without any OCR. */

export interface OcrLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
  /** The words of the line with their horizontal extent, when the OCR engine gives them (tests do not). */
  words?: { text: string; x0: number; x1: number; y0?: number; y1?: number }[];
}

export interface ParsedCard {
  reading: CardReading;
  /** The clan name line, used to find the emblem above it. */
  clanLine: OcrLine | null;
  /** False when the essentials (rank and clan) could not be read, so a better reader should be tried. */
  complete: boolean;
}

export const LEGENDARY_BASE = 2_250_000;
export const LEGENDARY_STEP = 147_500;

/** Mastery points needed in total for a rank (Legendary n = 30 + n). */
export const pointsForRank = (mr: number): number => (mr <= 30 ? 2500 * mr * mr : LEGENDARY_BASE + LEGENDARY_STEP * (mr - 30));

/** The rank a point total belongs to: MR n needs 2500 * n^2 points up to MR 30, then 147,500 per Legendary rank. */
export function rankFromPoints(points: number): number {
  if (points >= LEGENDARY_BASE) return 30 + Math.floor((points - LEGENDARY_BASE) / LEGENDARY_STEP);
  return Math.min(30, Math.floor(Math.sqrt(points / 2500)));
}

/** "2 692 721", "2,637,138" and "2692721" are all 2692721. */
export const parsePoints = (s: string): number | null => {
  const digits = s.replace(/[^\d]/g, '');
  return digits.length >= 4 && digits.length <= 9 ? Number(digits) : null;
};

const group = (n: number) => n.toLocaleString('en-US');

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const alpha = (s: string) => s.replace(/[^a-z]/gi, '').length;

/**
 * A line's box without the stray words OCR found far away from the rest ("ph" at the emblem's edge, 700 px left of the clan name): the
 * emblem is looked for above the middle of the line, so a box stretched by junk would look in the wrong place.
 */
function tight(line: OcrLine): OcrLine {
  const words = [...(line.words ?? [])].sort((a, b) => a.x0 - b.x0);
  if (words.length < 2) return line;
  const height = Math.max(8, line.y1 - line.y0);
  const groups: (typeof words)[] = [[words[0]!]];
  for (const w of words.slice(1)) {
    const g = groups[groups.length - 1]!;
    if (w.x0 - g[g.length - 1]!.x1 > height * 2.5) groups.push([w]);
    else g.push(w);
  }
  if (groups.length < 2) return line;
  const span = (g: typeof words) => g[g.length - 1]!.x1 - g[0]!.x0;
  const main = groups.reduce((a, b) => (span(b) > span(a) ? b : a));
  const ys0 = main.flatMap((w) => (w.y0 === undefined ? [] : [w.y0]));
  const ys1 = main.flatMap((w) => (w.y1 === undefined ? [] : [w.y1]));
  return { ...line, x0: main[0]!.x0, x1: main[main.length - 1]!.x1, ...(ys0.length && ys1.length ? { y0: Math.min(...ys0), y1: Math.max(...ys1) } : {}) };
}

/** Leading junk OCR makes of the emblem's edge ("ph The Rats Den 69"): one or two lowercase letters or symbols in front of the name. */
const withoutJunk = (name: string): string => {
  const words = name.split(' ');
  while (words.length > 1 && /^([^A-Za-z0-9]+|[a-z]{1,2})$/.test(words[0]!)) words.shift();
  return words.join(' ');
};

const HEADER =/accolades|mastery.?rank|marked for death|syndicates|^clan$/i;
const NAME_TAG = /^([A-Za-z0-9_.\-]{3,})\s*#\s*(\d{3,4})\b/;
const CLAN_LINE = /^(.+?)\s*#\s*(\d{2,4})\s*$/;

export function parseCard(lines: OcrLine[]): ParsedCard {
  const rows = lines.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);

  // Mastery: the points total sits under the rank title, and "NEXT RANK: X IN n" under that.
  // A few stray characters in front of the number are the card's artwork ("Nd 2,637,138"), not part of it.
  const POINTS_LINE = /^[^\d]{0,4}(\d[\d ,.]{3,})$/;
  const pointsIdx = rows.findIndex((l) => POINTS_LINE.test(l.text) && parsePoints(POINTS_LINE.exec(l.text)![1]!) !== null);
  const points = pointsIdx >= 0 ? parsePoints(POINTS_LINE.exec(rows[pointsIdx]!.text)![1]!) : null;
  const nextMatch = rows.map((l) => /next rank\W*(.+?)\s+in\s+([\d ,.]+)/i.exec(l.text)).find(Boolean) ?? null;
  const titleLine = rows.find((l) => /legendary\s*\d+/i.test(l.text) && !/next rank/i.test(l.text)) ?? (pointsIdx > 0 ? rows[pointsIdx - 1]! : null);
  const legendary = titleLine ? /legendary\s*(\d+)/i.exec(titleLine.text) : null;

  // The rank title is trusted only when the point total agrees with it; otherwise the reading is incomplete.
  let rank: number | null = null;
  if (points !== null) {
    const byPoints = rankFromPoints(points);
    rank = legendary ? (30 + Number(legendary[1]) === byPoints ? byPoints : null) : byPoints;
  }
  const title = rank === null ? null : rank > 30 ? `Legendary ${rank - 30}` : titleLine && !legendary && alpha(titleLine.text) >= 4 ? titleLine.text : `Rank ${rank}`;

  // Clan: a "Name#043" line directly above a "... CLAN RANK n" line. (The player's own Name#123 is at the top.)
  let clanLine: OcrLine | null = null;
  let clanName: string | null = null;
  let clanTag: string | null = null;
  let tier: string | null = null;
  for (let i = 0; i < rows.length - 1; i++) {
    const m = CLAN_LINE.exec(rows[i]!.text);
    if (m && /clan\s*rank|\bclan\b/i.test(rows[i + 1]!.text)) {
      clanLine = tight(rows[i]!);
      clanName = withoutJunk(clean(m[1]!));
      clanTag = m[2]!;
      tier = rows[i + 1]!.text;
      break;
    }
  }

  const ign = rows.map((l) => NAME_TAG.exec(l.text)).find((m) => m && (!clanLine || !clanLine.text.startsWith(m[0]))) ?? null;

  // Accolades: the mixed-case titles between the ACCOLADES and MASTERY RANK headers (the all-caps line is a category).
  const accIdx = rows.findIndex((l) => /accolades/i.test(l.text));
  const masIdx = rows.findIndex((l, i) => i > accIdx && /mastery.?rank/i.test(l.text));
  const accolades =
    accIdx >= 0 && masIdx > accIdx
      ? rows
          .slice(accIdx + 1, masIdx)
          .filter((l) => l.confidence >= 80 && alpha(l.text) >= 4 && !HEADER.test(l.text) && l.text !== l.text.toUpperCase() && /^[A-Za-z0-9 '’:&\-]+$/.test(l.text))
          .map((l) => l.text)
      : [];

  const isCard = rows.some((l) => /mastery.?rank/i.test(l.text)) || nextMatch !== null || (points !== null && clanLine !== null);
  const reading: CardReading = {
    is_profile_card: isCard,
    in_game_name: ign ? `${ign[1]}#${ign[2]}` : null,
    mastery_rank_title: title,
    mastery_rank_number: rank,
    mastery_points: points !== null ? group(points) : null,
    next_rank: nextMatch ? clean(nextMatch[1]!) : null,
    points_to_next_rank: nextMatch ? (parsePoints(nextMatch[2]!) !== null ? group(parsePoints(nextMatch[2]!)!) : null) : null,
    clan_name: clanName,
    clan_tag: clanTag,
    clan_tier_rank: tier,
    accolades,
    emblem_matches_reference: null,
    clan_text_matches_reference: null,
    looks_edited_or_fake: false,
    notes: 'read by OCR',
  };
  return { reading, clanLine, complete: isCard && rank !== null && clanName !== null };
}

export interface RankRow {
  rank: ClanRank;
  /** The in-game name next to the rank, without a #tag (the roster doesn't show it). */
  name: string | null;
}

/** Edit distance, enough to forgive one wrong letter in an OCR'd "Rat Sqvire". */
export function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}

const NAME_WORD = /^[A-Za-z0-9_.-]{3,}$/;
const trimWord = (w: string) => w.replace(/^[^A-Za-z0-9_.-]+|[^A-Za-z0-9_.-]+$/g, '');
const letters = (w: string) => w.replace(/[^A-Za-z]/g, '').toLowerCase();
const rankOf = (text: string): ClanRank | undefined => CLAN_RANKS.find((r) => distance(text, `rat${r}`) <= (r.length >= 5 ? 1 : 0));

/** Lines that sit on the same row of the picture ("Name" on the left, "Rat King" on the right) joined left to right. */
function sameRowText(lines: OcrLine[]): string[] {
  const sorted = [...lines].sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const groups: OcrLine[][] = [];
  for (const line of sorted) {
    const group = groups.find((g) => {
      const top = Math.max(line.y0, ...g.map((l) => l.y0));
      const bottom = Math.min(line.y1, ...g.map((l) => l.y1));
      const height = Math.min(line.y1 - line.y0, ...g.map((l) => l.y1 - l.y0));
      return bottom - top > 0.4 * height;
    });
    if (group) group.push(line);
    else groups.push([line]);
  }
  return groups.filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.x0 - b.x0).map((l) => clean(l.text)).join(' '));
}

/**
 * Reads clan roster rows ("<emblem> Name ......... Rat King"): a clan rank title anywhere in a line (or in lines that share
 * a row of the picture) and the nearest name-like word before it. A screenshot of the whole list gives several rows.
 */
export function parseRankRows(lines: OcrLine[]): RankRow[] {
  const found: RankRow[] = [];
  for (const text of [...sameRowText(lines), ...lines.map((l) => clean(l.text))]) {
    const words = text.split(' ').filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const rank = rankOf(letters(words[i]! + (words[i + 1] ?? ''))) ?? rankOf(letters(words[i]!));
      if (!rank || letters(words[i]!).length < 3) continue;
      const name = words.slice(0, i).reverse().map(trimWord).find((w) => NAME_WORD.test(w)) ?? null;
      if (!found.some((f) => f.rank === rank && f.name === name)) found.push({ rank, name });
      break;
    }
  }
  // A bare rank title is only worth keeping when no row of the same rank came with a name.
  return found.filter((r) => r.name !== null || !found.some((o) => o.rank === r.rank && o.name !== null));
}

/** The first roster row on a picture, or null when none shows a clan rank title. */
export const parseRankRow = (lines: OcrLine[]): RankRow | null => parseRankRows(lines)[0] ?? null;

/** "Rat Squire", "rat knight" or just "Knight" as a clan rank, or null. */
export function rankFromTitle(title: string): ClanRank | null {
  const t = letters(title);
  return CLAN_RANKS.find((r) => t === r || t === `rat${r}`) ?? null;
}
