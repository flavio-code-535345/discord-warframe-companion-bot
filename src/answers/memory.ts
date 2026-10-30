/**
 * Conversation memory: the last few messages between Ordis and one person in one channel, so a follow-up ("and how do I
 * get it?") is answered in context. In memory only (a restart starts everyone fresh) and forgotten after MEMORY_TTL_MS
 * without a new message. How many messages are replayed is the Brain page's "Conversation memory" slider; 0 turns it off.
 *
 * A "message" is one side of the exchange, so 10 messages are the last 5 questions and their 5 answers.
 */

export interface MemoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** A conversation is forgotten after this long without a new message. */
export const MEMORY_TTL_MS = 30 * 60_000;
/** The most that is ever kept per conversation, whatever the slider says (its maximum). */
export const MEMORY_KEEP = 30;
/** One remembered message is cut to this many characters. */
const MESSAGE_CHARS = 1200;
/** Conversations kept at once; the idle-longest are dropped first. */
const MAX_CONVERSATIONS = 500;

interface Convo {
  turns: MemoryTurn[];
  at: number;
  /** The wiki page the last answer was about, so a follow-up's "it" can be looked up without a model guessing. */
  subject?: string | null;
}

const convos = new Map<string, Convo>();

/** One conversation per person per channel (a DM channel is its own). */
export const memoryKey = (channelId: string | null, userId: string): string => `${channelId ?? 'dm'}:${userId}`;

const clip = (s: string): string => (s.length > MESSAGE_CHARS ? `${s.slice(0, MESSAGE_CHARS - 1)}…` : s);

/** The last `limit` messages of this conversation, oldest first (nothing when `limit` is 0 or it has gone quiet). */
export function recall(key: string, limit: number, now = Date.now()): MemoryTurn[] {
  if (limit <= 0) return [];
  const c = convos.get(key);
  if (!c) return [];
  if (now - c.at > MEMORY_TTL_MS) {
    convos.delete(key);
    return [];
  }
  return c.turns.slice(-limit);
}

/** The subject of this conversation's last answer that had one, or null. */
export function recallSubject(key: string, now = Date.now()): string | null {
  const c = convos.get(key);
  return c && now - c.at <= MEMORY_TTL_MS ? (c.subject ?? null) : null;
}

/** Adds one question and its answer, and the page it was about (an answer without one keeps the earlier subject). */
export function remember(key: string, question: string, answer: string, now = Date.now(), subject?: string | null): void {
  const c = convos.get(key);
  const fresh = !c || now - c.at > MEMORY_TTL_MS;
  const turns = fresh ? [] : c.turns;
  turns.push({ role: 'user', content: clip(question) }, { role: 'assistant', content: clip(answer) });
  convos.delete(key);
  convos.set(key, { turns: turns.slice(-MEMORY_KEEP), at: now, subject: subject ?? (fresh ? null : (c.subject ?? null)) });
  // Insertion order is last-touched order, so the front of the map is the idle-longest conversation.
  for (const k of convos.keys()) {
    if (convos.size <= MAX_CONVERSATIONS) break;
    convos.delete(k);
  }
}

/** Forgets one conversation (or all of them). */
export function forget(key?: string): void {
  if (key === undefined) convos.clear();
  else convos.delete(key);
}

export const conversationCount = (): number => convos.size;

/**
 * Whether a message leans on what was said before: it points back with a pronoun or starts with a connector ("and", "what
 * about"), and is short. Such a message cannot be understood or looked up on its own: the facts are looked up for the subject of
 * the conversation (recallSubject) and the model is told what it follows, instead of a lookup or a saved answer for the words alone.
 */
export function isFollowUp(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (!q || q.split(/\s+/).length > 14) return false;
  return /^(and|also|but|then|so|what about|how about|why|why not|what else|how come|ok|okay|thanks|thank you)\b/.test(q) || /\b(it|its|it's|that|this|those|these|they|them|their|he|she|him|her|there|the same|one)\b/.test(q);
}

/** The conversation as text, for the single-shot writers that take one prompt instead of a message list. */
export function transcript(turns: MemoryTurn[]): string {
  return turns.map((t) => `${t.role === 'user' ? 'Member' : 'Ordis'}: ${t.content.replace(/\s+/g, ' ')}`).join('\n');
}
