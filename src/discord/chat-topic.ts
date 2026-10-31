import { ChannelType } from 'discord.js';
import type { AppContext } from '../context.js';

/** The chat channel's description: what Ordis does there, so members know how to use it. Kept under Discord's 1024-character limit. */
export const CHAT_TOPIC =
  'Ask Ordis about Warframe: prices, drops, items, Baro, fissures, the Circuit, or anything on the wiki. He answers from live data and links the wiki pages, nothing made up.';

/** The description the bot last wrote to a channel, so it can tell its own text from one staff wrote by hand. */
const writtenKey = (channelId: string) => `chat_topic_written:${channelId}`;

/**
 * Keeps the Ordis chat channel's description in line with how the channel works, without undoing a hand edit: the description
 * is only replaced when it is empty or still the text the bot wrote last time (so a new CHAT_TOPIC arrives on its own), never
 * when someone changed it in Discord. Only writes when it differs (Discord limits topic edits to a couple per ten minutes),
 * only when the bot can actually read every message there, and never throws: a missing Manage Channels permission just
 * leaves the description as it is.
 */
export async function syncChatTopic(ctx: AppContext): Promise<void> {
  const { client, config, store } = ctx;
  if (!config.ENABLE_MESSAGE_CONTENT) return;
  const id = store.getSettings(config.DISCORD_GUILD_ID).chatChannelId;
  if (!id) return;
  try {
    const channel = await client.channels.fetch(id);
    if (!channel || channel.type !== ChannelType.GuildText) return;
    const current = channel.topic ?? '';
    if (current === CHAT_TOPIC) {
      store.setMeta(writtenKey(id), CHAT_TOPIC);
      return;
    }
    if (current.trim() && current !== store.getMeta(writtenKey(id))) return;
    await channel.setTopic(CHAT_TOPIC, 'Ordis chat channel description');
    store.setMeta(writtenKey(id), CHAT_TOPIC);
  } catch (err) {
    console.warn('[chat] could not update the chat channel description:', err instanceof Error ? err.message : err);
  }
}
