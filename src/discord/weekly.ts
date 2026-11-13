import { type ContainerBuilder, MessageFlags } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { WEEK_MS, discordTime, toMs, weekStart } from '../time.js';
import type { WorldState } from '../warframe/worldstate.js';
import { sendDm } from './dm.js';
import { e } from './emoji.js';
import { buttonRow, notifyButton } from './feeds/controls.js';
import { DIVIDER, card } from './feeds/parts.js';
import { archonPart, honorsPart } from './feeds/sortie.js';
import { COLORS } from './style.js';
import { subscribersOf } from './subscriptions.js';

/**
 * The Monday post: what the weekly reset (Monday 00:00 UTC) brought, as one Components V2 card in the /setup weekly channel and as a
 * DM to everyone with the weekly notification (`/track weekly` or the "Weeklies by DM" button). It waits until the world state shows
 * the new week (the Archon Hunt started after the reset), or posts anyway after WAIT_LIMIT_MS; bot_meta `weekly_posted` holds the week
 * it last posted, so it goes out once per week, also across restarts.
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
 * honor. `button` adds the Weeklies by DM toggle, for the channel post only (a tap in a DM would not reach the clan server's
 * interactions). Pure.
 */
export function weeklyCard(ws: WorldState, week: number, now: number, button = false): ContainerBuilder {
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
    DIVIDER,
    button ? buttonRow(notifyButton('weekly')) : null,
  ]);
}

/** Called when the channel is set: the week already under way is not posted halfway through, the first post is the next Monday. */
export function skipCurrentWeek(ctx: Pick<AppContext, 'store'>, now = Date.now()): void {
  ctx.store.setMeta('weekly_posted', String(weekStart(now)));
}

/** Who gets the post as a DM: the members with the weekly notification (`/track weekly` or the "Weeklies by DM" button), each once. */
export const weeklySubscribers = (ctx: Pick<AppContext, 'store' | 'config'>): string[] => subscribersOf(ctx, (s) => s.kind === 'weekly');

/** Posts the week's summary in the weekly channel (when one is set) and DMs it to every subscriber. Returns who was reached. */
export async function sendWeekly(ctx: AppContext, ws: WorldState, week: number, now = Date.now()): Promise<{ channel: boolean; dms: number; failed: number }> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).weeklyChannelId;
  let posted = false;
  if (channelId) {
    const channel = await getSendableChannel(ctx, channelId);
    await channel.send({ components: [weeklyCard(ws, week, now, true)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    posted = true;
  }
  const dm = weeklyCard(ws, week, now);
  let dms = 0;
  let failed = 0;
  for (const userId of weeklySubscribers(ctx)) {
    if (await sendDm(ctx, userId, dm, 'the weekly post')) dms++;
    else failed++;
  }
  return { channel: posted, dms, failed };
}

export async function postWeeklyReset(ctx: AppContext, ws: WorldState, now = Date.now()): Promise<void> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const settings = ctx.store.getSettings(guildId);
  if (!settings.weeklyChannelId && !weeklySubscribers(ctx).length) return;
  const week = weeklyDue(ws, Number(ctx.store.getMeta('weekly_posted')) || 0, now);
  if (week === null || now - week > WEEK_MS) return;
  // Marked first: a failure to post is logged, not retried every minute.
  ctx.store.setMeta('weekly_posted', String(week));
  await sendWeekly(ctx, ws, week, now);
}
