import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js';
import type { AppContext } from '../context.js';
import type { ClanEvent, GuildSettings, LfgPost } from '../db.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { notifyClanEvent } from '../discord/subscriptions.js';
import { UserError } from '../errors.js';
import { MAX_EVENT_LENGTH_MS, discordTime } from '../time.js';

/**
 * Clan operations shared by slash commands and MCP tools. Anything that posts to Discord
 * goes through here so both entry points behave the same way.
 */

// Defined in errors.ts (a file with no imports, so the data modules can throw it too); re-exported for everything that works with Discord.
export { UserError };

/** Fetches a channel the bot can post in, restricted to the clan's own server. */
export async function getSendableChannel(ctx: AppContext, channelId: string): Promise<SendableChannels & { guildId: string }> {
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isSendable() || !('guildId' in channel) || channel.guildId !== ctx.config.DISCORD_GUILD_ID) {
    throw new UserError(`Channel ${channelId} is not a text channel in the clan server that I can post in.`);
  }
  return channel as SendableChannels & { guildId: string };
}

/**
 * The settings that give a channel a job of its own. The first four make Ordis read every message there: two of those on one channel
 * fight over its messages (the screenshot handler deletes whatever is not a screenshot, the honeypot removes whoever posts, the chat
 * answers...). The rest are the World State boards (discord/feeds), each the whole content of its channel. A channel gets only one.
 */
const MESSAGE_JOBS = [
  ['chatChannelId', 'the Ordis chat'],
  ['honeypotChannelId', 'the honeypot'],
  ['ssRolesChannelId', 'screenshot roles'],
  ['rivenChannelId', 'riven scanning'],
  ['alertsChannelId', 'the alerts board'],
  ['arbitrationsChannelId', 'the arbitrations board'],
  ['fissuresChannelId', 'the fissures board'],
  ['sortieChannelId', 'the sortie and Archon board'],
  ['cyclesChannelId', 'the cycles board'],
  ['tradersChannelId', 'the traders board'],
  ['invasionsChannelId', 'the invasions board'],
] as const;

export type MessageJob = (typeof MESSAGE_JOBS)[number][0];

/**
 * Refuses a change that would give a channel a second message-reading job. `patch` holds the channel settings about to be saved (null turns
 * a job off, undefined leaves it alone); only the ones that really change are checked, so an old clash never blocks an unrelated edit.
 */
export function assertChannelFree(ctx: Pick<AppContext, 'config' | 'store'>, patch: Partial<Record<MessageJob, string | null>>): void {
  const before: Pick<GuildSettings, MessageJob> = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  const after = (key: MessageJob): string | null => (patch[key] === undefined ? before[key] : (patch[key] ?? null));
  for (const [key, label] of MESSAGE_JOBS) {
    const id = after(key);
    if (!id || id === before[key]) continue;
    const clash = MESSAGE_JOBS.find(([other]) => other !== key && after(other) === id);
    if (clash) throw new UserError(`That channel is already used for ${clash[1]}, so it cannot also be used for ${label}. Pick a channel just for this.`);
  }
}

/** Uses the explicit channel if given, else the configured announcements channel. */
export async function resolveAnnouncementChannel(ctx: AppContext, channelId?: string | null) {
  const id = channelId ?? ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).announcementsChannelId;
  if (!id) throw new UserError('No channel given and no announcements channel is configured (use /setup announcements).');
  return getSendableChannel(ctx, id);
}

// --- events ---

const RSVP_LABELS = { going: '✅ Going', maybe: '🤔 Maybe', declined: "❌ Can't make it" } as const;

/** Whether an event is over: past its end time, or (with no end time) more than an hour after it started. */
export function isOver(event: Pick<ClanEvent, 'startsAt' | 'endsAt'>, now = Date.now()): boolean {
  return event.endsAt !== null ? event.endsAt <= now : event.startsAt < now - 3_600_000;
}

