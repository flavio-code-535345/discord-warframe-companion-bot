import type { Message, VoiceState } from 'discord.js';
import type { AppContext } from '../context.js';
import type { MemberActivity } from '../db.js';

/**
 * When each member last wrote a message or was in voice, for leadership's inactivity report (/inactive). Only those two times are kept,
 * never what was said. A message is recorded at most every few minutes per member, so a busy chat costs almost nothing.
 */

const MESSAGE_THROTTLE_MS = 5 * 60_000;
const lastWrite = new Map<string, number>();

export function trackMessageActivity(message: Message, ctx: AppContext, now = Date.now()): void {
  if (!message.inGuild() || message.guildId !== ctx.config.DISCORD_GUILD_ID || message.author.bot) return;
  if (now - (lastWrite.get(message.author.id) ?? 0) < MESSAGE_THROTTLE_MS) return;
  lastWrite.set(message.author.id, now);
  ctx.store.touchActivity(message.guildId, message.author.id, 'message', now);
}

/** Joining, leaving or moving in voice counts; leaving stamps the last moment someone was there. */
export function trackVoiceActivity(before: VoiceState, after: VoiceState, ctx: AppContext, now = Date.now()): void {
  const state = after.channelId ? after : before;
  if (!state.channelId || state.guild.id !== ctx.config.DISCORD_GUILD_ID || state.member?.user.bot) return;
  ctx.store.touchActivity(state.guild.id, state.id, 'voice', now);
}

export interface InactiveMember {
  userId: string;
  name: string;
  /** The latest message or voice time, or null when none was seen since tracking began. */
  lastSeen: number | null;
  joinedAt: number | null;
}

/**
 * Members whose last message or voice time is older than `days`, the longest silent first. Someone with no record counts only when they
 * joined before `cutoff` (and tracking began before it too), so a newcomer or a member from before tracking existed is not flagged too early.
 */
export function findInactive(
  members: { userId: string; name: string; joinedAt: number | null; bot: boolean }[],
  activity: Map<string, MemberActivity>,
  opts: { now: number; days: number; trackingSince: number },
): InactiveMember[] {
  const cutoff = opts.now - opts.days * 86_400_000;
  const out: InactiveMember[] = [];
  for (const m of members) {
    if (m.bot) continue;
    const a = activity.get(m.userId);
    const lastSeen = Math.max(a?.lastMessageAt ?? 0, a?.lastVoiceAt ?? 0) || null;
    if (lastSeen !== null ? lastSeen >= cutoff : (m.joinedAt ?? 0) >= cutoff || opts.trackingSince >= cutoff) continue;
    out.push({ userId: m.userId, name: m.name, lastSeen, joinedAt: m.joinedAt });
  }
  return out.sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0) || a.name.localeCompare(b.name));
}

/** When activity tracking started (set by the migration that added it). */
export function trackingSince(ctx: Pick<AppContext, 'store'>): number {
  return Number(ctx.store.getMeta('activity_since')) || Date.now();
}

export async function inactivityReport(ctx: AppContext, days: number, now = Date.now()): Promise<{ members: InactiveMember[]; trackingSince: number; checked: number }> {
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  // The full list needs the Server Members intent; without it the cached members are all there is.
  const all = await guild.members.fetch().catch(() => guild.members.cache);
  const members = [...all.values()].map((m) => ({ userId: m.id, name: m.displayName, joinedAt: m.joinedTimestamp ?? null, bot: m.user.bot }));
  const since = trackingSince(ctx);
  return { members: findInactive(members, ctx.store.memberActivity(guild.id), { now, days, trackingSince: since }), trackingSince: since, checked: members.filter((m) => !m.bot).length };
}
