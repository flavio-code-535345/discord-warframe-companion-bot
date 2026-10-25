import type { LfgPost } from '../db.js';

export const DEFAULT_GRACE_MINUTES = 5;

/** What the sweeper should do about one squad. */
export type SweepAction =
  | { kind: 'none' }
  | { kind: 'close'; reason: string }
  | { kind: 'delete-voice' }
  | { kind: 'clear-voice' }
  | { kind: 'host-present' }
  | { kind: 'host-absent'; since: number };

/**
 * Decides what a squad needs, from its stored state and who is in its voice channel right now
 * (`voiceMemberIds` is null when the channel no longer exists). Pure, so the rules are testable.
 *
 * - An open squad ends when its time runs out, or when its host has been out of voice for the grace period
 *   (counted from the squad's creation, so a host who never joins doesn't leave an empty channel behind).
 * - A closed squad's voice channel is deleted as soon as it is empty, so nobody is kicked mid-conversation.
 */
export function sweepAction(post: LfgPost, voiceMemberIds: string[] | null, now: number, graceMs: number): SweepAction {
  if (post.closed) {
    if (!post.voiceChannelId) return { kind: 'none' };
    if (voiceMemberIds === null) return { kind: 'clear-voice' };
    return voiceMemberIds.length === 0 ? { kind: 'delete-voice' } : { kind: 'none' };
  }

  if (post.expiresAt !== null && now >= post.expiresAt) return { kind: 'close', reason: 'time ran out' };
  if (!post.voiceChannelId) return { kind: 'none' };
  if (voiceMemberIds === null) return { kind: 'clear-voice' };

  if (voiceMemberIds.includes(post.hostId)) return post.hostAbsentSince === null ? { kind: 'none' } : { kind: 'host-present' };
  if (post.hostAbsentSince === null) return { kind: 'host-absent', since: now };
  return now - post.hostAbsentSince >= graceMs ? { kind: 'close', reason: 'the host was not in voice' } : { kind: 'none' };
}

/** Parses "30m", "2h" or "1d" into milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*([mhd])$/i.exec(text.trim());
  const amount = m ? Number(m[1]) : 0;
  if (!m || amount <= 0) throw new RangeError('Use a duration like 30m, 2h or 1d.');
  return amount * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as 'm' | 'h' | 'd'];
}

/** Embed-friendly picture URLs: plain https links without spaces. */
export function validImageUrl(text: string): string | null {
  const url = text.trim();
  if (url.length > 1000 || /\s/.test(url)) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