/** How often an event may repeat, in days. A round is posted once the one before it is over (discord/event-repeat.ts). */
export const REPEAT_DAYS = [1, 7, 14, 28] as const;
const REPEAT_TEXT: Record<number, string> = { 1: 'every day', 7: 'every week', 14: 'every 2 weeks', 28: 'every 4 weeks' };
export const isRepeatDays = (days: unknown): days is (typeof REPEAT_DAYS)[number] => (REPEAT_DAYS as readonly unknown[]).includes(days);
/** "every week" for 7; an empty string for an event that happens once. */
export const repeatText = (days: number | null | undefined): string => (isRepeatDays(days) ? REPEAT_TEXT[days]! : '');

/** The "When" line: the start, the end when there is one ("Ends ..." while it runs, "Ended" afterwards) and how often it repeats. */
export function whenText(event: Pick<ClanEvent, 'startsAt' | 'endsAt'> & { repeatDays?: number | null }, now = Date.now()): string {
  const start = `${discordTime(event.startsAt, 'F')} (${discordTime(event.startsAt)})`;
  const repeats = repeatText(event.repeatDays) ? `\n🔁 Repeats ${repeatText(event.repeatDays)}` : '';
  if (event.endsAt === null) return `${start}${repeats}`;
  const end = `${discordTime(event.endsAt, 'F')}`;
  if (event.endsAt <= now) return `${start}\nEnded ${end}${repeats}`;
  if (event.startsAt <= now) return `🟢 **Happening now**\n${start}\nEnds ${discordTime(event.endsAt)} (${end})${repeats}`;
  return `${start}\nEnds ${end} (${discordTime(event.endsAt)})${repeats}`;
}

export function renderEvent(ctx: AppContext, event: ClanEvent): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const rsvps = ctx.store.getRsvps(event.id);
  const list = (ids: string[]) => (ids.length ? ids.map((id) => `<@${id}>`).join(', ').slice(0, 1000) : '—');
  const embed = new EmbedBuilder()
    .setColor(event.cancelled || isOver(event) ? 0x6b7280 : COLORS.brand)
    .setTitle(`${event.cancelled ? '🚫 CANCELLED: ' : event.endsAt !== null && isOver(event) ? '🏁 ENDED: ' : '📅 '}${event.title}`)
    .setDescription(event.description || null)
    .addFields(
      { name: 'When', value: whenText(event) },
      { name: `${RSVP_LABELS.going} (${rsvps.going.length})`, value: list(rsvps.going), inline: true },
      { name: `${RSVP_LABELS.maybe} (${rsvps.maybe.length})`, value: list(rsvps.maybe), inline: true },
      { name: `${RSVP_LABELS.declined} (${rsvps.declined.length})`, value: list(rsvps.declined), inline: true },
    )
    .setFooter({ text: `${ctx.config.CLAN_NAME} · event #${event.id}`, iconURL: brandIcon(ctx) });
  if (event.cancelled || isOver(event)) return { embeds: [embed], components: [] };
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
  /** Optional end time; must be after the start and at most MAX_EVENT_LENGTH_MS later. */
  endsAt?: number | null;
  createdBy: string;
  channelId?: string | null;
  /** Post it again this many days later, once it is over: one of REPEAT_DAYS. */
  repeatDays?: number | null;
  /** The round of a repeating event that this one follows (set by discord/event-repeat.ts). */
  after?: ClanEvent | null;
}

/** A clan event further away than this is a typo (an offset of 99999999 days would otherwise break every page that prints its date). */
const MAX_EVENT_AHEAD_MS = 2 * 365 * 86_400_000;

/** What `repeatDays` may be for an event of this length: one of REPEAT_DAYS, and the event is over before its next round starts. */
function checkRepeat(days: number | null, startsAt: number, endsAt: number | null): void {
  if (days === null) return;
  if (!isRepeatDays(days)) throw new UserError('An event can repeat every day, every week, every 2 weeks or every 4 weeks.');
  if (endsAt !== null && endsAt - startsAt >= days * 86_400_000) throw new UserError(`An event that repeats ${repeatText(days)} must be over before its next round starts. Shorten it or let it repeat less often.`);
}

