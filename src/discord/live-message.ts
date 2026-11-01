import type { MessageCreateOptions } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';

/**
 * A message Ordis keeps up to date in place (the role menu, the research board): where it is lives in bot_meta under `key`, posting it
 * again moves it (the old copy is deleted), and an edit of a message someone deleted just forgets it.
 */
export interface LiveRef {
  channelId: string;
  messageId: string;
}

export function readLive(ctx: Pick<AppContext, 'store'>, key: string): LiveRef | null {
  try {
    const p = JSON.parse(ctx.store.getMeta(key) || 'null') as Partial<LiveRef> | null;
    return p && typeof p.channelId === 'string' && typeof p.messageId === 'string' ? { channelId: p.channelId, messageId: p.messageId } : null;
  } catch {
    return null;
  }
}

type Payload = Pick<MessageCreateOptions, 'embeds' | 'components'>;

/** Posts the message in a channel, removes the previous copy and returns the new one's link. */
export async function postLive(ctx: AppContext, key: string, channelId: string, payload: Payload): Promise<string> {
  const channel = await getSendableChannel(ctx, channelId);
  const previous = readLive(ctx, key);
  const sent = await channel.send({ ...payload, allowedMentions: { parse: [] } });
  ctx.store.setMeta(key, JSON.stringify({ channelId: channel.id, messageId: sent.id }));
  if (previous) {
    const old = await getSendableChannel(ctx, previous.channelId).catch(() => null);
    await old?.messages.delete(previous.messageId).catch(() => {});
  }
  return `https://discord.com/channels/${ctx.config.DISCORD_GUILD_ID}/${channel.id}/${sent.id}`;
}

/** Edits the posted message; false when there is none (any more). */
export async function editLive(ctx: AppContext, key: string, payload: Payload): Promise<boolean> {
  const ref = readLive(ctx, key);
  if (!ref) return false;
  const channel = await getSendableChannel(ctx, ref.channelId).catch(() => null);
  const message = await channel?.messages.fetch(ref.messageId).catch(() => null);
  if (!message) {
    ctx.store.setMeta(key, '');
    return false;
  }
  await message.edit(payload);
  return true;
}
