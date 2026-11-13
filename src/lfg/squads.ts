import type { SendableChannels } from 'discord.js';
import type { AppContext } from '../context.js';
import type { LfgPost } from '../db.js';
import { notifySquad } from '../discord/subscriptions.js';
import { UserError, getSendableChannel, renderLfg } from '../services/clan.js';
import { createSquadVoice, deleteSquadVoice, squadVoiceCategory } from './voice.js';

/**
 * Posting a squad: the one implementation behind `/lfg` and the "Squad up" button on the Arbitration board. It creates the squad's
 * voice channel (when squad voice is set up), stores and posts the squad with its Join/Leave/Close buttons, and DMs the members who
 * asked to hear about squads. Nobody is pinged in the channel.
 */

export interface SquadInput {
  hostId: string;
  hostName: string;
  activity: string;
  details?: string | null;
  /** Squad size including the host (2 to 4, default 4). */
  size?: number;
  /** When the squad ends on its own; null or missing = no limit. */
  expiresAt?: number | null;
  /** Where the squad was asked for (the channel `/lfg` ran in); used when the activity has no channel of its own. */
  channel?: SendableChannels | null;
}

export interface CreatedSquad {
  post: LfgPost;
  channelId: string;
  voiceChannelId: string | null;
  /** Link to the squad's post. */
  url: string;
}

export async function createSquad(ctx: AppContext, input: SquadInput): Promise<CreatedSquad> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const size = Math.max(2, Math.min(4, input.size ?? 4));
  const activity = ctx.store.getActivity(input.activity);
  // An activity can have its own channel; otherwise the squad goes where it was asked for, else into the squads channel.
  const fallback = ctx.store.getSettings(guildId).lfgChannelId;
  const channel = activity?.channelId ? await getSendableChannel(ctx, activity.channelId) : (input.channel ?? (fallback ? await getSendableChannel(ctx, fallback) : null));
  if (!channel?.isSendable()) throw new UserError("There is no channel to post the squad in. An admin can set one with `/setup lfg`.");

  const categoryId = await squadVoiceCategory(ctx);
  let voiceId: string | null = null;
  if (categoryId) {
    const existing = ctx.store.openVoiceLfgByHost(guildId, input.hostId);
    if (existing) throw new UserError(`You already have an open squad (#${existing.id}). Close it before starting another.`);
    try {
      voiceId = (await createSquadVoice(ctx, { categoryId, hostId: input.hostId, hostName: input.hostName, activity: input.activity, size })).id;
    } catch (err) {
      console.error('[lfg] could not create the squad voice channel:', err);
      throw new UserError("I couldn't create the voice channel. Check that Ordis can manage channels in that category.");
    }
  }

  const post = ctx.store.createLfg({ guildId, channelId: channel.id, hostId: input.hostId, activity: input.activity, details: input.details ?? null, size });
  // The host counts as absent from creation, so a squad whose host never joins voice still ends.
  if (voiceId) ctx.store.setLfgVoice(post.id, voiceId, Date.now());
  if (input.expiresAt) ctx.store.setLfgExpiry(post.id, input.expiresAt);
  const stored = ctx.store.getLfg(post.id)!;

  let url: string;
  try {
    const message = await channel.send({ ...renderLfg(ctx, stored), allowedMentions: { parse: [] } });
    ctx.store.setLfgMessage(post.id, message.id);
    url = `https://discord.com/channels/${guildId}/${channel.id}/${message.id}`;
  } catch (err) {
    ctx.store.closeLfg(post.id);
    if (voiceId) await deleteSquadVoice(ctx, stored);
    throw err;
  }
  await notifySquad(ctx, stored, url, input.hostName).catch((err) => console.warn('[lfg] could not DM the squad to its subscribers:', (err as Error).message));
  return { post: ctx.store.getLfg(post.id)!, channelId: channel.id, voiceChannelId: voiceId, url };
}