export async function createClanEvent(ctx: AppContext, input: CreateEventInput): Promise<ClanEvent> {
  if (!Number.isFinite(input.startsAt) || input.startsAt <= Date.now()) throw new UserError('The event start time must be in the future.');
  if (input.startsAt > Date.now() + MAX_EVENT_AHEAD_MS) throw new UserError('The event start time is more than two years away. Check the date.');
  const endsAt = input.endsAt ?? null;
  if (endsAt !== null) {
    if (!Number.isFinite(endsAt) || endsAt <= input.startsAt) throw new UserError('The event must end after it starts.');
    if (endsAt - input.startsAt > MAX_EVENT_LENGTH_MS) throw new UserError('An event can last at most 30 days. Check the end time.');
  }
  const repeatDays = input.repeatDays ?? null;
  checkRepeat(repeatDays, input.startsAt, endsAt);
  const channel = await resolveAnnouncementChannel(ctx, input.channelId);
  const event = ctx.store.createEvent({
    guildId: ctx.config.DISCORD_GUILD_ID,
    title: input.title.slice(0, 200),
    description: input.description?.slice(0, 2000) ?? null,
    startsAt: input.startsAt,
    endsAt,
    createdBy: input.createdBy,
    repeatDays,
    after: input.after ?? null,
  });
  let message;
  try {
    message = await channel.send({ ...renderEvent(ctx, event), allowedMentions: { parse: [] } });
  } catch (err) {
    // An event nobody can see is no event: without this it would sit in the list, and a repeating one would count as posted.
    ctx.store.deleteEvent(event.id);
    throw err;
  }
  ctx.store.setEventMessage(event.id, channel.id, message.id);
  const link = `https://discord.com/channels/${ctx.config.DISCORD_GUILD_ID}/${channel.id}/${message.id}`;
  ctx.store.setDiscordEventId(event.id, await createDiscordEvent(ctx, event, link));
  // Nobody is pinged in the channel: the members who asked for new events get a DM with a link to the post.
  await notifyClanEvent(ctx, event, link).catch((err) => console.warn(`[events] could not DM event #${event.id} to its subscribers:`, (err as Error).message));
  return ctx.store.getEvent(event.id)!;
}

/** Without an end, the native Discord event is shown as this long (Discord requires an end for events outside a voice channel). */
const DEFAULT_DISCORD_EVENT_MS = 2 * 3_600_000;

/**
 * The same event as a native Discord scheduled event, so it shows at the top of the server with Discord's own "Interested" button and
 * reminders. Our post with its RSVP buttons stays the main one; a failure here (missing Manage Events) only logs.
 */
async function createDiscordEvent(ctx: AppContext, event: ClanEvent, link: string): Promise<string | null> {
  try {
    const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
    const created = await guild.scheduledEvents.create({
      name: event.title.slice(0, 100),
      description: `${event.description ? `${event.description.slice(0, 800)}\n\n` : ''}RSVP and details: ${link}`.slice(0, 1000),
      scheduledStartTime: new Date(event.startsAt),
      scheduledEndTime: new Date(event.endsAt ?? event.startsAt + DEFAULT_DISCORD_EVENT_MS),
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: 'In game' },
      reason: `Clan event #${event.id}`,
    });
    return created.id;
  } catch (err) {
    console.warn(`[events] could not create the Discord event for #${event.id}:`, (err as Error).message);
    return null;
  }
}

async function deleteDiscordEvent(ctx: AppContext, event: ClanEvent): Promise<void> {
  if (!event.discordEventId) return;
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID).catch(() => null);
  await guild?.scheduledEvents.delete(event.discordEventId).catch(() => {});
}

/** Re-renders an event's Discord message after RSVPs or status changes. Missing messages are ignored. */
export async function refreshEventMessage(ctx: AppContext, eventId: number): Promise<void> {
  const event = ctx.store.getEvent(eventId);
  if (!event?.channelId || !event.messageId) return;
  const channel = await getSendableChannel(ctx, event.channelId).catch(() => null);
  const message = await channel?.messages.fetch(event.messageId).catch(() => null);
  await message?.edit(renderEvent(ctx, event));
}

