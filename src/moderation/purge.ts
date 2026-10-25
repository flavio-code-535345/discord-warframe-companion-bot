import type { GuildTextBasedChannel, Message } from 'discord.js';

/** Discord only bulk-deletes messages younger than 14 days; an hour's margin avoids edge-of-window failures. */
export const BULK_MAX_AGE_MS = 14 * 24 * 3_600_000 - 3_600_000;
/** Older messages go one request at a time, so a single run stops after this many. */
export const OLD_DELETE_CAP = 300;
export const MAX_PURGE = 1000;

export interface PurgeFilter {
  userId?: string;
  botsOnly?: boolean;
  includePinned?: boolean;
}

export interface PurgeCandidate {
  id: string;
  authorId: string;
  bot: boolean;
  pinned: boolean;
  createdTimestamp: number;
}

/** "25" → 25, "all" → 'all'; null for anything else (including 0 or more than MAX_PURGE). */
export function parseAmount(input: string): number | 'all' | null {
  const s = input.trim().toLowerCase();
  if (s === 'all' || s === 'everything') return 'all';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_PURGE ? n : null;
}

/** Picks up to `remaining` matching messages from one fetched batch (newest first), split by bulk-deletability. */
export function selectForPurge(batch: PurgeCandidate[], filter: PurgeFilter, remaining: number, now = Date.now()) {
  const recent: string[] = [];
  const old: string[] = [];
  for (const m of batch) {
    if (recent.length + old.length >= remaining) break;
    if (m.pinned && !filter.includePinned) continue;
    if (filter.userId && m.authorId !== filter.userId) continue;
    if (filter.botsOnly && !m.bot) continue;
    (now - m.createdTimestamp < BULK_MAX_AGE_MS ? recent : old).push(m.id);
  }
  return { recent, old };
}

export interface PurgeResult {
  deleted: number;
  oldDeleted: number;
  /** True when the run stopped at OLD_DELETE_CAP with older messages possibly left. */
  capped: boolean;
}

const candidate = (m: Message): PurgeCandidate => ({
  id: m.id,
  authorId: m.author.id,
  bot: m.author.bot,
  pinned: m.pinned,
  createdTimestamp: m.createdTimestamp,
});

/** Deletes messages from newest to oldest until `limit` matches are gone or the channel runs out. */
export async function runPurge(
  channel: GuildTextBasedChannel,
  limit: number | 'all',
  filter: PurgeFilter,
  onProgress?: (deleted: number) => Promise<void> | void,
): Promise<PurgeResult> {
  const max = limit === 'all' ? Number.POSITIVE_INFINITY : limit;
  let deleted = 0;
  let oldDeleted = 0;
  let before: string | undefined;

  while (deleted < max) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    before = batch.last()!.id;
    const { recent, old } = selectForPurge([...batch.values()].map(candidate), filter, max - deleted);

    if (recent.length >= 2) deleted += (await channel.bulkDelete(recent, true)).size;
    else if (recent.length === 1) {
      await channel.messages.delete(recent[0]!);
      deleted++;
    }
    for (const id of old) {
      if (oldDeleted >= OLD_DELETE_CAP) return { deleted, oldDeleted, capped: true };
      await channel.messages.delete(id).catch(() => {});
      oldDeleted++;
      deleted++;
    }
    if (batch.size < 100) break;
    await onProgress?.(deleted);
  }
  return { deleted, oldDeleted, capped: false };
}
