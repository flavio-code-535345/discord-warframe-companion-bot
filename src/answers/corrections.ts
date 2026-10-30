import type { AppContext } from '../context.js';
import type { AiLogEntry, Correction } from '../db.js';
import { normalizeQuestion } from './cache.js';

/**
 * Corrections: staff teach Ordis by answering it. A staff member (an operator, a panel admin or anyone with Manage Server)
 * who replies to one of Ordis's answers with the right answer saves an approved correction at once; any other member's
 * reply is only a suggestion, which staff approve or reject on the admin panel's Corrections page. Staff can also mark
 * logged answers right or wrong there.
 *
 * What an approved correction does:
 *  - the same question (after normalizeQuestion) is answered with the correction word for word, before any model or saved
 *    answer is tried;
 *  - related questions get the correction (and the answers staff rated) as guidance in the model's prompt, as authoritative
 *    text that overrides its memory and the tools when it applies.
 *
 * Pending suggestions are never shown to the model: only text a staff member wrote or approved reaches a prompt.
 */

const MAX_TEXT = 1500;
const MAX_GUIDANCE_CHARS = 2400;
const SCAN_LIMIT = 500;

const STOP = new Set(
  'the and for are was you your with that this what when where which who how why does did can could would should will get got have has had not but its from into about than then them they their there here out all any some one more most much many very just also too use used using need want like make made take give tell show ask asking please thanks warframe'.split(' '),
);

/** The words of a question that carry its meaning. */
export const keywords = (question: string): Set<string> => new Set(normalizeQuestion(question).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));

/** How closely two questions overlap, 0..1 (shared keywords over the shorter one's); needs two shared words unless a question is that short. */
export function relatedness(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const small = Math.min(a.size, b.size);
  if (shared < Math.min(2, small)) return 0;
  return shared / small;
}

const RELATED_AT = 0.6;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string, n: number): string => clip(s.replace(/\s+/g, ' ').trim(), n);

/** Whether this person may correct Ordis directly. `manageServer` is the Discord permission of the author in that server. */
export function isStaff(ctx: Pick<AppContext, 'config' | 'store'>, userId: string, manageServer: boolean): boolean {
  return manageServer || ctx.config.OPERATOR_IDS.includes(userId) || ctx.config.PANEL_OWNER_IDS.includes(userId) || ctx.store.isPanelAdmin(userId);
}

/** The text of an approved correction for exactly this question, when there is one (the newest wins). */
export function findCorrection(ctx: Pick<AppContext, 'config' | 'store'>, question: string): Correction | null {
  const key = normalizeQuestion(question);
  if (!key) return null;
  return ctx.store.listCorrections(ctx.config.DISCORD_GUILD_ID, 'approved', SCAN_LIMIT).find((c) => c.key === key) ?? null;
}

/** Everything that leaves "pending": drop a saved answer for that question (it may be what was wrong) and mark the logged answer wrong. */
function applied(ctx: Pick<AppContext, 'config' | 'store'>, c: Correction, by: string): void {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  ctx.store.deleteCacheRow(guildId, c.key);
  if (c.logId !== null) ctx.store.rateAiLog(guildId, c.logId, 'wrong', by);
}

export interface NewCorrection {
  /** The logged answer being corrected, when there is one. */
  entry: AiLogEntry | null;
  question?: string;
  text: string;
  authorId: string;
  authorName: string;
  staff: boolean;
  source: Correction['source'];
}

/** Saves a correction (approved at once when staff wrote it, otherwise pending). Returns null when the text is empty. */
export function addCorrection(ctx: Pick<AppContext, 'config' | 'store'>, n: NewCorrection, now = Date.now()): { id: number; status: Correction['status']; duplicate: boolean } | null {
  const text = n.text.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  const question = (n.entry?.question ?? n.question ?? '').trim().slice(0, 500);
  const key = normalizeQuestion(question);
  if (!text || !key) return null;
  const guildId = ctx.config.DISCORD_GUILD_ID;
  // The same person saying the same thing again is not a second suggestion.
  for (const status of ['pending', 'approved'] as const) {
    const same = ctx.store.listCorrections(guildId, status, SCAN_LIMIT).find((c) => c.key === key && c.authorId === n.authorId && c.correction === text);
    if (same) return { id: same.id, status: same.status, duplicate: true };
  }
  const status: Correction['status'] = n.staff ? 'approved' : 'pending';
  const id = ctx.store.addCorrection(guildId, {
    createdAt: now,
    question,
    key,
    badAnswer: n.entry?.answer ? clip(n.entry.answer, 800) : null,
    correction: text,
    askerId: n.entry?.userId ?? null,
    authorId: n.authorId,
    authorName: n.authorName.slice(0, 80),
    status,
    source: n.source,
    logId: n.entry?.id ?? null,
    decidedBy: n.staff ? n.authorId : null,
    decidedAt: n.staff ? now : null,
  });
  if (n.staff) applied(ctx, { id, key, logId: n.entry?.id ?? null } as Correction, n.authorId);
  return { id, status, duplicate: false };
}

