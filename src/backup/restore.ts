import {
  ChannelType,
  type Guild,
  type GuildChannelCreateOptions,
  type GuildChannelEditOptions,
  type NonThreadGuildBasedChannel,
  OverwriteType,
} from 'discord.js';
import type { GuildSettings, Store } from '../db.js';
import type { BackupChannel, BackupOverwrite, ServerBackup } from './snapshot.js';

/**
 * Rebuilds a server from a snapshot. Two modes:
 * - "missing" (default): only recreates roles, channels, emojis and bans that no longer exist. Nothing that's
 *   still there is touched, so running it on a healthy server changes nothing.
 * - "sync": also resets existing roles, channels and server settings to how they were in the backup.
 * Nothing is ever deleted. IDs from the backup are mapped to the live (or newly created) objects.
 */
export type RestoreMode = 'missing' | 'sync';

export interface RestoreOptions {
  mode: RestoreMode;
  bans: boolean;
  messages: boolean;
}

export interface CurrentState {
  guildId: string;
  roleIds: Set<string>;
  channelIds: Set<string>;
  emojiNames: Set<string>;
  banIds: Set<string>;
}

export interface RestorePlan {
  rolesCreate: string[];
  rolesUpdate: string[];
  /** Bot/integration roles that are gone: they come back when that bot is re-invited. */
  rolesSkipped: string[];
  channelsCreate: string[];
  channelsUpdate: string[];
  emojisCreate: string[];
  bansAdd: number;
  messageChannels: number;
}

export function planRestore(current: CurrentState, backup: ServerBackup, opts: RestoreOptions): RestorePlan {
  const plan: RestorePlan = { rolesCreate: [], rolesUpdate: [], rolesSkipped: [], channelsCreate: [], channelsUpdate: [], emojisCreate: [], bansAdd: 0, messageChannels: 0 };
  for (const r of backup.roles) {
    if (r.everyone) continue;
    const exists = current.roleIds.has(r.id);
    if (r.managed) {
      if (!exists) plan.rolesSkipped.push(r.name);
    } else if (!exists) plan.rolesCreate.push(r.name);
    else if (opts.mode === 'sync') plan.rolesUpdate.push(r.name);
  }
  for (const c of backup.channels) {
    if (!current.channelIds.has(c.id)) {
      plan.channelsCreate.push(c.name);
      if (opts.messages && c.messages?.length) plan.messageChannels++;
    } else if (opts.mode === 'sync') plan.channelsUpdate.push(c.name);
  }
  plan.emojisCreate = backup.emojis.filter((e) => !current.emojiNames.has(e.name)).map((e) => e.name);
  if (opts.bans) plan.bansAdd = backup.bans.filter((b) => !current.banIds.has(b.id)).length;
  return plan;
}

export async function currentState(guild: Guild): Promise<CurrentState> {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch()]);
  const bans = await guild.bans.fetch().catch(() => null);
  return {
    guildId: guild.id,
    roleIds: new Set(guild.roles.cache.keys()),
    channelIds: new Set([...guild.channels.cache.values()].filter((c) => !c.isThread()).map((c) => c.id)),
    emojiNames: new Set([...guild.emojis.cache.values()].map((e) => e.name ?? '')),
    banIds: new Set(bans?.keys() ?? []),
  };
}

export interface RestoreResult {
  rolesCreated: number;
  rolesUpdated: number;
  channelsCreated: number;
  channelsUpdated: number;
  emojisCreated: number;
  bansAdded: number;
  messagesPosted: number;
  /** Old (backup) channel ID → live channel ID, for everything that maps. */
  channelMap: Map<string, string>;
  errors: string[];
}

/** Types that need the Community feature, with the closest type that doesn't. */
const COMMUNITY_FALLBACK: Partial<Record<ChannelType, ChannelType>> = {
  [ChannelType.GuildAnnouncement]: ChannelType.GuildText,
  [ChannelType.GuildForum]: ChannelType.GuildText,
  [ChannelType.GuildStageVoice]: ChannelType.GuildVoice,
};

const isVoice = (t: ChannelType) => t === ChannelType.GuildVoice || t === ChannelType.GuildStageVoice;
const hasTopic = (t: ChannelType) => t === ChannelType.GuildText || t === ChannelType.GuildAnnouncement || t === ChannelType.GuildForum;

