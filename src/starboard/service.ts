import { EmbedBuilder, type Message, type MessageReaction, type PartialMessageReaction, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';

/**
 * Starboard (/setup starboard): a message that collects enough ⭐ reactions is re-posted to the starboard channel, and the count on that
 * copy follows later stars. Only messages from channels @everyone can read are copied, so nothing from staff channels is ever shown, and
 * Ordis's own messages and the starboard itself are skipped. The starboard table maps each original to its copy.
 */

export const STAR = '⭐';
export const DEFAULT_THRESHOLD = 3;

export interface StarSource {
  authorName: string;
  authorAvatar: string | null;
  content: string;
  imageUrl: string | null;
  channelId: string;
  url: string;
  createdAt: number;
}

/** The copy on the starboard. Pure. */
export function starPost(src: StarSource, stars: number): { content: string; embeds: EmbedBuilder[] } {
  const embed = new EmbedBuilder()
    .setColor(0xf5c518)
    .setAuthor({ name: src.authorName, ...(src.authorAvatar ? { iconURL: src.authorAvatar } : {}) })
    .setDescription(`${src.content.slice(0, 3900)}${src.content ? '\n\n' : ''}[Jump to the message](${src.url})`)
    .setTimestamp(src.createdAt);
  if (src.imageUrl) embed.setImage(src.imageUrl);
  return { content: `${STAR} **${stars}** · <#${src.channelId}>`, embeds: [embed] };
}

function sourceOf(message: Message<true>): StarSource {
  const image = message.attachments.find((a) => a.contentType?.startsWith('image/'))?.url ?? message.embeds.find((e) => e.image)?.image?.url ?? null;
  return {
    authorName: message.member?.displayName ?? message.author.username,
    authorAvatar: message.author.displayAvatarURL(),
    content: message.content,
    imageUrl: image,
    channelId: message.channelId,
    url: message.url,
    createdAt: message.createdTimestamp,
  };
}

/** Reactions on one message are handled one after another, so two stars arriving together can't post two copies. */
const queues = new Map<string, Promise<void>>();

/** Runs on every reaction added or removed; only ⭐ matters. Never throws. */
export function handleStarReaction(reaction: MessageReaction | PartialMessageReaction, ctx: AppContext): Promise<void> {
  if (reaction.emoji.name !== STAR) return Promise.resolve();
  const id = reaction.message.id;
  const next = (queues.get(id) ?? Promise.resolve()).then(() => updateStar(reaction, ctx));
  queues.set(id, next);
  void next.finally(() => {
    if (queues.get(id) === next) queues.delete(id);
  });
  return next;
}

async function updateStar(reaction: MessageReaction | PartialMessageReaction, ctx: AppContext): Promise<void> {
  try {
    const full = reaction.partial ? await reaction.fetch() : reaction;
    const message = full.message.partial ? await full.message.fetch() : full.message;
    if (!message.inGuild() || message.guildId !== ctx.config.DISCORD_GUILD_ID || message.author.bot) return;
    const settings = ctx.store.getSettings(message.guildId);
    if (!settings.starboardChannelId || message.channelId === settings.starboardChannelId) return;
    if (!message.channel.permissionsFor(message.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) return;
    if ('nsfw' in message.channel && message.channel.nsfw) return;
    const stars = full.count ?? 0;
    const saved = ctx.store.getStar(message.id);
    const threshold = settings.starboardThreshold ?? DEFAULT_THRESHOLD;
    if (!saved?.starMessageId && stars < threshold) return;
    const board = await getSendableChannel(ctx, settings.starboardChannelId);
    const post = starPost(sourceOf(message), stars);
    if (saved?.starMessageId) {
      const copy = await board.messages.fetch(saved.starMessageId).catch(() => null);
      await copy?.edit(post);
      ctx.store.putStar({ messageId: message.id, guildId: message.guildId, channelId: message.channelId, starMessageId: saved.starMessageId, stars });
      return;
    }
    const sent = await board.send({ ...post, allowedMentions: { parse: [] } });
    ctx.store.putStar({ messageId: message.id, guildId: message.guildId, channelId: message.channelId, starMessageId: sent.id, stars });
  } catch (err) {
    console.warn('[starboard] reaction not handled:', (err as Error).message);
  }
}
