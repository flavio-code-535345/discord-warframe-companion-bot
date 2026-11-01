import { EmbedBuilder, type GuildTextBasedChannel, type Message } from 'discord.js';
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

/** An embed for one of Ordis's own posts (the welcome guide, the rules), in the same look as his panels. */
export interface EmbedCard {
  title: string;
  description?: string | null;
  fields?: { name: string; value: string; inline?: boolean }[];
  /** The clan logo (Ordis's avatar) in the corner. */
  logo?: boolean;
  footer?: string | null;
}

/** Discord's limit on all the text of one embed together. */
const MAX_EMBED_CHARS = 6000;

/** Builds the embed, refusing anything Discord would reject. Pure. */
export function cardEmbed(card: EmbedCard, brand: { color: number; icon?: string | undefined }): EmbedBuilder {
  const fields = card.fields ?? [];
  const total = card.title.length + (card.description?.length ?? 0) + (card.footer?.length ?? 0) + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (total > MAX_EMBED_CHARS) throw new UserError(`The embed has ${total} characters; Discord allows ${MAX_EMBED_CHARS} in one embed.`);
  const embed = new EmbedBuilder().setColor(brand.color).setTitle(card.title);
  if (card.description) embed.setDescription(card.description.replace(/\r\n/g, '\n'));
  if (fields.length) embed.addFields(fields.map((f) => ({ name: f.name, value: f.value.replace(/\r\n/g, '\n'), inline: f.inline ?? false })));
  if (card.logo && brand.icon) embed.setThumbnail(brand.icon);
  if (card.footer) embed.setFooter({ text: card.footer, ...(brand.icon ? { iconURL: brand.icon } : {}) });
  return embed;
}

/** Turns one of the bot's own messages into an embed (optionally with a line of text above it). Returns the edited message. */
export async function editOwnMessageCard(channel: MessageChannel, messageId: string, embed: EmbedBuilder, botId: string, content = ''): Promise<Message> {
  if (content.length > MAX_MESSAGE_CHARS) throw new UserError(`The message is ${content.length} characters; Discord allows ${MAX_MESSAGE_CHARS}.`);
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) throw new UserError('That message no longer exists in that channel.');
  if (message.author.id !== botId) throw new UserError('Ordis can only edit messages he wrote himself.');
  return message.edit({ content: content.trim(), embeds: [embed], allowedMentions: { parse: [] } });
}
