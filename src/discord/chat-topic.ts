import { ChannelType } from 'discord.js';
import type { AppContext } from '../context.js';

/** The chat channel's description: what Ordis does there, so members know they can simply write. Kept under Discord's 1024-character limit. */
export const CHAT_TOPIC =
  'Ask Ordis anything about Warframe: no question mark needed, just write. He remembers your last messages, so follow-ups work, or reply to an answer to carry on. Wrong answer? Reply with the right one: admins fix him at once, other replies go to the admins to approve.';

/**
 * Keeps the Ordis chat channel's description in line with how the channel works. Only writes when it differs (Discord limits
 * topic edits to a couple per ten minutes), only when the bot can actually read every message there, and never throws: a
 * missing Manage Channels permission just leaves the description as it is.
 */
export async function syncChatTopic(ctx: AppContext): Promise<void> {
  const { client, config, store } = ctx;
  if (!config.ENABLE_MESSAGE_CONTENT) return;
  const id = store.getSettings(config.DISCORD_GUILD_ID).chatChannelId;
  if (!id) return;
  try {
    const channel = await client.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildText || channel.topic === CHAT_TOPIC) return;
    await channel.setTopic(CHAT_TOPIC, 'Ordis chat channel description');
  } catch (err) {
    console.warn('[chat] could not update the chat channel description:', err instanceof Error ? err.message : err);
  }
}
