import { ChannelType, type Guild, OverwriteType, PermissionFlagsBits, type VoiceBasedChannel } from 'discord.js';
import type { AppContext } from '../context.js';
import type { LfgPost } from '../db.js';
import { getSendableChannel, renderLfg } from '../services/clan.js';
import { sweepTempVoice } from './autovc.js';
import { DEFAULT_GRACE_MINUTES, sweepAction } from './lifecycle.js';

const SWEEP_INTERVAL_MS = 60_000;
const MEMBER_ACCESS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak];

const graceMs = (ctx: AppContext) =>
  (ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).lfgVoiceGraceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000;

async function guildOf(ctx: AppContext): Promise<Guild> {
  return ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
}

/** Resolves a squad's voice channel; null when it has been deleted. */
async function voiceChannelOf(guild: Guild, id: string | null): Promise<VoiceBasedChannel | null> {
  if (!id) return null;
  const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  return channel?.isVoiceBased() ? channel : null;
}

/** The category squads' voice channels go in, or null when squad voice is off or the category is gone. */
export async function squadVoiceCategory(ctx: AppContext): Promise<string | null> {
  const id = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).lfgVoiceCategoryId;
  if (!id) return null;
  const guild = await guildOf(ctx);
  const category = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  return category?.type === ChannelType.GuildCategory ? id : null;
}

/**
 * Creates a squad's voice channel: visible to everyone so they can see the squad is forming, but only the host
 * (and members the squad lets in later) can connect. The limit is the squad size.
 */
export async function createSquadVoice(
  ctx: AppContext,
  opts: { categoryId: string; hostId: string; hostName: string; activity: string; size: number },
): Promise<VoiceBasedChannel> {
  const guild = await guildOf(ctx);
  return guild.channels.create({
    name: `🎙️ ${opts.activity} · ${opts.hostName}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: opts.categoryId,
    userLimit: Math.max(1, opts.size),
    permissionOverwrites: [
      { id: guild.id, type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
      { id: opts.hostId, type: OverwriteType.Member, allow: MEMBER_ACCESS },
    ],
    reason: `Squad voice for ${opts.activity} (host ${opts.hostName})`,
  });
}

/** Lets a squad member into the squad's voice channel (or takes them out again). Never throws. */
export async function setSquadVoiceAccess(ctx: AppContext, post: LfgPost, userId: string, allowed: boolean): Promise<void> {
  try {
    const channel = await voiceChannelOf(await guildOf(ctx), post.voiceChannelId);
    if (!channel) return;
    if (allowed) {
      await channel.permissionOverwrites.create(userId, { ViewChannel: true, Connect: true, Speak: true }, { type: OverwriteType.Member });
    } else {
      await channel.permissionOverwrites.delete(userId, 'Left the squad');
      // Someone who left shouldn't keep sitting in the channel.
      await channel.members.get(userId)?.voice.disconnect('Left the squad').catch(() => {});
    }
  } catch (err) {
    console.warn('[lfg] could not update voice access:', (err as Error).message);
  }
}

export async function deleteSquadVoice(ctx: AppContext, post: LfgPost): Promise<void> {
  try {
    const channel = await voiceChannelOf(await guildOf(ctx), post.voiceChannelId);
    await channel?.delete('Squad ended');
  } catch (err) {
    console.warn('[lfg] could not delete the squad voice channel:', (err as Error).message);
  }
  ctx.store.setLfgVoice(post.id, null);
}

/** Closes a squad (rewriting its post) and removes its voice channel once nobody is in it. Never throws. */
export async function closeSquad(ctx: AppContext, postId: number, note: string | null): Promise<void> {
  const current = ctx.store.getLfg(postId);
  if (!current) return;
  if (!current.closed) ctx.store.closeLfg(postId);
  const post = ctx.store.getLfg(postId)!;
  try {
    if (post.messageId) {
      const channel = await getSendableChannel(ctx, post.channelId);
      const message = await channel.messages.fetch(post.messageId).catch(() => null);
      await message?.edit({ ...renderLfg(ctx, post, note), content: '' });
    }
  } catch (err) {
    console.warn('[lfg] could not update a closed squad post:', (err as Error).message);
  }
  if (!post.voiceChannelId) return;
  const channel = await voiceChannelOf(await guildOf(ctx), post.voiceChannelId).catch(() => null);
  if (!channel || channel.members.size === 0) await deleteSquadVoice(ctx, post);
}

/** One pass of upkeep over every squad that has a voice channel or an expiry. */
export async function sweepSquads(ctx: AppContext, now = Date.now()): Promise<void> {
  const guild = await guildOf(ctx);
  for (const post of ctx.store.lfgForSweep()) {
    if (post.guildId !== ctx.config.DISCORD_GUILD_ID) continue;
    const channel = await voiceChannelOf(guild, post.voiceChannelId);
    const action = sweepAction(post, channel ? [...channel.members.keys()] : null, now, graceMs(ctx));
    switch (action.kind) {
      case 'close':
        await closeSquad(ctx, post.id, `Squad ended: ${action.reason}.`);
        break;
      case 'delete-voice':
        await deleteSquadVoice(ctx, post);
        break;
      case 'clear-voice':
        ctx.store.setLfgVoice(post.id, null);
        break;
      case 'host-present':
        ctx.store.setLfgHostAbsent(post.id, null);
        break;
      case 'host-absent':
        ctx.store.setLfgHostAbsent(post.id, action.since);
        break;
    }
  }
}

export class LfgVoiceSweeper {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await sweepSquads(this.ctx);
      await sweepTempVoice(this.ctx);
    } catch (err) {
      console.error('[lfg] sweep failed:', err);
    } finally {
      this.running = false;
    }
  }
}