/** The newest round of the series an event belongs to (the event itself when nothing was posted after it). */
export function newestRound(ctx: Pick<AppContext, 'store'>, event: ClanEvent): ClanEvent {
  let newest = event;
  // A chain is as long as the series has run; the bound only guards against a loop in the data.
  for (let i = 0; i < 10_000 && newest.nextId !== null; i++) {
    const next = ctx.store.getEvent(newest.nextId);
    if (!next) break;
    newest = next;
  }
  return newest;
}

/**
 * Cancels one event. For a repeating event that is this round only: the next one is still posted when this one's time has passed.
 * `stopSeries` also ends the repetition, so nothing follows.
 */
export async function cancelClanEvent(ctx: AppContext, eventId: number, opts: { stopSeries?: boolean } = {}): Promise<ClanEvent> {
  const event = ctx.store.getEvent(eventId);
  if (!event || event.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError(`Event #${eventId} does not exist.`);
  if (event.cancelled) throw new UserError(`Event #${eventId} is already cancelled.`);
  ctx.store.cancelEvent(eventId);
  if (opts.stopSeries) {
    const newest = newestRound(ctx, event);
    ctx.store.setEventRepeat(newest.id, null);
    if (newest.id !== eventId) await refreshEventMessage(ctx, newest.id).catch(() => {});
  }
  await refreshEventMessage(ctx, eventId);
  await deleteDiscordEvent(ctx, event);
  return ctx.store.getEvent(eventId)!;
}

/**
 * Changes how often an event repeats, or stops it (null). It is the newest round of a series that carries the repetition on, so the
 * change is made there: the returned event is that round, which may be a later one than the event asked for.
 */
export async function setClanEventRepeat(ctx: AppContext, eventId: number, days: number | null): Promise<ClanEvent> {
  const asked = ctx.store.getEvent(eventId);
  if (!asked || asked.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError(`Event #${eventId} does not exist.`);
  const event = newestRound(ctx, asked);
  checkRepeat(days, event.startsAt, event.endsAt);
  if (event.repeatDays === days) throw new UserError(days === null ? `Event #${event.id} does not repeat.` : `Event #${event.id} already repeats ${repeatText(days)}.`);
  ctx.store.setEventRepeat(event.id, days);
  await refreshEventMessage(ctx, event.id).catch((err) => console.warn(`[events] could not redraw event #${event.id}:`, (err as Error).message));
  return ctx.store.getEvent(event.id)!;
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

export function renderLfg(ctx: AppContext, post: LfgPost, note: string | null = null): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const members = ctx.store.lfgMembers(post.id);
  const full = members.length >= post.size;
  const slots = [...members.map((id) => `<@${id}>`), ...Array(Math.max(post.size - members.length, 0)).fill('*open*')];
  const image = ctx.store.getActivity(post.activity)?.imageUrl;
  const description = [note, post.details].filter(Boolean).join('\n\n');
  const embed = new EmbedBuilder()
    .setColor(post.closed ? 0x6b7280 : full ? COLORS.success : COLORS.info)
    .setTitle(`${post.closed ? '🔒 ' : '🐀 '}LFG: ${post.activity}`)
    .setDescription(description || null)
    .addFields(
      { name: `Squad (${members.length}/${post.size})`, value: slots.map((s, i) => `${i + 1}. ${s}`).join('\n') },
      { name: 'Host', value: `<@${post.hostId}>`, inline: true },
      { name: 'Posted', value: discordTime(post.createdAt), inline: true },
      ...(!post.closed && post.expiresAt ? [{ name: 'Ends', value: discordTime(post.expiresAt), inline: true }] : []),
      ...(!post.closed && post.voiceChannelId
        ? [{ name: 'Voice', value: `<#${post.voiceChannelId}>\nJoin the squad to get in. The host must be in voice or the squad ends.`, inline: false }]
        : []),
    )
    .setFooter({ text: `${ctx.config.CLAN_NAME} · LFG #${post.id}`, iconURL: brandIcon(ctx) });
  if (image) embed.setThumbnail(image);
  if (post.closed) return { embeds: [embed], components: [] };
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`lfg:${post.id}:join`).setLabel('Join').setStyle(ButtonStyle.Success).setDisabled(full),
    new ButtonBuilder().setCustomId(`lfg:${post.id}:leave`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`lfg:${post.id}:close`).setLabel('Close').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}
