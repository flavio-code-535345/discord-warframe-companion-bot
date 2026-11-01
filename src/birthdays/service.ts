import type { AppContext } from '../context.js';
import type { Birthday } from '../db.js';
import { UserError, getSendableChannel } from '../services/clan.js';

/**
 * Member birthdays (/birthday): only the day and month are kept, never the year. Once a day, from POST_HOUR_UTC, the notifier wishes
 * everyone whose birthday it is (UTC) a happy birthday in the /setup birthdays channel; bot_meta `birthday_posted` holds the day it last did.
 */

export const POST_HOUR_UTC = 7;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function assertValidBirthday(month: number, day: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new UserError('Pick a month from 1 to 12.');
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]!) throw new UserError(`${MONTHS[month - 1]} has no day ${day}.`);
}

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** Whose birthday it is on this UTC day; a 29 February birthday is wished on the 28th in other years. */
export function birthdaysOn(list: Birthday[], now: number): Birthday[] {
  const d = new Date(now);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return list.filter((b) => (b.month === month && b.day === day) || (b.month === 2 && b.day === 29 && month === 2 && day === 28 && !isLeap(d.getUTCFullYear())));
}

/** Days from today (UTC) to the next birthday, 0 for today. */
export function daysUntil(b: Birthday, now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let next = Date.UTC(d.getUTCFullYear(), b.month - 1, b.day);
  if (next < today) next = Date.UTC(d.getUTCFullYear() + 1, b.month - 1, b.day);
  return Math.round((next - today) / 86_400_000);
}

export const formatBirthday = (b: Pick<Birthday, 'month' | 'day'>): string => `${b.day} ${MONTHS[b.month - 1]}`;

export async function postBirthdays(ctx: AppContext, now = Date.now()): Promise<void> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const channelId = ctx.store.getSettings(guildId).birthdayChannelId;
  if (!channelId || new Date(now).getUTCHours() < POST_HOUR_UTC) return;
  const today = new Date(now).toISOString().slice(0, 10);
  if (ctx.store.getMeta('birthday_posted') === today) return;
  ctx.store.setMeta('birthday_posted', today);
  const due = birthdaysOn(ctx.store.listBirthdays(guildId), now);
  if (!due.length) return;
  // Only members who are still in the server are wished.
  const guild = await ctx.client.guilds.fetch(guildId);
  const present = (await Promise.all(due.map((b) => guild.members.fetch(b.userId).then(() => b.userId).catch(() => null)))).filter((id): id is string => id !== null);
  if (!present.length) return;
  const channel = await getSendableChannel(ctx, channelId);
  await channel.send({
    content: `🎂 Happy birthday ${present.map((id) => `<@${id}>`).join(', ')}! ${ctx.config.BOT_NAME} and the whole den wish you a great day, Tenno.`,
    allowedMentions: { users: present },
  });
}
