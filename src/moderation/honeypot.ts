import { EmbedBuilder, type GuildMember, type Message, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { modLog, notifyUser } from './service.js';

export const HONEYPOT_ACTIONS = ['softban', 'ban', 'kick'] as const;
export type HoneypotAction = (typeof HONEYPOT_ACTIONS)[number];

/** Softban is the default: it clears the spammer's recent messages everywhere, but a real member can rejoin. */
export const DEFAULT_HONEYPOT_ACTION: HoneypotAction = 'softban';
const DELETE_SECONDS = 3600;

export const honeypotAction = (stored: string | null): HoneypotAction =>
  HONEYPOT_ACTIONS.find((a) => a === stored) ?? DEFAULT_HONEYPOT_ACTION;

const STAFF_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
];

/** Staff and the owner are never trapped, and neither is anyone Ordis couldn't remove anyway. */
export function isHoneypotExempt(member: GuildMember, me: GuildMember, ownerId: string): boolean {
  if (member.id === ownerId || member.id === me.id) return true;
  if (member.permissions.any(STAFF_PERMISSIONS)) return true;
  return member.roles.highest.position >= me.roles.highest.position;
}

const WHAT_HAPPENED: Record<HoneypotAction, string> = {
  softban: 'you were removed from the server (you can rejoin with an invite) because you posted in the honeypot channel, which only spam bots and hacked accounts touch. If your account was hacked, change your password and enable 2FA first.',
  ban: 'you were banned because you posted in the honeypot channel, which only spam bots and hacked accounts touch. If this was a mistake, ask a moderator to unban you.',
  kick: 'you were removed from the server (you can rejoin with an invite) because you posted in the honeypot channel, which only spam bots and hacked accounts touch. If your account was hacked, change your password and enable 2FA first.',
};

/** Handles a message in the honeypot channel. Returns true when the message was in the trap (handled or exempt). */
export async function handleHoneypotMessage(message: Message, ctx: AppContext): Promise<boolean> {
  const { client, config, store } = ctx;
  if (!message.inGuild() || message.guildId !== config.DISCORD_GUILD_ID || message.author.bot) return false;
  const settings = store.getSettings(config.DISCORD_GUILD_ID);
  if (!settings.honeypotChannelId || message.channelId !== settings.honeypotChannelId) return false;

  const guild = message.guild;
  const [member, me] = await Promise.all([
    message.member ?? guild.members.fetch(message.author.id).catch(() => null),
    guild.members.fetchMe(),
  ]);
  if (!member || isHoneypotExempt(member, me, guild.ownerId)) return true;

  const action = honeypotAction(settings.honeypotAction);
  const content = message.content ? message.content.slice(0, 300) : message.attachments.size ? `[${message.attachments.size} attachment(s)]` : '[no text]';
  const reason = 'Honeypot: posted in the trap channel';

  await message.delete().catch(() => {});
  // DM first: once the member is gone Ordis may no longer share a server with them.
  const notified = await notifyUser(message.author, guild, WHAT_HAPPENED[action]);
  try {
    if (action === 'kick') {
      await guild.members.kick(member.id, reason);
    } else {
      await guild.members.ban(member.id, { reason, deleteMessageSeconds: DELETE_SECONDS });
      if (action === 'softban') {
        await guild.members.unban(member.id, 'Honeypot softban: ban only clears recent messages').catch(async (err) => {
          // The DM promised the member could rejoin: tell the moderators that the ban is still in place.
          console.warn('[honeypot] could not unban', member.id, (err as Error).message);
          await modLog(ctx, { action: 'Honeypot', moderator: client.user!, target: message.author, reason: `Banned but the unban failed (${(err as Error).message}): unban them by hand.` });
        });
      }
    }
  } catch (err) {
    console.warn('[honeypot] could not remove', member.id, (err as Error).message);
    await modLog(ctx, {
      action: 'Honeypot',
      moderator: client.user!,
      target: message.author,
      reason: `Could not ${action}: ${(err as Error).message}`,
      fields: [{ name: 'Message', value: content }],
    });
    return true;
  }
  await modLog(ctx, {
    action: 'Honeypot',
    moderator: client.user!,
    target: message.author,
    reason: `${action}: ${reason}`,
    fields: [
      { name: 'Message', value: content },
      { name: 'DM sent', value: notified ? 'yes' : 'no (DMs closed)' },
    ],
  });
  return true;
}

/** Points the honeypot at a channel and posts the "do not post here" notice in it. */
export async function setupHoneypot(ctx: AppContext, channelId: string, action: HoneypotAction): Promise<void> {
  const channel = await getSendableChannel(ctx, channelId);
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if (channelId === settings.chatChannelId || channelId === settings.verifyChannelId) {
    throw new UserError("That channel is used for chat or verification. Pick a channel nobody should ever write in.");
  }
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { honeypotChannelId: channelId, honeypotAction: action });
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: ctx.config.BOT_NAME, iconURL: brandIcon(ctx) })
    .setTitle('🍯 Do not post in this channel')
    .setDescription('This is a trap for spam bots and hacked accounts. Anyone who writes here is removed from the server automatically. Just leave it alone.');
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

export function disableHoneypot(ctx: AppContext): void {
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { honeypotChannelId: null });
}
