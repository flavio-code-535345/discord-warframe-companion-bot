import { EmbedBuilder, type Message, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import type { Sticky } from '../db.js';
import { COLORS } from '../discord/embeds.js';
import { UserError } from '../services/clan.js';

/**
 * Sticky messages: instead of Discord's pins, Ordis keeps its own message as the last one in the channel. After
 * anyone else talks it posts a fresh copy and deletes the old one. Reposts are debounced, so a burst of chat
 * causes one repost, not one per message (and stays well inside Discord's rate limits).
 */

export const STICKY_DEBOUNCE_MS = 3000;
export const MAX_STICKY_LENGTH = 4000;

export function renderSticky(s: Pick<Sticky, 'title' | 'content'>): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS.brand).setDescription(s.content).setFooter({ text: '📌 Sticky message' });
  if (s.title) embed.setTitle(s.title);
  return embed;
}

export class StickyKeeper {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Channels being reposted right now, so Ordis's own new message doesn't trigger another repost. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly ctx: Pick<AppContext, 'client' | 'store' | 'config'>,
    private readonly debounceMs = STICKY_DEBOUNCE_MS,
  ) {}

  /** Call for every message in the server. Cheap when the channel has no sticky. */
  onMessage(message: Message): void {
    if (!message.inGuild() || message.guildId !== this.ctx.config.DISCORD_GUILD_ID) return;
    const sticky = this.ctx.store.getSticky(message.channelId);
    if (!sticky || message.id === sticky.messageId) return;
    // Clean mode: anything from other members goes at once, except staff (who can fix the channel). No repost is needed.
    if (sticky.deleteOthers) {
      if (message.author.id !== this.ctx.client.user?.id && !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) void message.delete().catch(() => {});
      return;
    }
    if (this.busy.has(message.channelId) && message.author.id === this.ctx.client.user?.id) return;
    clearTimeout(this.timers.get(message.channelId));
    this.timers.set(
      message.channelId,
      setTimeout(() => {
        this.timers.delete(message.channelId);
        void this.refresh(message.channelId).catch((err) => console.warn('[sticky] repost failed:', (err as Error).message));
      }, this.debounceMs),
    );
  }

  /** Posts the sticky at the bottom of its channel now and removes the previous copy. */
  async refresh(channelId: string, force = false): Promise<void> {
    const sticky = this.ctx.store.getSticky(channelId);
    if (!sticky || this.busy.has(channelId)) return;
    this.busy.add(channelId);
    try {
      const channel = await this.ctx.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;
      // Already the last message (for example after a restart, or when someone deleted theirs): nothing to do.
      if (!force && sticky.messageId && 'lastMessageId' in channel && channel.lastMessageId === sticky.messageId) return;

      // Post the new copy first so the channel is never without it, then remove the old one.
      const sent = await channel.send({ embeds: [renderSticky(sticky)], allowedMentions: { parse: [] } });
      this.ctx.store.setStickyMessage(channelId, sent.id);
      if (sticky.messageId) await channel.messages.delete(sticky.messageId).catch(() => {});
    } finally {
      this.busy.delete(channelId);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

let keeper: StickyKeeper | null = null;
export const stickyKeeper = (ctx: AppContext): StickyKeeper => (keeper ??= new StickyKeeper(ctx));

/** Sets (or replaces) a channel's sticky and posts it right away. */
export async function setSticky(ctx: AppContext, channelId: string, content: string, title: string | null, userId: string, deleteOthers = false): Promise<void> {
  const text = content.replace(/\\n/g, '\n').trim();
  if (!text) throw new UserError('The message is empty.');
  if (text.length > MAX_STICKY_LENGTH) throw new UserError(`That message is ${text.length} characters; the limit is ${MAX_STICKY_LENGTH}.`);
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if (channelId === settings.honeypotChannelId) throw new UserError('That is the honeypot trap channel. Nobody should write there.');
  if (deleteOthers && [settings.chatChannelId, settings.ssRolesChannelId, settings.verifyChannelId].includes(channelId)) {
    throw new UserError('Ordis reads messages in that channel (chat or screenshots) before they are removed, so clean mode is not available there. The screenshot channel already deletes everything itself.');
  }
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError('Pick a text channel of this server.');

  const previous = ctx.store.getSticky(channelId);
  ctx.store.setSticky({ channelId, guildId: ctx.config.DISCORD_GUILD_ID, title: title?.trim() || null, content: text, createdBy: userId, deleteOthers });
  // A replaced sticky keeps its old message id so the refresh deletes it; the new text always gets posted.
  if (previous?.messageId) ctx.store.setStickyMessage(channelId, previous.messageId);
  // The old copy might already be the last message, but the text changed, so always repost.
  await stickyKeeper(ctx).refresh(channelId, true);
}

/** Removes a channel's sticky and deletes its last copy. Returns false when the channel had none. */
export async function removeSticky(ctx: AppContext, channelId: string): Promise<boolean> {
  const sticky = ctx.store.getSticky(channelId);
  if (!sticky) return false;
  ctx.store.removeSticky(channelId);
  if (sticky.messageId) {
    const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased() && 'messages' in channel) await channel.messages.delete(sticky.messageId).catch(() => {});
  }
  return true;
}
