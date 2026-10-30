import { LEGENDARY_BASE, LEGENDARY_STEP, pointsForRank } from '../ssroles/parse.js';

/**
 * "Show me the full MR and LR bracket", "how many points for MR 25": the mastery rank thresholds are a fixed formula (2,500 x n^2
 * up to MR 30, then 147,500 per Legendary rank; the same one the screenshot roles check profile cards against), so they are
 * computed, not written by a model from a wiki table that a passage cuts off.
 */

const MASTERY = /\b(mr|lr)\s*\d|\b(mr|lr|mastery|legendary)\b/i;
const TABLE = /\b(bracket|brackets|table|list|all|full|every|chart|thresholds?|requirements?|points? (needed|required)|how many (mastery )?points)\b/i;
/** The Legendary ranks listed; the game keeps adding them, each costing the same. */
const LISTED_LEGENDARY = 5;

const fmt = (n: number) => n.toLocaleString('en-US');
const rankName = (mr: number) => (mr <= 30 ? `MR ${mr}` : `LR ${mr - 30}`);

/** One rank asked for ("MR 25", "LR3", "legendary 2"), as a mastery rank number (Legendary n = 30 + n), or null. */
export function askedRank(question: string): number | null {
  const m = /\b(?:(mr|mastery rank|mastery)|(lr|legendary(?: rank)?))\s*(\d{1,2})\b/i.exec(question);
  if (!m) return null;
  const n = Number(m[3]);
  return m[2] ? (n >= 1 && n <= 20 ? 30 + n : null) : n >= 1 && n <= 30 ? n : null;
}

/** The answer, or null when the question is not about the rank thresholds. */
export function masteryAnswer(question: string): string | null {
  // "All mastery rank tests", "mastery rank 14 weapons" are about something else.
  if (!MASTERY.test(question) || /\b(tests?|weapons?|warframes?|unlock|need for|required for)\b/i.test(question)) return null;
  const one = askedRank(question);
  if (one !== null && !TABLE.test(question.replace(/how many (mastery )?points/i, ''))) {
    const prev = one > 1 ? pointsForRank(one - 1) : 0;
    return `**${rankName(one)}** needs **${fmt(pointsForRank(one))}** mastery points in total, Operator (${fmt(pointsForRank(one) - prev)} more than ${one > 1 ? rankName(one - 1) : 'the start'}). You still have to pass its rank-up test.`;
  }
  if (!TABLE.test(question)) return null;
  const rows: string[] = [];
  for (let mr = 1; mr <= 30; mr += 3) rows.push([mr, mr + 1, mr + 2].map((r) => `${rankName(r)} ${fmt(pointsForRank(r))}`).join(' · '));
  const legendary = Array.from({ length: LISTED_LEGENDARY }, (_, i) => `${rankName(31 + i)} ${fmt(pointsForRank(31 + i))}`).join(' · ');
  return [
    'Total mastery points needed for each rank, Operator:',
    ...rows,
    `**Legendary:** ${legendary} …`,
    `-# MR n needs 2,500 × n² points (MR 30 = ${fmt(LEGENDARY_BASE)}); every Legendary rank after that adds ${fmt(LEGENDARY_STEP)}. Each rank also needs its rank-up test.`,
  ].join('\n');
}
