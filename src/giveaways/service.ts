import { randomInt } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, type ButtonInteraction, ButtonStyle, EmbedBuilder, MessageFlags, type MessageCreateOptions } from 'discord.js';
import type { AppContext } from '../context.js';
import type { Giveaway } from '../db.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { discordTime } from '../time.js';

/**
 * Giveaways (/giveaway): a post with an Enter button (`giveaway:<id>:enter`, a second tap leaves again); when the time is up the
 * notifier draws the winners at random (crypto.randomInt), edits the post and pings them. The host can't enter their own giveaway.
 */

export const MIN_GIVEAWAY_MS = 60_000;
export const MAX_GIVEAWAY_MS = 30 * 86_400_000;
export const MAX_WINNERS = 10;
const MAX_OPEN_PER_HOST = 2;

/** `count` different entries in random order (all of them when there are fewer). */
export function drawWinners(entries: string[], count: number, exclude: string[] = [], rand: (n: number) => number = randomInt): string[] {
  const pool = entries.filter((e) => !exclude.includes(e));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}

export function renderGiveaway(ctx: AppContext, g: Giveaway, entries: number): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const embed = new EmbedBuilder()
    .setColor(g.ended ? COLORS.muted : COLORS.success)
    .setTitle(`🎁 ${g.ended ? 'Giveaway ended: ' : 'Giveaway: '}${g.prize}`)
    .addFields(
      { name: 'Hosted by', value: `<@${g.hostId}>`, inline: true },
      { name: g.ended ? 'Ended' : 'Ends', value: `${discordTime(g.endsAt)} (${discordTime(g.endsAt, 'f')})`, inline: true },
      { name: 'Entries', value: String(entries), inline: true },
    )
    .setFooter({ text: `${ctx.config.CLAN_NAME} · giveaway #${g.id} · ${g.winners} winner${g.winners === 1 ? '' : 's'}`, iconURL: brandIcon(ctx) });
  if (g.ended) {
    embed.addFields({ name: g.winnerIds.length === 1 ? 'Winner' : 'Winners', value: g.winnerIds.length ? g.winnerIds.map((id) => `<@${id}>`).join(', ') : 'Nobody entered.' });
    return { embeds: [embed], components: [] };
  }
  embed.setDescription('Tap **Enter** to take part, tap it again to leave. Winners are drawn at random when the time is up.');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`giveaway:${g.id}:enter`).setLabel('Enter').setEmoji('🎉').setStyle(ButtonStyle.Success));
  return { embeds: [embed], components: [row] };
}

export async function startGiveaway(ctx: AppContext, input: { channelId: string; hostId: string; prize: string; winners: number; endsAt: number }): Promise<Giveaway> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const length = input.endsAt - Date.now();
  if (!Number.isFinite(length) || length < MIN_GIVEAWAY_MS) throw new UserError('A giveaway must run for at least a minute.');
  if (length > MAX_GIVEAWAY_MS) throw new UserError('A giveaway can run for at most 30 days.');
  if (!Number.isInteger(input.winners) || input.winners < 1 || input.winners > MAX_WINNERS) throw new UserError(`Pick 1 to ${MAX_WINNERS} winners.`);
  if (ctx.store.openGiveaways(guildId).filter((g) => g.hostId === input.hostId).length >= MAX_OPEN_PER_HOST) {
    throw new UserError(`You already have ${MAX_OPEN_PER_HOST} giveaways running. End one with /giveaway end first.`);
  }
  const channel = await getSendableChannel(ctx, input.channelId);
  const g = ctx.store.createGiveaway({ guildId, channelId: channel.id, hostId: input.hostId, prize: input.prize.trim().slice(0, 200), winners: input.winners, endsAt: input.endsAt });
  const message = await channel.send({ ...renderGiveaway(ctx, g, 0), allowedMentions: { parse: [] } });
  ctx.store.setGiveawayMessage(g.id, message.id);
  return ctx.store.getGiveaway(g.id)!;
}

async function editPost(ctx: AppContext, g: Giveaway): Promise<void> {
  if (!g.messageId) return;
  const channel = await getSendableChannel(ctx, g.channelId).catch(() => null);
  const message = await channel?.messages.fetch(g.messageId).catch(() => null);
  await message?.edit(renderGiveaway(ctx, g, ctx.store.giveawayEntries(g.id).length));
}

async function announce(ctx: AppContext, g: Giveaway, winners: string[], reroll: boolean): Promise<void> {
  const channel = await getSendableChannel(ctx, g.channelId);
  const content = winners.length
    ? `🎉 ${reroll ? 'New draw' : 'Congratulations'} ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${g.prize}**. <@${g.hostId}> will get in touch.`
    : `The giveaway for **${g.prize}** ended without entries.`;
  await channel.send({
    content,
    reply: g.messageId ? { messageReference: g.messageId, failIfNotExists: false } : undefined,
    allowedMentions: { users: [...winners, g.hostId], repliedUser: false },
  });
}

/** Draws and announces the winners of a giveaway that is still open. */
export async function endGiveaway(ctx: AppContext, id: number): Promise<Giveaway> {
  const g = ctx.store.getGiveaway(id);
  if (!g || g.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError(`There is no giveaway #${id}.`);
  if (g.ended) throw new UserError(`Giveaway #${id} has already ended.`);
  const winners = drawWinners(ctx.store.giveawayEntries(id), g.winners);
  ctx.store.endGiveaway(id, winners);
  const ended = ctx.store.getGiveaway(id)!;
  await editPost(ctx, ended);
  await announce(ctx, ended, winners, false);
  return ended;
}

/** Draws again among the entries who have not won yet (a winner who didn't answer, say). */
export async function rerollGiveaway(ctx: AppContext, id: number, count = 1): Promise<string[]> {
  const g = ctx.store.getGiveaway(id);
  if (!g || g.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError(`There is no giveaway #${id}.`);
  if (!g.ended) throw new UserError(`Giveaway #${id} is still running.`);
  const winners = drawWinners(ctx.store.giveawayEntries(id), count, g.winnerIds);
  if (!winners.length) throw new UserError('Everyone who entered has already won.');
  ctx.store.endGiveaway(id, [...g.winnerIds, ...winners]);
  await editPost(ctx, ctx.store.getGiveaway(id)!);
  await announce(ctx, g, winners, true);
  return winners;
}

/** Called every minute by the notifier. */
export async function endDueGiveaways(ctx: AppContext, now = Date.now()): Promise<void> {
  for (const g of ctx.store.giveawaysDue(now)) {
    await endGiveaway(ctx, g.id).catch((err) => console.error(`[giveaways] could not end #${g.id}:`, err));
  }
}

export async function handleGiveawayButton(interaction: ButtonInteraction, ctx: AppContext, rawId: string): Promise<void> {
  const g = ctx.store.getGiveaway(Number(rawId));
  if (!g || g.ended || g.endsAt <= Date.now()) throw new UserError('This giveaway has ended.');
  if (interaction.user.id === g.hostId) throw new UserError("You can't enter your own giveaway.");
  const entered = ctx.store.toggleGiveawayEntry(g.id, interaction.user.id);
  await interaction.update(renderGiveaway(ctx, g, ctx.store.giveawayEntries(g.id).length));
  await interaction.followUp({ content: entered ? `You're in for **${g.prize}**. Good luck!` : 'You left the giveaway.', flags: MessageFlags.Ephemeral });
}
