import { type ButtonInteraction, type ContainerBuilder, MessageFlags } from 'discord.js';
import type { AppContext } from '../context.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { WEEK_MS, discordTime, toMs, weekStart } from '../time.js';
import { MAX_TRACKERS_PER_USER, parseSpec } from '../trackers.js';
import type { WorldState } from '../warframe/worldstate.js';
import { sendDm } from './dm.js';
import { e } from './emoji.js';
import { buttonRow, weeklyButton } from './feeds/controls.js';
import { DIVIDER, card } from './feeds/parts.js';
import { archonPart, honorsPart } from './feeds/sortie.js';
import { COLORS } from './style.js';

/**
 * The Monday post: what the weekly reset (Monday 00:00 UTC) brought, as one Components V2 card in the /setup weekly channel and as a
 * DM to everyone with the Weeklies role or a /track weekly subscription. It waits until the world state shows the new week (the Archon
 * Hunt started after the reset), or posts anyway after WAIT_LIMIT_MS; bot_meta `weekly_posted` holds the week it last posted, so it
 * goes out once per week, also across restarts.
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
    button ? buttonRow(weeklyButton()) : null,
  ]);
}

/**
 * A tap on `weekly:toggle`: adds or removes the member's `/track weekly` subscription (ephemeral answer). Someone who also holds the
 * Weeklies role is told the role keeps the DMs coming, since only the role menu takes that away.
 */
export async function handleWeeklyButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const userId = interaction.user.id;
  const mine = ctx.store.listTrackers(guildId, userId);
  const existing = mine.find((t) => parseSpec(t.spec)?.kind === 'weekly');
  const roleId = ctx.store.getSettings(guildId).weeklyRoleId;
  const member = interaction.inCachedGuild() ? interaction.member : null;
  const hasRole = Boolean(roleId && member?.roles.cache.has(roleId));
  if (existing) {
    ctx.store.deleteTracker(guildId, userId, existing.id);
    const note = hasRole ? ` You still have the <@&${roleId}> role, which keeps them coming: drop it in the role menu to stop them completely.` : '';
    await interaction.reply({ content: `No more weekly DMs.${note}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  if (mine.length >= MAX_TRACKERS_PER_USER) throw new UserError(`You already have ${MAX_TRACKERS_PER_USER} notifications. Remove one with /track remove first.`);
  ctx.store.createTracker(guildId, userId, JSON.stringify({ kind: 'weekly' }));
  await interaction.reply({
    content: 'Done: every Monday Ordis DMs you what the reset brought. Tap the button again to stop. Make sure Direct Messages from server members are on for this server.',
    flags: MessageFlags.Ephemeral,
  });
}

/** Called when the channel is set: the week already under way is not posted halfway through, the first post is the next Monday. */
export function skipCurrentWeek(ctx: Pick<AppContext, 'store'>, now = Date.now()): void {
  ctx.store.setMeta('weekly_posted', String(weekStart(now)));
}

/**
 * Who gets the post as a DM: members holding the Weeklies role (`weeklyRoleId`, from the role menu) and members with a `/track weekly`
 * subscription, each once. The role's members need the Server Members intent to be complete; without it the cached ones are used.
 */
export async function weeklySubscribers(ctx: AppContext): Promise<string[]> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const ids = new Set(ctx.store.listTrackers(guildId).filter((t) => parseSpec(t.spec)?.kind === 'weekly').map((t) => t.userId));
  const roleId = ctx.store.getSettings(guildId).weeklyRoleId;
  if (roleId) {
    const guild = await ctx.client.guilds.fetch(guildId);
    const members = await guild.members.fetch().catch(() => guild.members.cache);
    for (const m of members.values()) if (!m.user.bot && m.roles.cache.has(roleId)) ids.add(m.id);
  }
  return [...ids];
}

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
  for (const userId of await weeklySubscribers(ctx)) {
    if (await sendDm(ctx, userId, dm, 'the weekly post')) dms++;
    else failed++;
  }
  return { channel: posted, dms, failed };
}

export async function postWeeklyReset(ctx: AppContext, ws: WorldState, now = Date.now()): Promise<void> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const settings = ctx.store.getSettings(guildId);
  const subscribed = Boolean(settings.weeklyRoleId) || ctx.store.listTrackers(guildId).some((t) => parseSpec(t.spec)?.kind === 'weekly');
  if (!settings.weeklyChannelId && !subscribed) return;
  const week = weeklyDue(ws, Number(ctx.store.getMeta('weekly_posted')) || 0, now);
  if (week === null || now - week > WEEK_MS) return;
  // Marked first: a failure to post is logged, not retried every minute.
  ctx.store.setMeta('weekly_posted', String(week));
  await sendWeekly(ctx, ws, week, now);
}
