import { ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import type { AppContext } from '../context.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { toMs } from '../time.js';
import { MAX_TRACKERS_PER_USER, parseSpec } from '../trackers.js';
import type { WorldState } from '../warframe/worldstate.js';
import { COLORS, archonEmbed, steelPathEmbed } from './embeds.js';
import { footer } from './style.js';

/**
 * The Monday post: what the weekly reset (Monday 00:00 UTC) brought, in the /setup weekly channel and as a DM to everyone with the
 * Weeklies role or a /track weekly subscription. It waits until the world state
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

/** The button under the channel post and on the alerts summary: `weekly:toggle` turns the member's DM subscription on or off. */
export function weeklyButton(): ButtonBuilder {
  return new ButtonBuilder().setCustomId('weekly:toggle').setLabel('Weeklies by DM').setEmoji('🗓️').setStyle(ButtonStyle.Secondary);
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
export async function sendWeekly(ctx: AppContext, ws: WorldState, week: number): Promise<{ channel: boolean; dms: number; failed: number }> {
  const embeds = weeklyEmbeds(ws, week);
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).weeklyChannelId;
  let posted = false;
  if (channelId) {
    const channel = await getSendableChannel(ctx, channelId);
    // The button only goes under the channel post: in a DM a tap would not reach the clan server's interactions.
    await channel.send({ embeds, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(weeklyButton())], allowedMentions: { parse: [] } });
    posted = true;
  }
  let dms = 0;
  let failed = 0;
  for (const userId of await weeklySubscribers(ctx)) {
    try {
      const user = await ctx.client.users.fetch(userId);
      await user.send({ embeds });
      dms++;
    } catch (err) {
      failed++;
      console.warn(`[weekly] could not DM ${userId} (DMs closed?):`, (err as Error).message);
    }
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
  await sendWeekly(ctx, ws, week);
}
