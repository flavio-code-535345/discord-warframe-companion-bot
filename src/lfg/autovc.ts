import { ChannelType, type Guild, type GuildMember, OverwriteType, PermissionFlagsBits, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import type { AppContext } from '../context.js';

/** A new room is not swept for this long, so the owner has time to be moved into it. */
const NEW_ROOM_GRACE_MS = 30_000;
const OWNER_ACCESS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.MoveMembers];

export const roomName = (displayName: string) => `🎧 ${displayName}'s room`.slice(0, 100);

async function voiceChannel(guild: Guild, id: string): Promise<VoiceBasedChannel | null> {
  const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  return channel?.isVoiceBased() ? channel : null;
}

async function deleteRoom(ctx: AppContext, guild: Guild, channelId: string): Promise<void> {
  ctx.store.removeTempVoice(channelId);
  const channel = await voiceChannel(guild, channelId);
  await channel?.delete('Join-to-create room is empty').catch((err) => console.warn('[autovc] could not delete a room:', (err as Error).message));
}

async function createRoom(ctx: AppContext, member: GuildMember, hub: VoiceBasedChannel): Promise<void> {
  const { store } = ctx;
  // One room per member: joining the lobby again just takes them back to it.
  const existing = store.tempVoiceByOwner(member.guild.id, member.id);
  const current = existing ? await voiceChannel(member.guild, existing.channelId) : null;
  if (existing && current) {
    await member.voice.setChannel(current).catch(() => {});
    return;
  }
  if (existing) store.removeTempVoice(existing.channelId);

  const room = await member.guild.channels.create({
    name: roomName(member.displayName),
    type: ChannelType.GuildVoice,
    parent: hub.parentId,
    bitrate: Math.min(hub.bitrate, member.guild.maximumBitrate),
    permissionOverwrites: [{ id: member.id, type: OverwriteType.Member, allow: OWNER_ACCESS }],
    reason: `Join-to-create room for ${member.user.username}`,
  });
  store.addTempVoice({ channelId: room.id, guildId: member.guild.id, ownerId: member.id, createdAt: Date.now() });
  // The member may have left the lobby while the room was being made; the sweep removes an unused room.
  await member.voice.setChannel(room).catch(() => {});
}

/** Join-to-create: joining the lobby makes a personal room, and an empty room is deleted. Never throws. */
export async function handleVoiceStateUpdate(ctx: AppContext, before: VoiceState, after: VoiceState): Promise<void> {
  try {
    if (after.guild.id !== ctx.config.DISCORD_GUILD_ID) return;
    const hubId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).autoVcHubChannelId;

    if (hubId && after.channelId === hubId && before.channelId !== hubId && after.member && !after.member.user.bot) {
      await createRoom(ctx, after.member, after.channel as VoiceBasedChannel);
    }

    if (before.channelId && before.channelId !== after.channelId && ctx.store.getTempVoice(before.channelId)) {
      const room = before.channel;
      if (room && room.members.size === 0) await deleteRoom(ctx, before.guild, room.id);
    }
  } catch (err) {
    console.error('[autovc] voice update failed:', err);
  }
}

/** Safety net for restarts and missed events: forgets deleted rooms and removes empty ones. */
export async function sweepTempVoice(ctx: AppContext, now = Date.now()): Promise<void> {
  const rooms = ctx.store.listTempVoice().filter((r) => r.guildId === ctx.config.DISCORD_GUILD_ID);
  if (!rooms.length) return;
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  for (const room of rooms) {
    const channel = await voiceChannel(guild, room.channelId);
    if (!channel) ctx.store.removeTempVoice(room.channelId);
    else if (channel.members.size === 0 && now - room.createdAt > NEW_ROOM_GRACE_MS) await deleteRoom(ctx, guild, room.channelId);
  }
}
