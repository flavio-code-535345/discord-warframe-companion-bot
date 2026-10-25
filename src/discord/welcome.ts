import { EmbedBuilder, type GuildMember } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { COLORS } from './embeds.js';
import { brandIcon } from './identity.js';

/** Greets a member in the /setup welcome channel, if one is set. Never throws. */
export async function postWelcome(ctx: AppContext, member: GuildMember): Promise<void> {
  const channelId = ctx.store.getSettings(member.guild.id).welcomeChannelId;
  if (!channelId) return;
  try {
    const channel = await getSendableChannel(ctx, channelId);
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle(`Welcome to ${ctx.config.CLAN_NAME}, Operator!`)
      .setDescription(
        `${ctx.config.BOT_NAME} is pleased to have you aboard.\n\n` +
          '• Link your Warframe name with `/clan register`\n' +
          '• See upcoming clan runs with `/event list`\n' +
          '• Find a squad with `/lfg`',
      )
      .setThumbnail(brandIcon(ctx) ?? null);
    await channel.send({ content: `${member}`, embeds: [embed], allowedMentions: { users: [member.id] } });
  } catch (err) {
    console.error('[discord] welcome message failed:', err);
  }
}
