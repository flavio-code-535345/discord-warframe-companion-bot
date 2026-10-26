import { CLAN_RANKS, type CardReading, type ClanRank } from './roles.js';

/** Turns OCR'd lines of a Warframe profile screen into a CardReading. Pure, so it is tested without any OCR. */

export interface OcrLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface ParsedCard {
  reading: CardReading;
  /** The clan name line, used to find the emblem above it. */
  clanLine: OcrLine | null;
  /** False when the essentials (rank and clan) could not be read, so a better reader should be tried. */
  complete: boolean;
}

const LEGENDARY_BASE = 2_250_000;
const LEGENDARY_STEP = 147_500;

/** Mastery points needed for a rank: 2500 * n^2 up to MR 30, then 147,500 per Legendary rank. */
export const pointsForRank = (mr: number): number => (mr <= 30 ? 2500 * mr * mr : LEGENDARY_BASE + LEGENDARY_STEP * (mr - 30));

/** The rank a point total belongs to. */
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

const HEADER = /accolades|mastery.?rank|marked for death|syndicates|^clan$/i;
const NAME_TAG = /^([A-Za-z0-9_.\-]{3,})\s*#\s*(\d{3,4})\b/;
const CLAN_LINE = /^(.+?)\s*#\s*(\d{2,4})\s*$/;

export function parseCard(lines: OcrLine[]): ParsedCard {
  const rows = lines.map((l) => ({ ...l, text: clean(l.text) })).filter((l) => l.text);

  // Mastery: the points total sits under the rank title, and "NEXT RANK: X IN n" under that.
  const pointsIdx = rows.findIndex((l) => /^[\d][\d ,.]{3,}$/.test(l.text) && parsePoints(l.text) !== null);
  const points = pointsIdx >= 0 ? parsePoints(rows[pointsIdx]!.text) : null;
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
      clanLine = rows[i]!;
      clanName = clean(m[1]!);
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
function distance(a: string, b: string): number {
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

/**
 * Reads the clan roster row ("<emblem> Name ......... Rat King"): the rank title is the last two words of the line and the
 * name is the word before them. Returns null when no line ends in a clan rank title.
 */
export function parseRankRow(lines: OcrLine[]): RankRow | null {
  for (const line of lines) {
    const words = clean(line.text).split(' ').filter(Boolean);
    if (words.length < 2) continue;
    const last2 = words.slice(-2).map((w) => w.replace(/[^A-Za-z]/g, '').toLowerCase()).join('');
    const rank = CLAN_RANKS.find((r) => distance(last2, `rat${r}`) <= (r.length >= 5 ? 1 : 0));
    if (!rank) continue;
    const before = words.slice(0, -2).reverse().find((w) => /^[A-Za-z0-9_.-]{3,}$/.test(w.replace(/^[^A-Za-z0-9_.-]+|[^A-Za-z0-9_.-]+$/g, '')));
    const name = before ? before.replace(/^[^A-Za-z0-9_.-]+|[^A-Za-z0-9_.-]+$/g, '') : null;
    return { rank, name };
  }
  return null;
}