export async function restoreBackup(
  guild: Guild,
  backup: ServerBackup,
  opts: RestoreOptions,
  store: Store,
  onProgress: (step: string) => Promise<void> | void = () => {},
): Promise<RestoreResult> {
  const reason = 'Cephalon Ordis: restore from backup';
  const result: RestoreResult = { rolesCreated: 0, rolesUpdated: 0, channelsCreated: 0, channelsUpdated: 0, emojisCreated: 0, bansAdded: 0, messagesPosted: 0, channelMap: new Map(), errors: [] };
  const fail = (what: string, err: unknown) => result.errors.push(`${what}: ${(err as Error).message}`);
  await Promise.all([guild.roles.fetch(), guild.channels.fetch(), guild.emojis.fetch()]);
  const me = await guild.members.fetchMe();

  // --- roles (lowest first, so creation order roughly matches the old hierarchy) ---
  await onProgress('Restoring roles…');
  const roleMap = new Map<string, string>([[backup.guild.id, guild.id]]);
  const everyone = backup.roles.find((r) => r.everyone);
  if (everyone && opts.mode === 'sync') {
    await guild.roles.everyone.setPermissions(BigInt(everyone.permissions), reason).catch((e) => fail('@everyone permissions', e));
  }
  for (const r of backup.roles.filter((x) => !x.everyone).sort((a, b) => a.position - b.position)) {
    const live = guild.roles.cache.get(r.id);
    if (live) {
      roleMap.set(r.id, live.id);
      if (opts.mode === 'sync' && !r.managed && live.editable) {
        await live
          .edit({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason })
          .then(() => result.rolesUpdated++, (e) => fail(`role ${r.name}`, e));
      }
      continue;
    }
    if (r.managed) continue;
    await guild.roles
      .create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason })
      .then((created) => {
        roleMap.set(r.id, created.id);
        result.rolesCreated++;
      }, (e) => fail(`role ${r.name}`, e));
  }
  // Re-apply the old order below Ordis's own role (the only range a bot may arrange).
  const ordered = backup.roles
    .filter((r) => !r.everyone && !r.managed && roleMap.has(r.id))
    .sort((a, b) => a.position - b.position)
    .map((r) => guild.roles.cache.get(roleMap.get(r.id)!))
    .filter((role) => role && role.editable);
  if ((result.rolesCreated || opts.mode === 'sync') && ordered.length && ordered.length < me.roles.highest.position) {
    await guild.roles.setPositions(ordered.map((role, i) => ({ role: role!.id, position: i + 1 }))).catch((e) => fail('role order', e));
  }

  // --- channels: categories first so children can be placed inside them ---
  await onProgress('Restoring channels…');
  const memberCache = new Map<string, boolean>();
  const memberExists = async (id: string) => {
    if (!memberCache.has(id)) memberCache.set(id, Boolean(await guild.members.fetch(id).catch(() => null)));
    return memberCache.get(id)!;
  };
  const mapOverwrites = async (list: BackupOverwrite[]) => {
    const out = [];
    for (const o of list) {
      const id = o.type === 0 ? roleMap.get(o.id) : (await memberExists(o.id)) ? o.id : undefined;
      if (id) out.push({ id, type: o.type === 0 ? OverwriteType.Role : OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) });
    }
    return out;
  };
  const community = guild.features.includes('COMMUNITY');
  const created = new Set<string>();
  const sorted = [...backup.channels].sort(
    (a, b) => Number(b.type === ChannelType.GuildCategory) - Number(a.type === ChannelType.GuildCategory) || a.position - b.position,
  );

  const settingsFor = async (c: BackupChannel, type: ChannelType) => ({
    name: c.name,
    topic: hasTopic(type) ? (c.topic ?? undefined) : undefined,
    nsfw: type === ChannelType.GuildCategory || isVoice(type) ? undefined : c.nsfw,
    rateLimitPerUser: hasTopic(type) ? c.rateLimitPerUser : undefined,
    bitrate: isVoice(type) && c.bitrate ? Math.min(c.bitrate, guild.maximumBitrate) : undefined,
    userLimit: isVoice(type) ? (c.userLimit ?? undefined) : undefined,
    parent: c.parentId ? (result.channelMap.get(c.parentId) ?? null) : null,
    permissionOverwrites: await mapOverwrites(c.overwrites),
  });

  for (const c of sorted) {
    const live = guild.channels.cache.get(c.id) as NonThreadGuildBasedChannel | undefined;
    if (live && !live.isThread()) {
      result.channelMap.set(c.id, live.id);
      if (opts.mode === 'sync') {
        const { parent, ...rest } = await settingsFor(c, live.type);
        await live
          .edit({ ...rest, parent: live.type === ChannelType.GuildCategory ? undefined : parent, reason } as GuildChannelEditOptions)
          .then(() => result.channelsUpdated++, (e) => fail(`#${c.name}`, e));
      }
      continue;
    }
    const type = !community && COMMUNITY_FALLBACK[c.type] !== undefined ? COMMUNITY_FALLBACK[c.type]! : c.type;
    const { parent, ...rest } = await settingsFor(c, type);
    await guild.channels
      .create({ ...rest, type, parent: type === ChannelType.GuildCategory ? undefined : (parent ?? undefined), reason } as GuildChannelCreateOptions & { type: ChannelType.GuildText })
      .then((ch) => {
        result.channelMap.set(c.id, ch.id);
        created.add(c.id);
        result.channelsCreated++;
      }, (e) => fail(`#${c.name}`, e));
  }
  // One bulk call puts every channel back in its old spot.
  const positions = backup.channels
    .filter((c) => result.channelMap.has(c.id) && (opts.mode === 'sync' || created.has(c.id)))
    .map((c) => ({
      channel: result.channelMap.get(c.id)!,
      position: c.position,
      ...(c.type !== ChannelType.GuildCategory ? { parent: c.parentId ? (result.channelMap.get(c.parentId) ?? null) : null } : {}),
    }));
  if (positions.length) await guild.channels.setPositions(positions).catch((e) => fail('channel order', e));

  // --- server settings ---
  await onProgress('Restoring server settings…');
  const mapCh = (id: string | null) => (id ? (result.channelMap.get(id) ?? null) : null);
  const guildEdit: Parameters<Guild['edit']>[0] = { reason };
  if (opts.mode === 'sync') {
    Object.assign(guildEdit, {
      name: backup.guild.name,
      verificationLevel: backup.guild.verificationLevel,
      defaultMessageNotifications: backup.guild.defaultMessageNotifications,
      explicitContentFilter: backup.guild.explicitContentFilter,
      afkTimeout: backup.guild.afkTimeout,
      afkChannel: mapCh(backup.guild.afkChannelId),
      systemChannel: mapCh(backup.guild.systemChannelId),
    });
  } else {
    if (!guild.afkChannelId && backup.guild.afkChannelId) guildEdit.afkChannel = mapCh(backup.guild.afkChannelId);
    if (!guild.systemChannelId && backup.guild.systemChannelId) guildEdit.systemChannel = mapCh(backup.guild.systemChannelId);
  }
  if (backup.guild.icon && (opts.mode === 'sync' || !guild.icon)) guildEdit.icon = Buffer.from(backup.guild.icon, 'base64');
  if (Object.keys(guildEdit).length > 1) await guild.edit(guildEdit).catch((e) => fail('server settings', e));

  // --- emojis and bans ---
  await onProgress('Restoring emojis and bans…');
  const liveEmojiNames = new Set([...guild.emojis.cache.values()].map((e) => e.name));
  for (const e of backup.emojis) {
    if (liveEmojiNames.has(e.name)) continue;
    await guild.emojis
      .create({ attachment: Buffer.from(e.data, 'base64'), name: e.name, reason })
      .then(() => result.emojisCreated++, (err) => fail(`emoji :${e.name}:`, err));
  }
  if (opts.bans) {
    const liveBans = await guild.bans.fetch().catch(() => null);
    for (const b of backup.bans) {
      if (liveBans?.has(b.id)) continue;
      await guild.members
        .ban(b.id, { reason: `${reason}${b.reason ? `: ${b.reason}` : ''}`.slice(0, 512) })
        .then(() => result.bansAdded++, (e) => fail(`ban ${b.id}`, e));
    }
  }

  // --- Ordis's own channel settings, pointed at the live channels ---
  if (backup.botSettings) {
    const live = store.getSettings(guild.id);
    const patch: Partial<Omit<GuildSettings, 'guildId'>> = {};
    for (const key of ['alertsChannelId', 'announcementsChannelId', 'welcomeChannelId', 'chatChannelId', 'modLogChannelId', 'verifyChannelId', 'honeypotChannelId', 'lfgVoiceCategoryId', 'autoVcHubChannelId', 'ssRolesChannelId', 'levelChannelId', 'auditLogChannelId'] as const) {
      const mapped = mapCh(backup.botSettings[key]);
      const current = live[key];
      if (mapped && (opts.mode === 'sync' || !current || !guild.channels.cache.has(current))) patch[key] = mapped;
    }
    for (const key of ['alertsRoleId', 'verifyRoleId'] as const) {
      const role = backup.botSettings[key] ? (roleMap.get(backup.botSettings[key]!) ?? null) : null;
      if (role && (opts.mode === 'sync' || !live[key] || !guild.roles.cache.has(live[key]!))) patch[key] = role;
    }
    if (backup.botSettings.verifyMinAccountAgeDays !== undefined && (opts.mode === 'sync' || live.verifyMinAccountAgeDays === null)) {
      patch.verifyMinAccountAgeDays = backup.botSettings.verifyMinAccountAgeDays;
    }
    if (Object.keys(patch).length) store.updateSettings(guild.id, patch);
  }

  // --- message history, only into channels this restore created ---
  if (opts.messages && backup.includesMessages) {
    for (const c of backup.channels) {
      if (!created.has(c.id) || !c.messages?.length) continue;
      await onProgress(`Re-posting messages in #${c.name}…`);
      const channel = guild.channels.cache.get(result.channelMap.get(c.id)!);
      if (!channel || !('createWebhook' in channel)) continue;
      try {
        const hook = await channel.createWebhook({ name: 'Ordis restore', reason });
        for (const m of c.messages) {
          const content = [m.content, ...m.attachments].filter(Boolean).join('\n').slice(0, 2000);
          if (!content) continue;
          await hook.send({ content, username: m.author.slice(0, 80) || 'Unknown', avatarURL: m.avatar ?? undefined, allowedMentions: { parse: [] } });
          result.messagesPosted++;
        }
        await hook.delete(reason);
      } catch (e) {
        fail(`messages in #${c.name}`, e);
      }
    }
  }

  return result;
}
