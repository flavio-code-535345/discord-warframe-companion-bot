import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js';
import type { AppContext } from '../context.js';
import type { ClanEvent, LfgPost } from '../db.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { discordTime } from '../time.js';

/**
 * Clan operations shared by slash commands and MCP tools. Anything that posts to Discord
 * goes through here so both entry points behave the same way.
 */

export class UserError extends Error {}

/** Fetches a channel the bot can post in, restricted to the clan's own server. */
export async function getSendableChannel(ctx: AppContext, channelId: string): Promise<SendableChannels & { guildId: string }> {
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== ctx.config.DISCORD_GUILD_ID) {
    throw new UserError(`Channel ${channelId} is not a text channel in the clan server that I can post in.`);
  }
  return channel as SendableChannels & { guildId: string };
}

/** Uses the explicit channel if given, else the configured announcements channel. */
export async function resolveAnnouncementChannel(ctx: AppContext, channelId?: string | null) {
  const id = channelId ?? ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).announcementsChannelId;
  if (!id) throw new UserError('No channel given and no announcements channel is configured (use /setup announcements).');
  return getSendableChannel(ctx, id);
}

// --- events ---

const RSVP_LABELS = { going: '✅ Going', maybe: '🤔 Maybe', declined: "❌ Can't make it" } as const;

export function renderEvent(ctx: AppContext, event: ClanEvent): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const rsvps = ctx.store.getRsvps(event.id);
  const list = (ids: string[]) => (ids.length ? ids.map((id) => `<@${id}>`).join(', ').slice(0, 1000) : '—');
  const embed = new EmbedBuilder()
    .setColor(event.cancelled ? 0x6b7280 : COLORS.brand)
    .setTitle(`${event.cancelled ? '🚫 CANCELLED: ' : '📅 '}${event.title}`)
    .setDescription(event.description || null)
    .addFields(
      { name: 'When', value: `${discordTime(event.startsAt, 'F')} (${discordTime(event.startsAt)})` },
      { name: `${RSVP_LABELS.going} (${rsvps.going.length})`, value: list(rsvps.going), inline: true },
      { name: `${RSVP_LABELS.maybe} (${rsvps.maybe.length})`, value: list(rsvps.maybe), inline: true },
      { name: `${RSVP_LABELS.declined} (${rsvps.declined.length})`, value: list(rsvps.declined), inline: true },
    )
    .setFooter({ text: `${ctx.config.CLAN_NAME} · event #${event.id}`, iconURL: brandIcon(ctx) });
  if (event.cancelled || event.startsAt < Date.now() - 3_600_000) return { embeds: [embed], components: [] };
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rsvp:${event.id}:going`).setLabel('Going').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rsvp:${event.id}:maybe`).setLabel('Maybe').setEmoji('🤔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rsvp:${event.id}:declined`).setLabel("Can't").setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

export interface CreateEventInput {
  title: string;
  description?: string | null;
  startsAt: number;
  createdBy: string;
  channelId?: string | null;
}

export async function createClanEvent(ctx: AppContext, input: CreateEventInput): Promise<ClanEvent> {
  if (input.startsAt <= Date.now()) throw new UserError('The event start time must be in the future.');
  const channel = await resolveAnnouncementChannel(ctx, input.channelId);
  const event = ctx.store.createEvent({
    guildId: ctx.config.DISCORD_GUILD_ID,
    title: input.title.slice(0, 200),
    description: input.description?.slice(0, 2000) ?? null,
    startsAt: input.startsAt,
    createdBy: input.createdBy,
  });
  const message = await channel.send(renderEvent(ctx, event));
  ctx.store.setEventMessage(event.id, channel.id, message.id);
  return ctx.store.getEvent(event.id)!;
}

/** Re-renders an event's Discord message after RSVPs or status changes. Missing messages are ignored. */
export async function refreshEventMessage(ctx: AppContext, eventId: number): Promise<void> {
  const event = ctx.store.getEvent(eventId);
  if (!event?.channelId || !event.messageId) return;
  const channel = await getSendableChannel(ctx, event.channelId).catch(() => null);
  const message = await channel?.messages.fetch(event.messageId).catch(() => null);
  await message?.edit(renderEvent(ctx, event));
}

export async function cancelClanEvent(ctx: AppContext, eventId: number): Promise<ClanEvent> {
  const event = ctx.store.getEvent(eventId);
  if (!event || event.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError(`Event #${eventId} does not exist.`);
  if (event.cancelled) throw new UserError(`Event #${eventId} is already cancelled.`);
  ctx.store.cancelEvent(eventId);
  await refreshEventMessage(ctx, eventId);
  return ctx.store.getEvent(eventId)!;
}

// --- announcements ---

export interface AnnouncementInput {
  message: string;
  title?: string | null;
  channelId?: string | null;
  pingRoleId?: string | null;
}

export async function postAnnouncement(ctx: AppContext, input: AnnouncementInput) {
  const channel = await resolveAnnouncementChannel(ctx, input.channelId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: `${ctx.config.BOT_NAME} · ${ctx.config.CLAN_NAME}`, iconURL: brandIcon(ctx) })
    .setTitle(input.title?.slice(0, 256) || '📣 Clan announcement')
    .setDescription(input.message.slice(0, 4000))
    .setTimestamp();
  return channel.send({
    content: input.pingRoleId ? `<@&${input.pingRoleId}>` : undefined,
    embeds: [embed],
    // Never let free text trigger @everyone/@here or arbitrary pings; only the explicit role.
    allowedMentions: { parse: [], roles: input.pingRoleId ? [input.pingRoleId] : [] },
  });
}

// --- LFG ---

export function renderLfg(ctx: AppContext, post: LfgPost): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const members = ctx.store.lfgMembers(post.id);
  const full = members.length >= post.size;
  const slots = [...members.map((id) => `<@${id}>`), ...Array(Math.max(post.size - members.length, 0)).fill('*open*')];
  const embed = new EmbedBuilder()
    .setColor(post.closed ? 0x6b7280 : full ? COLORS.success : COLORS.info)
    .setTitle(`${post.closed ? '🔒 ' : '🐀 '}LFG: ${post.activity}`)
    .setDescription(post.details || null)
    .addFields(
      { name: `Squad (${members.length}/${post.size})`, value: slots.map((s, i) => `${i + 1}. ${s}`).join('\n') },
      { name: 'Host', value: `<@${post.hostId}>`, inline: true },
      { name: 'Posted', value: discordTime(post.createdAt), inline: true },
    )
    .setFooter({ text: `${ctx.config.CLAN_NAME} · LFG #${post.id}`, iconURL: brandIcon(ctx) });
  if (post.closed) return { embeds: [embed], components: [] };
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lfg:${post.id}:join`).setLabel('Join').setStyle(ButtonStyle.Success).setDisabled(full),
    new ButtonBuilder().setCustomId(`lfg:${post.id}:leave`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`lfg:${post.id}:close`).setLabel('Close').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}
