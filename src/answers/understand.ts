/** How Ordis reads a message before anything is looked up. Pure: plain arithmetic, a question, or chatter. */

import { CALC_CONSTANTS, CALC_FUNCTIONS } from './calc.js';

const lower = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

const FN = CALC_FUNCTIONS.join('|');
const CONST = CALC_CONSTANTS.join('|');
/** Only what a sum is made of: digits, operators, brackets and the calculator's own names (sqrt, max, pi…), after an optional "what is". */
const SUM = new RegExp(`^(?:(?:what(?:'s| is)|whats|calculate|calc|compute|how much is|solve)\\s+)?((?:[\\d\\s+\\-*/x×÷^().,%π√]|\\b(?:${FN}|${CONST})\\b)+)$`);
const CALL = `\\b(?:${FN})\\s*\\(|√`;
const HAS_CALL = new RegExp(CALL);
const CALLS = new RegExp(CALL, 'g');
const CONSTANT = new RegExp(`\\b(?:${CONST})\\b|π`, 'g');

/** A sum ("what is 9 x 2", "2+2", "sqrt(16)", "2 * pi", "15% of 200") as an expression for calculate(), or null. */
export function mathExpression(question: string): string | null {
  const q = lower(question)
    .replace(/[?!=]+$/, '')
    .replace(/\b(?:the )?square root of (\d+(?:\.\d+)?)/g, 'sqrt($1)')
    .replace(/(\d+(?:\.\d+)?) squared\b/g, '$1^2')
    .replace(/(\d+(?:\.\d+)?) cubed\b/g, '$1^3')
    .replace(/(\d+(?:\.\d+)?) ?% of (?=[\d(.])/g, '$1% * ')
    .trim();
  const m = SUM.exec(q);
  if (!m) return null;
  let expr = m[1]!.trim();
  // "1,000" is a thousand, but the comma in "max(1,200)" separates two numbers.
  if (!HAS_CALL.test(expr)) expr = expr.replace(/(?<=\d),(?=\d{3}\b)/g, '');
  // There has to be something to work out: a function call, or an operator between two operands. A constant is an operand ("2 * pi")
  // and a percent sign after a number belongs to it ("15% * 200"), but a number, a name or a few numbers on their own are not a sum
  // ("2026", "what is e", "100 (200)").
  const shape = expr
    .replace(CALLS, 'f(')
    .replace(CONSTANT, '1')
    .replace(/(\d)\s*%(?=\s*(?:[+\-*/x×÷^)]|$))/g, '$1');
  return shape.includes('f(') || /[\d)]\s*[+\-*/x×÷^%]\s*[\d(.]/.test(shape) ? expr : null;
}

const QUESTION_START = /^(what|whats|what's|how|why|when|where|who|which|whose|is|are|was|were|can|could|does|do|did|should|would|will|tell|explain|show|give|list|find|help|any|anyone|best|where's|how's)\b/;

/** Whether a message reads like a question or a request (as opposed to chatter, a reaction or a link). */
export function questionLike(text: string): boolean {
  // A link's query string ("…gif?size=160") is not a question mark.
  const q = lower(withoutLinks(text));
  return q.includes('?') || QUESTION_START.test(q);
}

/** The text without links; a Discord sticker or GIF arrives as "[Garfield Piss](https://media.discordapp.net/…)", name and all. */
const withoutLinks = (text: string): string => text.replace(/\[[^\]]*\]\(https?:\/\/[^)\s]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');

/** Nothing to answer: a link, a mention, emoji or punctuation on their own, or a one-word reaction. */
export function noContent(text: string): boolean {
  const rest = withoutLinks(text)
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return !rest || /^(lol|lmao|lmfao|rofl|haha+|hehe+|xd+|gg|ty|thx|thanks|thank you|ok|okay|k|kk|nice|cool|wow|bruh|f|rip|gn|gm|yes|no|yep|nope|ye|yeah|nah)$/i.test(rest);
}

/** A thank-you on its own ("thanks!", "ty ordis"). */
export const thanks = (text: string): boolean => /^\W*(thanks?|thank you|thx|ty)\b[\s\w]{0,20}\W*$/i.test(text.trim());
