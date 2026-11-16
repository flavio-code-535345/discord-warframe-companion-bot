import { type ContainerBuilder, MessageFlags, type SendableChannels } from 'discord.js';
import type { AppContext } from '../context.js';
import { WEEK_MS, discordTime, toMs, weekStart } from '../time.js';
import type { WorldState } from '../warframe/worldstate.js';
import { sendDm } from './dm.js';
import { e } from './emoji.js';
import { DIVIDER, card } from './feeds/parts.js';
import { archonPart, honorsPart } from './feeds/weeklies.js';
import { COLORS } from './style.js';
import { subscribersOf } from './subscriptions.js';

/**
 * The Monday DM: what the weekly reset (Monday 00:00 UTC) brought, as one Components V2 card DMed to everyone with the weekly
 * notification (`/track weekly` or the "Weeklies by DM" button). The weeklies channel shows the live Weeklies board instead
 * (feeds/weeklies.ts). It waits until the world state shows the new week (the Archon Hunt started after the reset), or sends anyway
 * after WAIT_LIMIT_MS; bot_meta `weekly_posted` holds the week it last sent, so it goes out once per week, also across restarts.
 */

const WAIT_LIMIT_MS = 6 * 3_600_000;

/** Whether the post for this week is due now. */
export function weeklyDue(ws: WorldState, lastPosted: number, now: number): number | null {
  const week = weekStart(now);
  if (lastPosted >= week) return null;
  const fresh = ws.archonHunt ? toMs(ws.archonHunt.activation) >= week : false;
  return fresh || now - week >= WAIT_LIMIT_MS ? week : null;
}

/**
 * The week's post as one card: this week's Duviri Circuit, the weekly Nightwave challenges, the Archon Hunt and Teshin's Steel Path
 * honor. Pure.
 */
export function weeklyCard(ws: WorldState, week: number, now: number): ContainerBuilder {
  const d = ws.duviriCycle as { choices?: { category?: string; choices?: string[] }[] } | undefined;
  const normal = d?.choices?.find((c) => c.category === 'normal')?.choices ?? [];
  const hard = d?.choices?.find((c) => c.category === 'hard')?.choices ?? [];
  const circuit = [
    normal.length ? `${e('warframe')} **Warframes:** ${normal.join(', ')}` : null,
    hard.length ? `${e('steelPath')} **Steel Path Incarnons:** ${hard.join(', ')}` : null,
  ].filter(Boolean);
  const weeklies = (ws.nightwave?.activeChallenges ?? []).filter((c) => !c.isDaily);
  const nightwave = weeklies.map((c) => `${c.isElite ? e('star') : '•'} **${c.title}** · ${c.reputation.toLocaleString('en-US')}\n-# ${c.desc}`);
  return card(COLORS.brand, [
    `## ${e('weekly')} Weekly reset\nThe week of ${discordTime(week, 'D')} · the next reset is ${discordTime(week + WEEK_MS, 'R')}`,
    DIVIDER,
    circuit.length ? `### ${e('duviri')} Duviri Circuit\n${circuit.join('\n')}` : null,
    DIVIDER,
    nightwave.length ? `### ${e('nightwave')} Nightwave this week\n${nightwave.join('\n')}` : null,
    DIVIDER,
    ...archonPart(ws, now, '###'),
    DIVIDER,
    honorsPart(ws, now),
  ]);
}

type Raw = { type?: number; components?: Raw[]; content?: string };

/** A Monday post as Discord has it: one Components V2 container whose text has the "Weekly reset" heading (the live board has none). */
const isWeeklyCard = (raw: Raw): boolean => raw.type === 17 && !!raw.components?.some((c) => c.type === 10 && c.content?.includes('Weekly reset'));

/**
 * Deletes the Monday posts the bot left in the weekly channel before it held the live Weeklies board: the Components V2 cards and the
 * older embed posts (titled "Weekly reset · week of …") among the last 50 messages. A failure is logged per message and stops nothing.
 * Returns how many it deleted.
 */
export async function clearOldWeeklies(channel: SendableChannels, botId: string): Promise<number> {
  let batch;
  try {
    batch = await channel.messages.fetch({ limit: 50 });
  } catch (err) {
    console.warn('[weekly] could not read the channel to clear the old posts:', err instanceof Error ? err.message : err);
    return 0;
  }
  let done = 0;
  for (const message of batch.values()) {
    if (message.author.id !== botId) continue;
    const old = message.flags.has(MessageFlags.IsComponentsV2)
      ? message.components.some((c) => isWeeklyCard((c as { toJSON(): Raw }).toJSON()))
      : !!message.embeds[0]?.title?.includes('Weekly reset');
    if (!old) continue;
    try {
      await message.delete();
      done++;
    } catch (err) {
      console.warn('[weekly] could not delete an old post:', err instanceof Error ? err.message : err);
    }
  }
  return done;
}

/** Who gets the post as a DM: the members with the weekly notification (`/track weekly` or the "Weeklies by DM" button), each once. */
export const weeklySubscribers = (ctx: Pick<AppContext, 'store' | 'config'>): string[] => subscribersOf(ctx, (s) => s.kind === 'weekly');

/** DMs the week's summary to every subscriber. Returns who was reached. */
export async function sendWeekly(ctx: AppContext, ws: WorldState, week: number, now = Date.now()): Promise<{ dms: number; failed: number }> {
  const dm = weeklyCard(ws, week, now);
  let dms = 0;
  let failed = 0;
  for (const userId of weeklySubscribers(ctx)) {
    if (await sendDm(ctx, userId, dm, 'the weekly post')) dms++;
    else failed++;
  }
  return { dms, failed };
}

export async function postWeeklyReset(ctx: AppContext, ws: WorldState, now = Date.now()): Promise<void> {
  if (!weeklySubscribers(ctx).length) return;
  const week = weeklyDue(ws, Number(ctx.store.getMeta('weekly_posted')) || 0, now);
  if (week === null || now - week > WEEK_MS) return;
  // Marked first: a failure to post is logged, not retried every minute.
  ctx.store.setMeta('weekly_posted', String(week));
  await sendWeekly(ctx, ws, week, now);
}
