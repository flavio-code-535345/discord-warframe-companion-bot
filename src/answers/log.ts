import { aiToggle } from '../ai/settings.js';
import type { AppContext } from '../context.js';
import type { AiLogEntry, AiSource } from '../db.js';
import type { SmartAnswer } from './smart.js';

/**
 * AI question log: who asked what, where, and which model (or plain lookup) produced the answer. Kept in the database for
 * 30 days and shown to staff with /ailog. Never throws: logging must not stop an answer from being delivered.
 */

export interface LoggedAsker {
  id: string;
  name: string;
  channelId: string | null;
  via: AiLogEntry['via'];
}

/** Records the answer and returns its log id (null when logging is off or failed). `messageId` is the Discord message that carried it. */
export function logAnswer(ctx: Pick<AppContext, 'store' | 'config'>, who: LoggedAsker, question: string, answer: SmartAnswer, messageId: string | null = null): number | null {
  if (!aiToggle('log')) return null;
  try {
    return ctx.store.addAiLog(ctx.config.DISCORD_GUILD_ID, {
      at: Date.now(),
      userId: who.id,
      userName: who.name.slice(0, 80),
      channelId: who.channelId,
      via: who.via,
      question: question.slice(0, 500),
      intent: answer.intent ?? null,
      source: answer.source ?? 'lookup',
      model: answer.model ?? null,
      found: answer.found,
      ms: answer.ms ?? 0,
      answer: answer.content.slice(0, 1500),
      messageId,
    });
  } catch (err) {
    console.warn('[ailog] could not record the question:', err instanceof Error ? err.message : err);
    return null;
  }
}

const SOURCE_LABEL: Record<AiSource, string> = {
  local: '🏠 local',
  cloud: '☁️ cloud',
  excerpt: '📄 wiki excerpt',
  lookup: '🔎 lookup',
  cache: '💾 saved answer',
  correction: '✏️ staff correction',
};

export const sourceLabel = (e: Pick<AiLogEntry, 'source' | 'model'>): string => `${SOURCE_LABEL[e.source]}${e.model ? ` (${e.model})` : ''}`;

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** One entry as a short Discord block: time, asker, source and speed, the question, the start of the answer. */
export function formatAiLogEntry(e: AiLogEntry): string {
  const secs = e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : `${e.ms}ms`;
  const head = `<t:${Math.floor(e.at / 1000)}:R> <@${e.userId}> · ${sourceLabel(e)} · ${secs}${e.found ? '' : ' · ⚠️ nothing found'}`;
  const answer = e.answer ? `\n> ↳ ${oneLine(e.answer, 160)}` : '';
  return `${head}\n> **${oneLine(e.question, 140)}**${answer}`;
}

/** Entries for one embed description, newest first, as many as fit. */
export function formatAiLog(entries: AiLogEntry[], limit = 3800): string {
  const out: string[] = [];
  let size = 0;
  for (const e of entries) {
    const block = formatAiLogEntry(e);
    if (size + block.length + 2 > limit) break;
    out.push(block);
    size += block.length + 2;
  }
  return out.join('\n\n');
}
