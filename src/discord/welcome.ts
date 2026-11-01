import { ChannelType, EmbedBuilder, type GuildMember } from 'discord.js';
import type { AppContext } from '../context.js';
import type { GuildSettings } from '../db.js';
import { getSendableChannel } from '../services/clan.js';
import { COLORS } from './embeds.js';

/** Where a new member should go first; channels that aren't set up (or can't be found) are left out. */
export interface WelcomeChannels {
  rules: string | null;
  guide: string | null;
  ssRoles: string | null;
  chat: string | null;
}

/** The greeting's text, pure. */
export function welcomeText(botName: string, ch: WelcomeChannels): string {
  const steps = [
    ch.rules ? `📜 Read the <#${ch.rules}>, they're short` : null,
    ch.guide ? `👋 <#${ch.guide}> shows where everything lives, plus the clan ranks and levels` : null,
    ch.ssRoles ? `🖼️ Post your Warframe profile screenshot in <#${ch.ssRoles}> and ${botName} gives you your MR and clan roles` : null,
    ch.chat ? `📖 Ask ${botName} about prices, drops, Baro or anything on the wiki in <#${ch.chat}>` : null,
    '🔍 Find a squad with `/lfg`',
  ].filter(Boolean);
  return `${botName} is pleased to have you aboard, Tenno. To get settled:\n\n${steps.map((s) => `• ${s}`).join('\n')}`;
}

/** The rules and guide channels have no setting of their own, so they are found by name ("📜┃rules", "👋┃welcome"). */
function channelsOf(member: GuildMember, s: GuildSettings): WelcomeChannels {
  const byName = (re: RegExp) => member.guild.channels.cache.find((c) => c.type === ChannelType.GuildText && re.test(c.name))?.id ?? null;
  const guide = byName(/welcome/i);
  return { rules: byName(/rules/i), guide: guide === s.welcomeChannelId ? null : guide, ssRoles: s.ssRolesChannelId, chat: s.chatChannelId };
}

/** Greets a member in the /setup welcome channel, if one is set. Never throws; true when the greeting was posted. */
export async function postWelcome(ctx: AppContext, member: GuildMember): Promise<boolean> {
  const settings = ctx.store.getSettings(member.guild.id);
  if (!settings.welcomeChannelId) return false;
  try {
    const channel = await getSendableChannel(ctx, settings.welcomeChannelId);
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`Welcome to ${ctx.config.CLAN_NAME}, ${member.displayName}!`)
      .setDescription(welcomeText(ctx.config.BOT_NAME, channelsOf(member, settings)))
      .setThumbnail(member.displayAvatarURL());
    await channel.send({ content: `${member}`, embeds: [embed], allowedMentions: { users: [member.id] } });
    return true;
  } catch (err) {
    console.error('[discord] welcome message failed:', err);
    return false;
  }
}
