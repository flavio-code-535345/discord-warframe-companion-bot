import { EmbedBuilder, type Message, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import type { Sticky } from '../db.js';
import { COLORS } from '../discord/embeds.js';
import { validImageUrl } from '../lfg/lifecycle.js';
import { UserError } from '../services/clan.js';

/**
 * Sticky messages. Instead of Discord's pins, Ordis keeps its own message as the last one in a channel: after
 * someone else talks it posts a fresh copy and deletes the old one.
 *
 * Reposts are debounced, so a burst of chat causes one repost, but never starved: under constant chat the sticky still
 * comes back at least every MAX_WAIT_MS. A "clean" sticky goes further and deletes everything other members post, so it
 * is the only thing in the channel and never needs reposting.
 */

export const STICKY_DEBOUNCE_MS = 3000;
export const STICKY_MAX_WAIT_MS = 15_000;
export const MAX_STICKY_LENGTH = 4000;
export const MAX_STICKY_TITLE = 200;

export function renderSticky(s: Pick<Sticky, 'title' | 'content'> & { imageUrl?: string | null }): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS.brand).setDescription(s.content).setFooter({ text: '📌 Pinned by Ordis' });
  if (s.title) embed.setTitle(s.title);
  if (s.imageUrl) embed.setImage(s.imageUrl);
  return embed;
}

/** The pictures of a sticky: up to two https links separated by spaces. */
export const stickyImages = (imageUrl: string | null | undefined): string[] => (imageUrl ?? '').split(/\s+/).filter(Boolean).slice(0, 2);

/** The sticky as Discord embeds: the message with its first picture, and a second picture in an embed of its own. */
export function renderStickyEmbeds(s: Pick<Sticky, 'title' | 'content'> & { imageUrl?: string | null }): EmbedBuilder[] {
  const [first, second] = stickyImages(s.imageUrl);
  const embeds = [renderSticky({ ...s, imageUrl: first ?? null })];
  if (second) embeds.push(new EmbedBuilder().setColor(COLORS.brand).setImage(second));
  return embeds;
}

export class StickyKeeper {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** When the first not-yet-answered message of a burst arrived, per channel. */
  private readonly waitingSince = new Map<string, number>();
  /** Channels being reposted right now, so Ordis's own new message doesn't trigger another repost. */
  private readonly busy = new Set<string>();

  constructor(
    private readonly ctx: Pick<AppContext, 'client' | 'store' | 'config'>,
    private readonly debounceMs = STICKY_DEBOUNCE_MS,
    private readonly maxWaitMs = STICKY_MAX_WAIT_MS,
  ) {}

  /** Call for every message in the server. Cheap when the channel has no sticky. */
  onMessage(message: Message): void {
    if (!message.inGuild() || message.guildId !== this.ctx.config.DISCORD_GUILD_ID) return;
    const sticky = this.ctx.store.getSticky(message.channelId);
    if (!sticky || message.id === sticky.messageId) return;
    const mine = message.author.id === this.ctx.client.user?.id;
    // The screenshot channel's instructions stay where they are: its screenshots and answers remove themselves, so nothing needs reposting.
    if (message.channelId === this.ctx.store.getSettings(this.ctx.config.DISCORD_GUILD_ID).ssRolesChannelId) return;

    if (sticky.deleteOthers) {
      // Clean channel: everything from other members goes at once, except staff (who need to be able to fix things).
      if (!mine && !message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) void message.delete().catch(() => {});
      return;
    }
    if (mine && this.busy.has(message.channelId)) return;

    const now = Date.now();
    const since = this.waitingSince.get(message.channelId) ?? now;
    this.waitingSince.set(message.channelId, since);
    clearTimeout(this.timers.get(message.channelId));
    const delay = Math.max(0, Math.min(this.debounceMs, since + this.maxWaitMs - now));
    this.timers.set(
      message.channelId,
      setTimeout(() => {
        this.timers.delete(message.channelId);
        this.waitingSince.delete(message.channelId);
        void this.refresh(message.channelId).catch((err) => console.warn('[sticky] repost failed:', (err as Error).message));
      }, delay),
    );
  }

  /** Posts the sticky at the bottom of its channel now and removes the previous copy. `force` reposts even if it is already last. */
  async refresh(channelId: string, force = false): Promise<void> {
    const sticky = this.ctx.store.getSticky(channelId);
    if (!sticky || this.busy.has(channelId)) return;
    this.busy.add(channelId);
    try {
      const channel = await this.ctx.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || !('send' in channel)) return;
      if (!force && sticky.messageId && 'lastMessageId' in channel && channel.lastMessageId === sticky.messageId) return;

      // Post the new copy first so the channel is never without it, then remove the old one.
      const sent = await channel.send({ embeds: renderStickyEmbeds(sticky), allowedMentions: { parse: [] } });
      this.ctx.store.setStickyMessage(channelId, sent.id);
      if (sticky.messageId) await channel.messages.delete(sticky.messageId).catch(() => {});
    } finally {
      this.busy.delete(channelId);
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.waitingSince.clear();
  }
}

let keeper: StickyKeeper | null = null;
export const stickyKeeper = (ctx: AppContext): StickyKeeper => (keeper ??= new StickyKeeper(ctx));

export interface StickyInput {
  channelId: string;
  content: string;
  title?: string | null;
  imageUrl?: string | null;
  deleteOthers?: boolean;
  userId: string;
}

/** Checks that a channel can carry a sticky (before a form is shown, and again when it is saved). */
export async function checkStickyChannel(ctx: AppContext, channelId: string, deleteOthers: boolean): Promise<void> {
  const s = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if (channelId === s.honeypotChannelId) throw new UserError('That is the honeypot trap channel. Nobody should write there.');
  if (deleteOthers && [s.chatChannelId, s.ssRolesChannelId, s.verifyChannelId, s.rivenChannelId].includes(channelId)) {
    throw new UserError('Ordis reads messages in that channel (chat or screenshots) before removing them, so clean mode is not available there. The screenshot channel already deletes everything itself.');
  }
  const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError('Pick a text channel of this server.');
}

/** Sets or replaces a channel's sticky and posts it right away. */
export async function saveSticky(ctx: AppContext, input: StickyInput): Promise<void> {
  const content = input.content.replace(/\\n/g, '\n').trim();
  const title = input.title?.trim() || null;
  const imageUrl = input.imageUrl?.trim() || null;
  if (!content) throw new UserError('The message is empty.');
  if (content.length > MAX_STICKY_LENGTH) throw new UserError(`That message is ${content.length} characters; the limit is ${MAX_STICKY_LENGTH}.`);
  if (title && title.length > MAX_STICKY_TITLE) throw new UserError(`The heading is over ${MAX_STICKY_TITLE} characters.`);
  if (imageUrl && (stickyImages(imageUrl).length !== imageUrl.split(/\s+/).filter(Boolean).length || !stickyImages(imageUrl).every((u) => validImageUrl(u)))) throw new UserError('The pictures must be direct https links (at most two, separated by a space).');
  const deleteOthers = input.deleteOthers ?? false;
  await checkStickyChannel(ctx, input.channelId, deleteOthers);

  // Replacing keeps the old copy's message id (the upsert doesn't touch it), so the repost below deletes it.
  ctx.store.setSticky({ channelId: input.channelId, guildId: ctx.config.DISCORD_GUILD_ID, title, content, imageUrl, deleteOthers, createdBy: input.userId });
  await stickyKeeper(ctx).refresh(input.channelId, true);
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
