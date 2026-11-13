import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';

/**
 * A note from Ordis to the staff: something happened to the bot itself that someone should know about (a setting that points at a
 * deleted channel, a one-time change of how something works). It goes to the status channel (`/setup status`), else the moderation
 * log. Never throws; false when there is nowhere to post it.
 */
export interface StaffNotice {
  title: string;
  text: string;
  /** 'warn' for something that needs a hand, 'info' for the rest. */
  tone?: 'warn' | 'info';
  fields?: { name: string; value: string }[];
}

export async function staffNotice(ctx: AppContext, notice: StaffNotice): Promise<boolean> {
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  // The status channel first; when that one can't be posted in (it may be the very channel that was just deleted), the moderation log.
  const channelIds = [...new Set([settings.statusChannelId, settings.modLogChannelId].filter((id): id is string => Boolean(id)))];
  if (!channelIds.length) {
    console.warn(`[staff] ${notice.title}: ${notice.text} (no status or moderation log channel to post it in)`);
    return false;
  }
  const embed = new EmbedBuilder()
    .setColor(notice.tone === 'warn' ? 0xf59e0b : 0x3b9ac7)
    .setTitle(notice.title.slice(0, 256))
    .setDescription(notice.text.slice(0, 4000))
    .setTimestamp();
  if (notice.fields?.length) embed.addFields(notice.fields.slice(0, 20).map((f) => ({ name: f.name.slice(0, 256), value: f.value.slice(0, 1024) || '—' })));
  for (const channelId of channelIds) {
    try {
      const channel = await getSendableChannel(ctx, channelId);
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return true;
    } catch (err) {
      console.warn(`[staff] could not post "${notice.title}" in ${channelId}:`, (err as Error).message);
    }
  }
  return false;
}
