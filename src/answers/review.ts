/**
 * The sanity test a written answer passes before it is sent. A small model given the right facts can still answer thinly ("the
 * Icebind has rewards" without naming them), so each answer is checked with cheap rules. A weak answer is written once more
 * (pipeline.ts); one that stays weak is sent anyway, but logged with the reason, and the MCP tool answers_to_review lists those,
 * together with nothing-found answers and the ones staff rated wrong, so they can be fixed in batches instead of one screenshot
 * at a time. (A second model pass as judge was tried: on the CPU it cost 15-20 s per answer and the small model passed its own
 * answers, so it was dropped.)
 */

/** Questions that ask for several things: a list, everything, the rewards, the ways to get something. */
const WANTS_MANY = /\b(all|every|full|list|rewards|ways|options|methods|sources|combinations|types|activities)\b|\bwhat are\b|\bwhich (ones|are)\b/i;
const NO_INFO = /\b(i (do not|don't) have (any )?information|no information (about|on|regarding)|(is|are) not (mentioned|covered)|i (cannot|can't|could not|couldn't) (find|provide|tell))\b/i;

/** Rules that need no model: the reason an answer looks weak, or null. Pure. */
export function quickSanity(question: string, answer: string, factsChars: number): string | null {
  const plain = answer.replace(/[*_`~]/g, '').trim();
  if (NO_INFO.test(plain)) return 'it says it has no information';
  if (plain.length < 90 && factsChars > 1200) return 'it is very short for the facts it had';
  const named = (answer.match(/^\s*(?:[-*•]|\d+[.)])\s+/gm) ?? []).length + (answer.match(/\*\*[^*]+\*\*/g) ?? []).length;
  if (WANTS_MANY.test(question) && named < 2) return 'the question asks for several things but the answer names at most one';
  return null;
}
