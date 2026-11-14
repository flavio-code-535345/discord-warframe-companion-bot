import type { AppContext } from '../context.js';
import type { Reminder } from '../db.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { discordTime } from '../time.js';
import { parseReminderTime } from './parse.js';

/**
 * /remindme: a member's own reminders. A DM at the time they asked for; when DMs are closed, a reply in the channel it was set in that
 * pings only them; then it is dropped. After downtime an overdue reminder goes out once, saying it is late. The text is the member's
 * own words and nobody else's pings come out of it (`neutralise`, `allowedMentions`).
 */

export const MAX_PENDING = 25;
export const MAX_MESSAGE = 300;
export const MIN_AHEAD_MS = 60_000;
export const MAX_AHEAD_MS = 2 * 365 * 86_400_000;
/** A reminder later than this after its time says so. */
export const LATE_MS = 2 * 60_000;
/** Failed deliveries (other than closed DMs) before it is dropped. */
export const MAX_ATTEMPTS = 3;
const DM_CLOSED = 50007;

/** Breaks every mention in a member's text: it is shown, never acted on. */
export function neutralise(text: string): string {
  return text.replace(/@(everyone|here)/gi, '@​$1').replace(/<(@[!&]?|#)(\d+)>/g, '<$1​$2>');
}

export function addReminder(ctx: AppContext, input: { userId: string; channelId: string | null; when: string; message: string }, now = Date.now()): Reminder {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const message = input.message.trim().replace(/\s+/g, ' ');
  if (!message) throw new UserError('Tell me what to remind you of.');
  if (message.length > MAX_MESSAGE) throw new UserError(`Keep the message to ${MAX_MESSAGE} characters (it is ${message.length}).`);
  const zone = ctx.config.CLAN_TIMEZONE;
  const dueAt = parseReminderTime(input.when, now, zone);
  if (dueAt === null) {
    throw new UserError(`I could not read "${input.when.slice(0, 60)}" as a time. Try "2h", "3 days", "1w 2d", "tomorrow 9am", "24.12.2026 18:00" or "2026-12-01 18:00" (dates are in ${zone}).`);
  }
  if (dueAt < now + MIN_AHEAD_MS) throw new UserError(dueAt <= now ? 'That time has already passed.' : 'The soonest I can remind you is 1 minute from now.');
  if (dueAt > now + MAX_AHEAD_MS) throw new UserError('I can remind you at most 2 years ahead.');
  if (ctx.store.countReminders(guildId, input.userId) >= MAX_PENDING) {
    throw new UserError(`You already have ${MAX_PENDING} reminders waiting. Cancel one with \`/remindme cancel\` first.`);
  }
  const id = ctx.store.addReminder({ guildId, userId: input.userId, channelId: input.channelId, message, dueAt, createdAt: now });
  return { id, guildId, userId: input.userId, channelId: input.channelId, message, dueAt, createdAt: now, attempts: 0 };
}

export function cancelReminder(ctx: AppContext, userId: string, id: number): Reminder {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const found = ctx.store.listReminders(guildId, userId).find((r) => r.id === id);
  if (!found || !ctx.store.removeReminder(id, guildId, userId)) throw new UserError('You have no such reminder (it may have gone off already).');
  return found;
}

export function reminderText(r: Reminder, now: number): string {
  const late = now - r.dueAt > LATE_MS;
  const head = late ? `⏰ Reminder (sorry, I am late: it was due ${discordTime(r.dueAt)})` : '⏰ Reminder';
  return `${head}\n${neutralise(r.message)}\n-# Set ${discordTime(r.createdAt, 'F')}`;
}

type Outcome = 'sent' | 'retry' | 'dropped';

async function deliver(ctx: AppContext, r: Reminder, now: number): Promise<Outcome> {
  const content = reminderText(r, now);
  let closed = false;
  try {
    const user = await ctx.client.users.fetch(r.userId);
    await user.send({ content, allowedMentions: { parse: [] } });
    return 'sent';
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    closed = code === DM_CLOSED;
    if (!closed) console.warn(`[reminders] DM to ${r.userId} failed:`, err instanceof Error ? err.message : err);
  }
  // DMs are closed (or keep failing): a reply where it was set, pinging only the member.
  if (r.channelId && (closed || r.attempts + 1 >= MAX_ATTEMPTS)) {
    try {
      const channel = await getSendableChannel(ctx, r.channelId);
      await channel.send({ content: `<@${r.userId}> ${content}\n-# I could not DM you, so I answered here.`, allowedMentions: { users: [r.userId] } });
      return 'sent';
    } catch (err) {
      console.warn(`[reminders] channel fallback for ${r.userId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  if (closed) return 'dropped';
  return ctx.store.bumpReminderAttempts(r.id) >= MAX_ATTEMPTS ? 'dropped' : 'retry';
}

/** The `reminders` job: delivers what is due. A reminder is deleted once sent or given up, never twice. Returns the delay to the next run. */
export async function remindersJob(ctx: AppContext, now = Date.now()): Promise<void> {
  for (const r of ctx.store.dueReminders(now)) {
    const outcome = await deliver(ctx, r, now);
    if (outcome !== 'retry') ctx.store.deleteReminder(r.id);
  }
}
