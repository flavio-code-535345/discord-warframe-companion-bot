/**
 * The last step before a written answer is sent: every number in it, and the names it uses, must come from the facts the model
 * was given (or from the question). A sentence that adds a number, or two names, that the facts do not contain was made up, so
 * it is removed. When too much of the answer goes, the caller quotes the wiki instead of sending a fluent guess.
 */

const NUMBER = /(?<![\p{L}\d.])\d[\d,]*(?:\.\d+)?/gu;
const normNumber = (s: string): string => s.replace(/,/g, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '').replace(/^0+(?=\d)/, '');

/** Numbers small enough to appear without being a fact ("pick 1 of them", "2 ways"). */
const FREE_NUMBERS = new Set(['0', '1', '2']);

/** Capitalised words that are not claims about the game. */
const FREE_WORDS = new Set(
  (
    'i im ive ill id operator operators ordis tenno warframe warframes discord lotus cephalon clan utc monday tuesday wednesday thursday friday saturday sunday ' +
    'january february march april may june july august september october november december the a an and or if you your yes no note also however for to in on at ' +
    'once then this that these those it its each every both some most first second third next after before when while with from by of as so but not'
  ).split(' '),
);

export const numbersIn = (text: string): Set<string> => new Set([...text.matchAll(NUMBER)].map((m) => normNumber(m[0])));

const wordsIn = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

const known = (word: string, evidence: Set<string>): boolean => {
  const w = word.toLowerCase().replace(/'s$/, '');
  return FREE_WORDS.has(w) || evidence.has(w) || evidence.has(w.replace(/e?s$/, '')) || evidence.has(`${w}s`);
};

/** One sentence or list line of an answer. */
interface Unit {
  text: string;
  line: number;
}

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

function units(answer: string): Unit[] {
  const out: Unit[] = [];
  answer.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    if (BULLET.test(line)) {
      out.push({ text: line, line: i });
      return;
    }
    for (const s of line.split(/(?<=[.!?])\s+(?=[*_("'\p{Lu}\d])/u)) if (s.trim()) out.push({ text: s, line: i });
  });
  return out;
}

/** Why a sentence is not supported, or null when it is. */
export function unsupported(sentence: string, evidence: { numbers: Set<string>; words: Set<string> }): string | null {
  const plain = sentence.replace(BULLET, '').replace(/[*_`~]/g, '');
  const numbers = [...plain.matchAll(NUMBER)].map((m) => normNumber(m[0])).filter((n) => !FREE_NUMBERS.has(n) && !evidence.numbers.has(n));
  if (numbers.length) return `number ${numbers[0]}`;
  // Capitalised words after the first word are names (items, places, enemies); the first word of a sentence is capitalised anyway.
  const names = [...plain.matchAll(/(?<=[^\s(["'])\s+(\p{Lu}[\p{L}']+)/gu)].map((m) => m[1]!).filter((w) => !known(w, evidence.words));
  if (new Set(names.map((n) => n.toLowerCase())).size >= 2) return `names ${names.slice(0, 2).join(', ')}`;
  return null;
}

export interface Grounded {
  text: string;
  /** The sentences that were taken out, and why. */
  removed: { sentence: string; why: string }[];
}

/**
 * The answer without its unsupported sentences, or null when more than `maxLoss` of it (by length) was unsupported, or nothing
 * useful is left. `evidence` is everything the model was shown: the facts and the question.
 */
export function groundAnswer(answer: string, evidence: string, maxLoss = 0.4): Grounded | null {
  const ev = { numbers: numbersIn(evidence), words: wordsIn(evidence) };
  const all = units(answer);
  if (!all.length) return null;
  const removed: Grounded['removed'] = [];
  const keep = all.filter((u) => {
    const why = unsupported(u.text, ev);
    if (why) removed.push({ sentence: u.text.trim(), why });
    return !why;
  });
  const total = all.reduce((n, u) => n + u.text.length, 0);
  const lost = removed.reduce((n, r) => n + r.sentence.length, 0);
  if (!keep.length || lost / total > maxLoss) return null;
  // Rebuild line by line; a line that only introduced a list ("You can get it from:") goes when every item under it went.
  const lines: string[] = [];
  let lastLine = -1;
  for (const u of keep) {
    if (u.line === lastLine) lines[lines.length - 1] += ` ${u.text.trim()}`;
    else lines.push(BULLET.test(u.text) ? u.text.trimEnd() : u.text.trim());
    lastLine = u.line;
  }
  const text = lines.filter((l, i) => !(l.trim().endsWith(':') && !BULLET.test(lines[i + 1] ?? ''))).join('\n').trim();
  return text.length >= 20 ? { text, removed } : null;
}
