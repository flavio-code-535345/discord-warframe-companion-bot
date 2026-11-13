import type { AppContext } from '../context.js';
import type { ClanEvent } from '../db.js';
import { UserError, createClanEvent, repeatText } from '../services/clan.js';
import { addDaysInZone, discordTime } from '../time.js';
import { staffNotice } from './staff.js';

/**
 * Repeating events (`/event create repeat:`, the panel's Events form, MCP `create_event`): once a round is over (its end, or an hour
 * after its start without one) the `events` job posts the next one as an event of its own, with fresh RSVP buttons, its own reminder
 * and Discord event, and a DM to the members who asked for new clan events. A cancelled round is followed like any other; a series
 * ends with `/event repeat every:Never` or `/event cancel series:True`.
 */

const DAY_MS = 86_400_000;
/** A round that could not be posted is tried again this much later. */
const RETRY_MS = 15 * 60_000;

/**
 * When the round after `previous` starts: the series' first start plus whole intervals, at the same time of day in the clan's time
 * zone (a weekly 20:00 stays 20:00 through a clock change), and the first such time that is still ahead: rounds missed while Ordis
 * was off are skipped. Counted from the first start, so one odd round never shifts the ones after it. Pure.
 */
export function nextOccurrence(first: number, previous: number, days: number, timeZone: string, now: number): number {
  const after = Math.max(previous, now);
  // Start a round early: a clock change moves a round by an hour, which can put it on the other side of a whole interval.
  let k = Math.max(1, Math.floor((after - first) / (days * DAY_MS)) - 1);
  for (let i = 0; i < 16; i++, k++) {
    const at = addDaysInZone(first, k * days, timeZone);
    if (at > after) return at;
  }
  return after + days * DAY_MS;
}

/** Event id → the time before which it is not tried again, and the events the staff were told about. In memory: a restart retries. */
const retryAt = new Map<number, number>();
const told = new Set<number>();

/** Posts the next round of every repeating event that is over (the `events` job, every minute). Returns the rounds it posted. */
export async function repeatEvents(ctx: AppContext, now = Date.now()): Promise<ClanEvent[]> {
  const posted: ClanEvent[] = [];
  for (const event of ctx.store.eventsDueToRepeat(ctx.config.DISCORD_GUILD_ID, now)) {
    if ((retryAt.get(event.id) ?? 0) > now || event.repeatDays === null) continue;
    const days = event.repeatDays;
    const first = (event.seriesId !== null && event.seriesId !== event.id ? ctx.store.getEvent(event.seriesId) : null) ?? event;
    const startsAt = nextOccurrence(first.startsAt, event.startsAt, days, ctx.config.CLAN_TIMEZONE, now);
    const round = {
      title: event.title,
      description: event.description,
      startsAt,
      endsAt: event.endsAt === null ? null : startsAt + (event.endsAt - event.startsAt),
      createdBy: event.createdBy,
      repeatDays: days,
      after: event,
    };
    try {
      let next: ClanEvent;
      try {
        next = await createClanEvent(ctx, { ...round, channelId: event.channelId });
      } catch (err) {
        // Its own channel is gone or closed to Ordis: the announcements channel takes the series over.
        if (!(err instanceof UserError) || !event.channelId) throw err;
        next = await createClanEvent(ctx, { ...round, channelId: null });
      }
      posted.push(next);
      retryAt.delete(event.id);
      told.delete(event.id);
      console.log(`[events] "${event.title}" repeats ${repeatText(days)}: round #${next.id} posted for ${new Date(startsAt).toISOString()}`);
    } catch (err) {
      retryAt.set(event.id, now + RETRY_MS);
      console.error(`[events] the next round of "${event.title}" (after #${event.id}) could not be posted:`, err);
      if (!told.has(event.id)) {
        told.add(event.id);
        await staffNotice(ctx, {
          tone: 'warn',
          title: '⚠️ A repeating event could not be posted',
          text: `**${event.title}** repeats ${repeatText(days)}, but its next round (${discordTime(startsAt, 'F')}) could not be posted: ${
            err instanceof UserError ? err.message : 'see the bot log'
          }\n\nOrdis tries again every 15 minutes. \`/event repeat id:${event.id} every:Never\` stops the series.`,
        });
      }
    }
  }
  return posted;
}

/** Test hook: forgets which rounds failed. */
export function resetEventRepeat(): void {
  retryAt.clear();
  told.clear();
}
