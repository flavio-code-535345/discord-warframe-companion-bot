import type { AppContext } from '../context.js';
import type { AiLogEntry, Correction } from '../db.js';

/**
 * Corrections: staff teach Ordis by answering it. A staff member (an operator, a panel admin or anyone with Manage Server)
 * who replies to one of Ordis's answers with the right answer saves an approved correction at once; any other member's
 * reply is only a suggestion, which staff approve or reject on the admin panel's Corrections page. Staff can also mark
 * logged answers right or wrong there.
 *
 * An approved correction answers the same question (after normalizeQuestion) word for word, before anything else. Pending
 * suggestions are never shown to members.
 */

/** Lower-cased, punctuation-free question, so "How do I unlock Venus?" and "how do i unlock venus" are one question. */
export const normalizeQuestion = (q: string): string => q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const MAX_TEXT = 1500;
const SCAN_LIMIT = 500;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

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

/** Everything that leaves "pending": the logged answer it corrects is marked wrong. */
function applied(ctx: Pick<AppContext, 'config' | 'store'>, c: Correction, by: string): void {
  if (c.logId !== null) ctx.store.rateAiLog(ctx.config.DISCORD_GUILD_ID, c.logId, 'wrong', by);
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
