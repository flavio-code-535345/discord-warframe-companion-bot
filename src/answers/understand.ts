/**
 * How Ordis reads a question before anything is looked up. Pure, no model: a small model mixes up "how do I get X" with "what
 * is X", and the two need different parts of a wiki page, so the code decides what kind of answer is wanted, and whether the
 * message is plain arithmetic, small talk, or a request to search the web.
 */

/** What kind of answer a question wants; it decides which wiki sections and data are gathered and how the answer is written. */
export type Ask = 'farm' | 'acquire' | 'when' | 'explain' | 'howto' | 'compare' | 'general';

const lower = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();

export function classifyAsk(question: string): Ask {
  const q = lower(question);
  if (/\b(vs\.?|versus|better than|which is better|compared? (to|with))\b/.test(q)) return 'compare';
  if (/\b(best|fastest|quickest|easiest|efficient|optimal|good)\b[^?]*\b(farm|farming|grind|grinding|place to (get|farm)|way to (get|farm|earn|gain))\b|\bfarm(ing)? (spot|location|route|method)s?\b|\bwhere (do|can|should) i farm\b/.test(q)) return 'farm';
  if (/^(when|what time)\b|\b(when|how long until|next time|next week)\b[^?]*\b(get|farm|come|return|back|available|reset|rotat\w*)\b/.test(q)) return 'when';
  if (/\b(how|where|what)\b[^?]*\b(get|obtain|acquire|unlock|earn|gain|buy|find|craft|build|farm|gather|access)\b|\b(drops?|dropped)\b|^(get|obtain|unlock|farm)\b/.test(q)) return 'acquire';
  if (/^(what|who)('s|s| is| are| was| were| does| do)\b|\bexplain\b|\bwhat does\b|\bhow does\b|\bhow do [^?]* work\b|\bmeaning of\b|\bwhat('s| is) the (point|use|purpose)\b/.test(q)) return 'explain';
  if (/^(how|can) (do|can|should|to|would)?\s*(i|you|we|one)?\b|^how to\b/.test(q)) return 'howto';
  return 'general';
}

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

/** "check reddit", "research online", "search the web": the member wants web results, not only the wiki. */
export function wantsResearch(text: string): boolean {
  return /\b(check|search|look (it |that )?up|research|google|browse)\b[^?]*\b(reddit|online|web|internet|youtube|forums?|overframe)\b|\b(on|from|check) reddit\b|\bresearch online\b/i.test(text);
}
