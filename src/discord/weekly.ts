import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { toMs } from '../time.js';
import type { WorldState } from '../warframe/worldstate.js';
import { COLORS, archonEmbed, steelPathEmbed } from './embeds.js';
import { footer } from './style.js';

/**
 * The Monday post: what the weekly reset (Monday 00:00 UTC) brought, in the /setup weekly channel. It waits until the world state
 * shows the new week (the Archon Hunt started after the reset), or posts anyway after WAIT_LIMIT_MS; bot_meta `weekly_posted` holds the
 * week it last posted, so it goes out once per week, also across restarts.
 */

const WEEK_MS = 7 * 86_400_000;
const WAIT_LIMIT_MS = 6 * 3_600_000;

/** Monday 00:00 UTC of the week `now` is in. */
export function weekStart(now: number): number {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86_400_000;
}

/** Whether the post for this week is due now. */
export function weeklyDue(ws: WorldState, lastPosted: number, now: number): number | null {
  const week = weekStart(now);
  if (lastPosted >= week) return null;
  const fresh = ws.archonHunt ? toMs(ws.archonHunt.activation) >= week : false;
  return fresh || now - week >= WAIT_LIMIT_MS ? week : null;
}

/** The post's embeds: the overview (Circuit, Nightwave weeklies), then the Archon Hunt and Teshin's honors. Pure. */
export function weeklyEmbeds(ws: WorldState, week: number): EmbedBuilder[] {
  const d = ws.duviriCycle as { choices?: { category?: string; choices?: string[] }[] } | undefined;
  const normal = d?.choices?.find((c) => c.category === 'normal')?.choices ?? [];
  const hard = d?.choices?.find((c) => c.category === 'hard')?.choices ?? [];
  const weeklies = (ws.nightwave?.activeChallenges ?? []).filter((c) => !c.isDaily);
  const lines = [
    normal.length ? `**Circuit Warframes:** ${normal.join(', ')}` : null,
    hard.length ? `**Steel Path Circuit Incarnons:** ${hard.join(', ')}` : null,
    weeklies.length ? `\n**Nightwave this week**\n${weeklies.map((c) => `${c.isElite ? '⭐' : '•'} **${c.title}** (${c.reputation.toLocaleString('en-US')}): ${c.desc}`).join('\n')}` : null,
  ].filter(Boolean);
  const overview = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(`🗓️ Weekly reset · week of ${new Date(week).toISOString().slice(0, 10)}`)
    .setDescription((lines.length ? lines.join('\n') : 'A new week has started.').slice(0, 4000))
    .setFooter(footer('warframestat.us'));
  return [overview, archonEmbed(ws), steelPathEmbed(ws)];
}

/** Called when the channel is set: the week already under way is not posted halfway through, the first post is the next Monday. */
export function skipCurrentWeek(ctx: Pick<AppContext, 'store'>, now = Date.now()): void {
  ctx.store.setMeta('weekly_posted', String(weekStart(now)));
}

export async function postWeeklyReset(ctx: AppContext, ws: WorldState, now = Date.now()): Promise<void> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).weeklyChannelId;
  if (!channelId) return;
  const week = weeklyDue(ws, Number(ctx.store.getMeta('weekly_posted')) || 0, now);
  if (week === null || now - week > WEEK_MS) return;
  // Marked first: a failure to post is logged, not retried every minute.
  ctx.store.setMeta('weekly_posted', String(week));
  const channel = await getSendableChannel(ctx, channelId);
  await channel.send({ embeds: weeklyEmbeds(ws, week), allowedMentions: { parse: [] } });
}
