import type { EmbedBuilder, Message } from 'discord.js';
import type { AppContext } from '../context.js';
import { rivenCompactEmbed } from '../discord/riven-embeds.js';
import { QueueFullError, screenshotQueue } from '../queue.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { type ScanResult, scanCard } from './scan.js';

/**
 * The riven channel (/setup rivens): members post screenshots of their rivens and Ordis answers each one with a short grade card.
 * Nothing is deleted or stored: the picture only lives in memory while it is read, and the member's message stays where it is.
 * Messages without a PNG/JPEG picture are left alone, so people can still talk in the channel.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);
const MAX_IMAGES = 3;
const SCAN_LIMIT_MS = 90_000;
const WORKING = '🔎';
const WAITING = '⏳';

/** One finished scan, kept in memory for the admin panel (never the picture). */
export interface ScanLogEntry {
  at: number;
  via: 'channel' | 'command' | 'panel';
  userName: string;
  weapon: string | null;
  letter: string | null;
  ms: number;
  ok: boolean;
  note: string | null;
}

const LOG_SIZE = 40;
const log: ScanLogEntry[] = [];
const totals = { scans: 0, graded: 0, failed: 0 };

export function recordScan(entry: Omit<ScanLogEntry, 'at'>): void {
  log.unshift({ at: Date.now(), ...entry });
  log.length = Math.min(log.length, LOG_SIZE);
  totals.scans++;
  if (entry.letter) totals.graded++;
  else totals.failed++;
}

export const scanLog = (): ScanLogEntry[] => [...log];
export const scanTotals = (): { scans: number; graded: number; failed: number } => ({ ...totals });

export function recordResult(via: ScanLogEntry['via'], userName: string, r: ScanResult): void {
  recordScan({ via, userName, weapon: r.reading.weapon?.name ?? null, letter: r.report?.grade?.letter ?? null, ms: r.ms, ok: Boolean(r.report?.grade), note: r.report?.grade ? null : (r.problem ?? (r.report ? 'too few listings' : 'unreadable')) });
}

const mimeOf = (contentType: string | null) => (contentType ?? '').split(';')[0]!.trim();

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new UserError("I couldn't download that image.");
  return new Uint8Array(await res.arrayBuffer());
}

/** Handles a message in the riven channel. Returns true when the message was a riven screenshot post that this handled. */
export async function handleRivenMessage(message: Message, ctx: AppContext, scan: typeof scanCard = scanCard): Promise<boolean> {
  const { config, store } = ctx;
  if (!message.inGuild() || message.guildId !== config.DISCORD_GUILD_ID || message.author.bot) return false;
  const channelId = store.getSettings(config.DISCORD_GUILD_ID).rivenChannelId;
  if (!channelId || message.channelId !== channelId) return false;

  const images = [...message.attachments.filter((a) => IMAGE_TYPES.has(mimeOf(a.contentType)) && a.size <= MAX_IMAGE_BYTES).values()].slice(0, MAX_IMAGES);
  if (!images.length) return false;

  const clearReactions = async () => {
    const me = ctx.client.user?.id;
    if (!me) return;
    for (const emoji of [WORKING, WAITING]) await message.reactions.cache.get(emoji)?.users.remove(me).catch(() => {});
  };

  let ticket: ReturnType<typeof screenshotQueue.join>;
  try {
    ticket = screenshotQueue.join(message.author.id, () => {});
  } catch (err) {
    if (!(err instanceof QueueFullError)) throw err;
    await message.reply({ content: err.reason === 'user' ? '⏳ Two of your rivens are already waiting.' : '⏳ Too many are waiting, try again in a few minutes.' }).catch(() => {});
    return true;
  }
  await message.react(ticket.position() > 0 ? WAITING : WORKING).catch(() => {});
  const downloads = Promise.all(images.map(async (image) => ({ bytes: await download(image.url), mime: mimeOf(image.contentType) })));
  downloads.catch(() => {});

  try {
    await ticket.ready;
    if (ticket.position() === 0) {
      await clearReactions();
      await message.react(WORKING).catch(() => {});
    }
    const embeds: EmbedBuilder[] = [];
    await Promise.race([
      (async () => {
        for (const { bytes, mime } of await downloads) {
          const result = await scan(ctx, bytes, mime);
          recordResult('channel', message.author.username, result);
          embeds.push(rivenCompactEmbed(result));
        }
      })(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new UserError("That took too long, so I gave up.")), SCAN_LIMIT_MS).unref()),
    ]);
    await message.reply({ embeds, allowedMentions: { repliedUser: false } });
  } catch (err) {
    if (!(err instanceof UserError)) console.error('[riven] channel scan failed:', err instanceof Error ? err.message : err);
    recordScan({ via: 'channel', userName: message.author.username, weapon: null, letter: null, ms: 0, ok: false, note: err instanceof Error ? err.message : 'error' });
    await message.reply({ content: `❌ ${err instanceof UserError ? err.message : 'Something went wrong reading that.'}`, allowedMentions: { repliedUser: false } }).catch(() => {});
  } finally {
    ticket.release();
    await clearReactions();
  }
  return true;
}

/** Points riven scanning at a channel and posts a one-line pinned-style note there. */
export async function setupRivenChannel(ctx: AppContext, channelId: string): Promise<void> {
  const channel = await getSendableChannel(ctx, channelId);
  const s = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if ([s.chatChannelId, s.honeypotChannelId, s.verifyChannelId, s.ssRolesChannelId].includes(channelId)) {
    throw new UserError('That channel is used for something else. Pick a channel just for rivens.');
  }
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { rivenChannelId: channelId });
  await channel.send('🎲 Post a screenshot of your unveiled riven here and I will grade it.').catch(() => {});
}

export function disableRivenChannel(ctx: AppContext): void {
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { rivenChannelId: null });
}
