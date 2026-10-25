import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  OverwriteType,
  PermissionFlagsBits,
  type User,
} from 'discord.js';
import type { AppContext } from '../context.js';
import type { LockPrevious } from '../db.js';
import { UserError, getSendableChannel } from '../services/clan.js';

export interface ModContext {
  guild: Guild;
  moderator: GuildMember;
  me: GuildMember;
}

export async function modContext(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<ModContext> {
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  const [moderator, me] = await Promise.all([guild.members.fetch(interaction.user.id), guild.members.fetchMe()]);
  return { guild, moderator, me };
}

/** Blocks acting on yourself, the owner, the bot, or anyone whose top role isn't below both yours and Ordis's. */
export function assertCanAct(m: ModContext, target: GuildMember, action: string): void {
  if (target.id === m.moderator.id) throw new UserError(`You can't ${action} yourself.`);
  if (target.id === m.guild.ownerId) throw new UserError(`You can't ${action} the server owner.`);
  if (target.id === m.me.id) throw new UserError(`Ordis declines to ${action} itself, Operator.`);
  if (m.moderator.id !== m.guild.ownerId && target.roles.highest.position >= m.moderator.roles.highest.position) {
    throw new UserError(`${target.displayName}'s top role is at or above yours, so you can't ${action} them.`);
  }
  if (target.roles.highest.position >= m.me.roles.highest.position) {
    throw new UserError(`${target.displayName}'s top role is at or above Ordis's role. Move Ordis's role higher to ${action} them.`);
  }
}

export const auditReason = (moderator: User, reason: string | null) => `${moderator.username}: ${reason ?? 'no reason given'}`.slice(0, 512);

/** Tells the member what happened; returns false when their DMs are closed. */
export async function notifyUser(user: User, guild: Guild, text: string): Promise<boolean> {
  return user
    .send(`**${guild.name}:** ${text}`)
    .then(() => true)
    .catch(() => false);
}

const ACTION_STYLE: Record<string, { emoji: string; color: number }> = {
  Warn: { emoji: '⚠️', color: 0xf59e0b },
  Timeout: { emoji: '🔇', color: 0xf97316 },
  'Timeout removed': { emoji: '🔊', color: 0x22c55e },
  Kick: { emoji: '👢', color: 0xef4444 },
  Ban: { emoji: '🔨', color: 0xb91c1c },
  Unban: { emoji: '🕊️', color: 0x22c55e },
  Purge: { emoji: '🧹', color: 0x3b9ac7 },
  Lock: { emoji: '🔒', color: 0x6b7280 },
  Unlock: { emoji: '🔓', color: 0x22c55e },
  Slowmode: { emoji: '🐢', color: 0x3b9ac7 },
  'Warnings cleared': { emoji: '🧽', color: 0x22c55e },
  'Backup restored': { emoji: '♻️', color: 0x3b9ac7 },
  Verified: { emoji: '✅', color: 0x22c55e },
  'Admin panel': { emoji: '🖥️', color: 0x3b9ac7 },
  'Verification failed': { emoji: '🚫', color: 0xf59e0b },
};

export interface ModLogEntry {
  action: keyof typeof ACTION_STYLE;
  moderator: User;
  target?: User;
  reason?: string | null;
  fields?: { name: string; value: string }[];
}

/** Posts a moderation record to the /setup modlog channel, if one is set. Never throws. */
export async function modLog(ctx: AppContext, entry: ModLogEntry): Promise<void> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).modLogChannelId;
  if (!channelId) return;
  const style = ACTION_STYLE[entry.action]!;
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.emoji} ${entry.action}`)
    .addFields(
      ...(entry.target ? [{ name: 'Member', value: `${entry.target} · ${entry.target.username} · \`${entry.target.id}\``, inline: false }] : []),
      { name: 'Moderator', value: `${entry.moderator}`, inline: true },
      ...(entry.reason !== undefined ? [{ name: 'Reason', value: (entry.reason || '—').slice(0, 1024), inline: true }] : []),
      ...(entry.fields ?? []).map((f) => ({ ...f, inline: true })),
    )
    .setTimestamp();
  try {
    const channel = await getSendableChannel(ctx, channelId);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('[mod] could not write to the mod log:', (err as Error).message);
  }
}

const sendState = (allow: boolean, deny: boolean): LockPrevious => (allow ? 'allow' : deny ? 'deny' : 'neutral');

/**
 * Stops members from sending in a channel: @everyone and every role overwrite that allowed sending get
 * SendMessages denied. Roles with Administrator or Manage Messages (moderators) keep their access. The previous
 * state of each overwrite is stored so unlockChannel can restore it exactly.
 */
export async function lockChannel(ctx: AppContext, channel: GuildTextBasedChannel, reason: string): Promise<number> {
  if (!('permissionOverwrites' in channel)) throw new UserError('This kind of channel cannot be locked.');
  if (ctx.store.isLocked(channel.id)) throw new UserError(`#${channel.name} is already locked.`);
  const guild = channel.guild;
  const previous: Record<string, LockPrevious> = {};
  const everyone = channel.permissionOverwrites.cache.get(guild.id);
  previous[guild.id] = sendState(everyone?.allow.has(PermissionFlagsBits.SendMessages) ?? false, everyone?.deny.has(PermissionFlagsBits.SendMessages) ?? false);
  for (const o of channel.permissionOverwrites.cache.values()) {
    if (o.type !== OverwriteType.Role || o.id === guild.id || !o.allow.has(PermissionFlagsBits.SendMessages)) continue;
    const role = guild.roles.cache.get(o.id);
    if (role?.permissions.any([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageMessages])) continue;
    previous[o.id] = 'allow';
  }
  for (const targetId of Object.keys(previous)) {
    await channel.permissionOverwrites.edit(targetId, { SendMessages: false }, { reason, type: OverwriteType.Role });
  }
  ctx.store.saveLock(channel.id, previous);
  return Object.keys(previous).length;
}

export async function unlockChannel(ctx: AppContext, channel: GuildTextBasedChannel, reason: string): Promise<number> {
  if (!('permissionOverwrites' in channel)) throw new UserError('This kind of channel cannot be unlocked.');
  const previous = ctx.store.takeLock(channel.id);
  const targets = Object.entries(previous);
  if (!targets.length) throw new UserError(`#${channel.name} isn't locked by Ordis.`);
  const value = { allow: true, deny: false, neutral: null } as const;
  for (const [targetId, state] of targets) {
    await channel.permissionOverwrites.edit(targetId, { SendMessages: value[state] }, { reason, type: OverwriteType.Role });
  }
  return targets.length;
}
