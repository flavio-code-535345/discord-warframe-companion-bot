import {
  ChannelType,
  type Guild,
  GatewayIntentBits,
  type NonThreadGuildBasedChannel,
  PermissionFlagsBits,
} from 'discord.js';
import type { GuildSettings } from '../db.js';

/**
 * A Xenon-style server snapshot: everything needed to rebuild the clan server's structure. IDs are the
 * originals; restore maps them to whatever the server has (or creates) at restore time.
 */
export const BACKUP_VERSION = 1;
export const MESSAGES_PER_CHANNEL = 50;

export interface BackupRole {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  /** Permission bitfield as a decimal string (bigints don't survive JSON). */
  permissions: string;
  position: number;
  everyone: boolean;
  managed: boolean;
}

export interface BackupOverwrite {
  id: string;
  /** 0 = role, 1 = member, as in the Discord API. */
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface BackupMessage {
  author: string;
  avatar: string | null;
  content: string;
  attachments: string[];
  createdAt: number;
}

export interface BackupChannel {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  bitrate: number | null;
  userLimit: number | null;
  overwrites: BackupOverwrite[];
  /** Newest last; only when the Message Content intent was enabled at backup time. */
  messages?: BackupMessage[];
}

export interface ServerBackup {
  version: typeof BACKUP_VERSION;
  createdAt: number;
  guild: {
    id: string;
    name: string;
    /** PNG as base64, so it survives the server (and its CDN links) being deleted. */
    icon: string | null;
    verificationLevel: number;
    defaultMessageNotifications: number;
    explicitContentFilter: number;
    afkTimeout: number;
    afkChannelId: string | null;
    systemChannelId: string | null;
  };
  roles: BackupRole[];
  channels: BackupChannel[];
  emojis: { name: string; animated: boolean; data: string }[];
  bans: { id: string; reason: string | null }[];
  /** Ordis's own channel settings, so they can be pointed at recreated channels. */
  botSettings: Omit<GuildSettings, 'guildId'> | null;
  includesMessages: boolean;
}

export interface BackupSummary {
  roles: number;
  channels: number;
  emojis: number;
  bans: number;
  messages: number;
  sizeBytes: number;
}

export const BACKED_UP_TYPES = new Set<ChannelType>([
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
]);

async function base64(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return res.ok ? Buffer.from(await res.arrayBuffer()).toString('base64') : null;
  } catch {
    return null;
  }
}

function channelRecord(c: NonThreadGuildBasedChannel): BackupChannel {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    parentId: c.parentId,
    position: c.rawPosition,
    topic: 'topic' in c ? (c.topic ?? null) : null,
    nsfw: 'nsfw' in c ? Boolean(c.nsfw) : false,
    rateLimitPerUser: 'rateLimitPerUser' in c ? (c.rateLimitPerUser ?? 0) : 0,
    bitrate: 'bitrate' in c ? c.bitrate : null,
    userLimit: 'userLimit' in c ? c.userLimit : null,
    overwrites: [...c.permissionOverwrites.cache.values()].map((o) => ({
      id: o.id,
      type: o.type as 0 | 1,
      allow: o.allow.bitfield.toString(),
      deny: o.deny.bitfield.toString(),
    })),
  };
}

export function summarize(backup: ServerBackup, sizeBytes: number): BackupSummary {
  return {
    roles: backup.roles.filter((r) => !r.managed && !r.everyone).length,
    channels: backup.channels.length,
    emojis: backup.emojis.length,
    bans: backup.bans.length,
    messages: backup.channels.reduce((n, c) => n + (c.messages?.length ?? 0), 0),
    sizeBytes,
  };
}

/** Takes a snapshot of the server. Message history is included only with the Message Content intent. */
export async function createSnapshot(guild: Guild, botSettings: GuildSettings | null): Promise<ServerBackup> {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch()]);
  const me = await guild.members.fetchMe();
  const withMessages = guild.client.options.intents.has(GatewayIntentBits.MessageContent);

  const channels: BackupChannel[] = [];
  for (const c of guild.channels.cache.values()) {
    if (c.isThread() || !BACKED_UP_TYPES.has(c.type)) continue;
    const record = channelRecord(c);
    if (withMessages && c.isTextBased() && c.permissionsFor(me).has(PermissionFlagsBits.ReadMessageHistory)) {
      const fetched = await c.messages.fetch({ limit: MESSAGES_PER_CHANNEL }).catch(() => null);
      record.messages = [...(fetched?.values() ?? [])]
        .filter((m) => !m.system && (m.content || m.attachments.size))
        .reverse()
        .map((m) => ({
          author: m.member?.displayName ?? m.author.displayName,
          avatar: m.author.displayAvatarURL(),
          content: m.content,
          attachments: [...m.attachments.values()].map((a) => a.url),
          createdAt: m.createdTimestamp,
        }));
    }
    channels.push(record);
  }

  const emojis = [];
  for (const e of guild.emojis.cache.values()) {
    const data = await base64(e.imageURL({ extension: e.animated ? 'gif' : 'png' }));
    if (data && e.name) emojis.push({ name: e.name, animated: Boolean(e.animated), data });
  }

  const bans = await guild.bans.fetch().catch(() => null);
  const { guildId: _ignored, ...settings } = botSettings ?? { guildId: '' };

  return {
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    guild: {
      id: guild.id,
      name: guild.name,
      icon: await base64(guild.iconURL({ extension: 'png', size: 512 })),
      verificationLevel: guild.verificationLevel,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      explicitContentFilter: guild.explicitContentFilter,
      afkTimeout: guild.afkTimeout,
      afkChannelId: guild.afkChannelId,
      systemChannelId: guild.systemChannelId,
    },
    roles: [...guild.roles.cache.values()].map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      hoist: r.hoist,
      mentionable: r.mentionable,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
      everyone: r.id === guild.id,
      managed: r.managed,
    })),
    channels,
    emojis,
    bans: [...(bans?.values() ?? [])].map((b) => ({ id: b.user.id, reason: b.reason ?? null })),
    botSettings: botSettings ? (settings as Omit<GuildSettings, 'guildId'>) : null,
    includesMessages: withMessages,
  };
}

/** Light structural check for imported files: right version and the arrays restore relies on. */
export function parseBackup(json: string): ServerBackup {
  const data = JSON.parse(json) as Partial<ServerBackup>;
  if (data.version !== BACKUP_VERSION || !data.guild || !Array.isArray(data.roles) || !Array.isArray(data.channels)) {
    throw new Error('Not a Cephalon Ordis backup file (or from an incompatible version).');
  }
  return { emojis: [], bans: [], botSettings: null, includesMessages: false, ...data } as ServerBackup;
}
