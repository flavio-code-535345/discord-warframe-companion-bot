import type { AppContext } from '../context.js';
import { getSendableChannel, refreshEventMessage } from '../services/clan.js';
import { discordTime } from '../time.js';
import { collectTrackables, describeTracker, matchTracker, parseSpec } from '../trackers.js';
import { type ArbitrationSlot, arbitrationView, loadArbitrations } from '../warframe/arbitrations.js';
import { type WorldState, getWorldState, worldStateEnabled } from '../warframe/worldstate.js';
import { type DmGroup, sendDm, trackerDm } from './dm.js';
import { repeatEvents } from './event-repeat.js';
import { feedInput, syncFeeds } from './feeds/index.js';
import { brandIcon } from './identity.js';
import { postNews } from './news.js';
import { postWeeklyReset } from './weekly.js';

const REMINDER_WINDOW_MS = 15 * 60 * 1000;
const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The world state job (src/jobs.ts, every minute; the world state itself is fetched at most every WORLDSTATE_POLL_SECONDS, the
 * Arbitration schedule twice a day): the World State boards, the members' DMs and the weekly reset post. The Arbitration board and
 * the Arbitration DMs work from the schedule alone, so they keep going while the world state is switched off or not answering.
 */
export async function worldStateJob(ctx: AppContext): Promise<void> {
  const now = Date.now();
  let ws: WorldState | null = null;
  let wsError: unknown = null;
  if (worldStateEnabled()) {
    try {
      ws = await getWorldState();
    } catch (err) {
      wsError = err;
    }
  }
  const arbyData = await loadArbitrations().catch(() => null);
  const arby = arbitrationView(arbyData, ws, now, { hours: 48, bestDays: 7, bestTier: 'B' });
  await syncFeeds(ctx, feedInput(ctx, { ws, arbyData, arby, now }), { wsFailed: wsError !== null });
  // The schedule's hours only while it agrees with the game; otherwise the world state's own entry (without a tier) is used.
  const slots = arby.scheduleTrusted ? [arby.current, ...arby.upcoming].filter((s): s is ArbitrationSlot => s !== null) : undefined;
  await notifyTrackers(ctx, ws, now, slots);
  if (ws) await postWeeklyReset(ctx, ws).catch((err) => console.error('[notifier] weekly reset post failed:', err));
  ctx.store.pruneSeen(SEEN_RETENTION_MS);
  if (wsError) throw wsError;
}

/** The game news job: the in-game news comes with the (cached) world state, the Steam announcements are read on their own. */
export async function newsJob(ctx: AppContext): Promise<void> {
  await postNews(ctx, worldStateEnabled() ? await getWorldState().catch(() => null) : null);
}

/** DMs each member about what matches their /track trackers and the boards' "DM me when…" menus, one message per member per round. */
async function notifyTrackers(ctx: AppContext, ws: WorldState | null, now: number, arbitrations: ArbitrationSlot[] | undefined): Promise<void> {
  const { store, config } = ctx;
  const trackers = store.listTrackers(config.DISCORD_GUILD_ID);
  if (!trackers.length) return;
  const items = collectTrackables(ws, now, arbitrations ? { arbitrations } : {});
  const perUser = new Map<string, DmGroup[]>();
  // What each member is already told about this round: an alert that matches two of their notifications ("anything worth running"
  // and "Forma") is listed once, under the first.
  const told = new Map<string, Set<string>>();

  for (const tracker of trackers) {
    const spec = parseSpec(tracker.spec);
    if (!spec) continue;
    const mine = told.get(tracker.userId) ?? new Set<string>();
    told.set(tracker.userId, mine);
    const matched: DmGroup['items'] = [];
    for (const item of items) {
      const hits = matchTracker(spec, item);
      // Marked as seen for this notification either way, so it is not sent on its own in a later round.
      if (hits === null || !store.markSeen(`track:${tracker.id}:${item.key}`)) continue;
      if (mine.has(item.key)) continue;
      mine.add(item.key);
      matched.push({ item, hits });
    }
    if (matched.length) {
      const list = perUser.get(tracker.userId) ?? [];
      list.push({ label: `${describeTracker(spec)} · #${tracker.id}`, items: matched });
      perUser.set(tracker.userId, list);
    }
  }

  const avatar = brandIcon(ctx) ?? null;
  for (const [userId, groups] of perUser) await sendDm(ctx, userId, trackerDm(groups, avatar), 'a tracker update');
}

/**
 * The clan events job (every minute): reminders 15 minutes before the start, ended events re-rendered without their buttons, then
 * the next round of every repeating event that is over.
 */
export async function eventsJob(ctx: AppContext): Promise<void> {
  await sendEventReminders(ctx);
  await finishEvents(ctx);
  await repeatEvents(ctx);
}

/** Events with an end time that has passed: mark them, and re-render their post as ended (the RSVP buttons go away). */
async function finishEvents(ctx: AppContext): Promise<void> {
  const { store } = ctx;
  for (const event of store.eventsDueToEnd(Date.now())) {
    store.markEventEnded(event.id);
    await refreshEventMessage(ctx, event.id).catch((err) => console.error(`[notifier] could not mark event #${event.id} as ended:`, err));
  }
}

async function sendEventReminders(ctx: AppContext): Promise<void> {
  const { store } = ctx;
  for (const event of store.eventsDueForReminder(Date.now(), REMINDER_WINDOW_MS)) {
    store.markEventReminded(event.id);
    if (!event.channelId) continue;
    const rsvps = store.getRsvps(event.id);
    const attendees = [...rsvps.going, ...rsvps.maybe];
    try {
      const channel = await getSendableChannel(ctx, event.channelId);
      await channel.send({
        content: `⏰ **${event.title}** starts ${discordTime(event.startsAt)}! ${attendees.map((u) => `<@${u}>`).join(' ')}`,
        reply: event.messageId ? { messageReference: event.messageId, failIfNotExists: false } : undefined,
        allowedMentions: { users: attendees, repliedUser: false },
      });
    } catch (err) {
      console.error(`[notifier] reminder for event #${event.id} failed:`, err);
    }
  }
}
