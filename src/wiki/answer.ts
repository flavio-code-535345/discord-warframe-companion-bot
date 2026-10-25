import { queryTerms } from './terms.js';

/** Extractive answering: picks the sentences of the retrieved passages that actually answer the question. */

export interface Passage {
  title: string;
  url: string;
  extract: string;
}

export interface DirectAnswer {
  text: string;
  source: Passage;
}

// What a question's wording says about the sentence that answers it.
const CUES: { ask: RegExp; sentence: RegExp }[] = [
  { ask: /\b(get|obtain|acquire|farm|find|unlock|earn|buy|craft|build|make)\b|where (can|do|to)|how (do|to|can)/i, sentence: /\b(obtain|acquire|acquired|earn|earned|drop|drops|dropped|reward|rewards|purchase|purchased|bought|found|crafted|craft|blueprint|available|unlocked|sold|complete|completing|from)\b/i },
  { ask: /\bhow (many|much|long|often|far)\b|\bcost|\bprice|\bduration|\bcooldown|\bchance\b|\b(max|maximum|limit)\b/i, sentence: /\d/ },
  { ask: /\bwhen\b|\bhow long\b|\bwhat time\b/i, sentence: /\b(\d+\s*(minutes?|hours?|days?|weeks?|seconds?)|every|daily|weekly|resets?|cycle|rotat\w+)\b/i },
  { ask: /\bwhat (is|are|does)\b|\bwho\b|\bexplain|\bmeaning\b/i, sentence: /\b(is a|is an|is the|are a|are the|refers? to|allows?|used to|used for)\b/i },
  { ask: /\bwhy\b|\bdoes it work\b|\bhow does\b|\bhow do .* work\b/i, sentence: /\b(because|so that|which|when|by|allows?|causes?|increases?|reduces?|grants?)\b/i },
];

const has = (text: string, term: string) => text.includes(term) || (term.length > 3 && term.endsWith('s') && text.includes(term.slice(0, -1)));

/** A sentence that leans on the one before it ("these requirements", "This allows…") makes no sense alone. */
const DEPENDS_ON_PREVIOUS = /^(these|this|those|they|it|its|such|that)\b|\bthese (requirements|conditions|steps)\b/i;

export function sentences(text: string): string[] {
  return text
    .split(/\n+| · |(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 25);
}

/** Up to `maxChars` of the most relevant sentences from the best passages, in reading order. Null when nothing fits. */
export function answerFrom(question: string, passages: Passage[], maxChars = 700): DirectAnswer | null {
  const terms = queryTerms(question);
  if (!terms.length || !passages.length) return null;
  const cues = CUES.filter((c) => c.ask.test(question)).map((c) => c.sentence);

  const top = passages[0]!;
  const titleWords = queryTerms(top.title);
  const scored = (p: Passage, rank: number) =>
    sentences(p.extract).map((s, i) => {
      const low = s.toLowerCase();
      const hits = terms.filter((t) => has(low, t)).length;
      // Words that are only the page's own name say little about which sentence answers the question.
      const specific = terms.filter((t) => !titleWords.includes(t) && has(low, t)).length;
      let score = hits + specific * 1.5 + cues.filter((c) => c.test(s)).length * 1.5 - rank * 1.5 - i * 0.05;
      if (i === 0 && /\b(what|who)\b/i.test(question)) score += 1.5;
      return { s, score, rank, i };
    });

  const pool = [...scored(top, 0), ...(passages[1] ? scored(passages[1], 1) : [])];
  const best = pool.filter((x) => x.score >= 2).sort((a, b) => b.score - a.score);
  if (!best.length) return null;

  const chosen: typeof best = [];
  let length = 0;
  for (const c of best) {
    if (chosen.length >= 3 || length + c.s.length > maxChars) continue;
    if (c.rank !== best[0]!.rank) continue;
    chosen.push(c);
    length += c.s.length + 1;
  }
  if (!chosen.length) chosen.push(best[0]!);
  const rank = best[0]!.rank;
  const all = sentences(passages[rank]!.extract);
  const picked = new Set(chosen.map((c) => c.i));
  for (const i of [...picked]) if (i > 0 && DEPENDS_ON_PREVIOUS.test(all[i]!)) picked.add(i - 1);
  const text = [...picked].sort((a, b) => a - b).map((i) => all[i]!).join(' ');
  return { text, source: passages[rank]! };
}
