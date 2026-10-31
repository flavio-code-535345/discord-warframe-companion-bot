/** How Ordis reads a message before anything is looked up. Pure: plain arithmetic, a question, or chatter. */

const lower = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** A plain sum ("what is 9 x 2", "2+2") as an expression for calculate(), or null. */
export function mathExpression(question: string): string | null {
  const q = lower(question).replace(/[?!=]+$/, '').trim();
  const m = /^(?:(?:what(?:'s| is)|whats|calculate|calc|compute|how much is|solve)\s+)?([\d\s+\-*/x×÷^().,%]+)$/.exec(q);
  if (!m) return null;
  const expr = m[1]!.replace(/(?<=\d),(?=\d{3}\b)/g, '').trim();
  return /\d\s*[+\-*/x×÷^%]\s*[\d(.]/.test(expr) ? expr : null;
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