/** Approves a suggestion, optionally with staff's edited wording. */
export function approveCorrection(ctx: Pick<AppContext, 'config' | 'store'>, id: number, by: string, text?: string): boolean {
  const c = ctx.store.getCorrection(ctx.config.DISCORD_GUILD_ID, id);
  if (!c) return false;
  const edited = text?.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  ctx.store.updateCorrection(ctx.config.DISCORD_GUILD_ID, id, { status: 'approved', decidedBy: by, ...(edited ? { correction: edited } : {}) });
  applied(ctx, c, by);
  return true;
}

export const rejectCorrection = (ctx: Pick<AppContext, 'config' | 'store'>, id: number, by: string): boolean =>
  ctx.store.updateCorrection(ctx.config.DISCORD_GUILD_ID, id, { status: 'rejected', decidedBy: by });

/** Rewrites the text of a correction. */
export function editCorrection(ctx: Pick<AppContext, 'config' | 'store'>, id: number, text: string): boolean {
  const t = text.replace(/\r\n/g, '\n').trim().slice(0, MAX_TEXT);
  return t ? ctx.store.updateCorrection(ctx.config.DISCORD_GUILD_ID, id, { correction: t }) : false;
}

/** Approved corrections whose question overlaps with this one, most related first: trusted facts for the answer pipeline. */
export function relatedCorrections(ctx: Pick<AppContext, 'config' | 'store'>, question: string, max = 3): Correction[] {
  const words = keywords(question);
  if (!words.size) return [];
  return ctx.store
    .listCorrections(ctx.config.DISCORD_GUILD_ID, 'approved', SCAN_LIMIT)
    .map((c) => ({ c, s: relatedness(words, keywords(c.question)) }))
    .filter((x) => x.s >= RELATED_AT)
    .sort((a, b) => b.s - a.s || b.c.createdAt - a.c.createdAt)
    .slice(0, max)
    .map((x) => x.c);
}

/**
 * The guidance block for a question: approved corrections that overlap with it, plus related answers staff rated wrong (what
 * not to repeat) and right (good examples). Empty when nothing applies. Capped, so it cannot crowd the prompt.
 */
export function guidanceFor(ctx: Pick<AppContext, 'config' | 'store'>, question: string): string {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const words = keywords(question);
  if (!words.size) return '';
  const score = (q: string) => relatedness(words, keywords(q));

  const corrections = ctx.store
    .listCorrections(guildId, 'approved', SCAN_LIMIT)
    .map((c) => ({ c, s: score(c.question) }))
    .filter((x) => x.s >= RELATED_AT)
    .sort((a, b) => b.s - a.s || b.c.createdAt - a.c.createdAt)
    .slice(0, 4)
    .map((x) => x.c);
  // A question that already has a correction is covered by it: its rated answers would only repeat the mistake.
  const corrected = new Set(ctx.store.listCorrections(guildId, 'approved', SCAN_LIMIT).map((c) => c.key));
  const rated = (rating: 'right' | 'wrong', max: number) =>
    ctx.store
      .ratedAiLog(guildId, rating, 60)
      .filter((e) => e.answer && !corrected.has(normalizeQuestion(e.question)))
      .map((e) => ({ e, s: score(e.question) }))
      .filter((x) => x.s >= RELATED_AT)
      .sort((a, b) => b.s - a.s)
      .slice(0, max)
      .map((x) => x.e);
  const wrong = rated('wrong', 2);
  const right = rated('right', 2);
  if (!corrections.length && !wrong.length && !right.length) return '';

  const parts: string[] = [];
  if (corrections.length) {
    parts.push(
      'Staff corrections (written by the clan admins; when one applies to the question, follow it over your memory, the tools and the wiki, and say it in your own words):',
      ...corrections.map((c) => `- Question: ${oneLine(c.question, 160)}\n  Correct answer: ${oneLine(c.correction, 600)}`),
    );
  }
  if (wrong.length) {
    parts.push('Earlier answers that staff marked WRONG (do not repeat their mistakes):', ...wrong.map((e) => `- Question: ${oneLine(e.question, 160)}\n  Wrong answer: ${oneLine(e.answer ?? '', 300)}`));
  }
  if (right.length) {
    parts.push('Earlier answers that staff marked RIGHT (a good example of what is wanted):', ...right.map((e) => `- Question: ${oneLine(e.question, 160)}\n  Good answer: ${oneLine(e.answer ?? '', 300)}`));
  }
  return clip(parts.join('\n'), MAX_GUIDANCE_CHARS);
}
