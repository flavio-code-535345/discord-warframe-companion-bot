import type { GuildTextBasedChannel, Message } from 'discord.js';
import { UserError } from '../services/clan.js';

/**
 * Editing Ordis's own messages (a rules post, a role guide, a channel description he wrote). Used by the `edit_message` MCP tool
 * and by the admin panel's Messages page. Discord only lets a bot edit what it wrote itself, so anything else is refused with
 * a clear message instead of a raw API error. Mentions never ping: editing text cannot summon anyone.
 */

export const MAX_MESSAGE_CHARS = 2000;

/** The part of a text channel these functions use. */
export type MessageChannel = Pick<GuildTextBasedChannel, 'messages'>;

/** The bot's own messages in a channel, newest first. */
export async function ownMessages(channel: MessageChannel, botId: string, limit = 50): Promise<Message[]> {
  const batch = await channel.messages.fetch({ limit });
  return [...batch.values()].filter((m) => m.author.id === botId);
}

/** Replaces the text of one of the bot's own messages (its embeds and attachments stay). Returns the edited message. */
export async function editOwnMessage(channel: MessageChannel, messageId: string, content: string, botId: string): Promise<Message> {
  const text = content.replace(/\r\n/g, '\n').trim();
  if (!text) throw new UserError('The message cannot be empty.');
  if (text.length > MAX_MESSAGE_CHARS) throw new UserError(`The message is ${text.length} characters; Discord allows ${MAX_MESSAGE_CHARS}.`);
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) throw new UserError('That message no longer exists in that channel.');
  if (message.author.id !== botId) throw new UserError('Ordis can only edit messages he wrote himself. Edit this one in Discord, or repost it with the post_message tool.');
  return message.edit({ content: text, allowedMentions: { parse: [] } });
}
