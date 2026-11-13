import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type CategoryChannel,
  ChannelType,
  type Guild,
  type NonThreadGuildBasedChannel,
  OverwriteType,
  type GuildMember,
  PermissionFlagsBits,
  type PermissionOverwriteOptions,
  type Role,
} from 'discord.js';
import { z } from 'zod';
import { summaryOf, takeBackup } from '../backup/service.js';
import type { AppContext } from '../context.js';
import { validImageUrl } from '../lfg/lifecycle.js';
import { HONEYPOT_ACTIONS, disableHoneypot, honeypotAction, setupHoneypot } from '../moderation/honeypot.js';
import { disableRivenChannel, setupRivenChannel } from '../rivens/channel.js';
import { runPurge } from '../moderation/purge.js';
import { requestUpdate, scheduleRestart } from '../selfupdate.js';
import { planRoleMove } from './role-order.js';
import { syncChatTopic } from '../discord/chat-topic.js';
import { cardEmbed, deleteOwnMessage, editOwnMessage, editOwnMessageCard } from '../discord/messages.js';
import { COLORS } from '../discord/embeds.js';
import { componentText } from '../discord/feeds/parts.js';
import { brandIcon } from '../discord/identity.js';
import { postWelcome } from '../discord/welcome.js';
import { skipCurrentWeek } from '../discord/weekly.js';
import { own } from '../own.js';
import { UserError, assertChannelFree } from '../services/clan.js';
import { READ_ONLY, snowflake, tool } from './util.js';

/**
 * Server administration over MCP, for restructuring the clan Discord with an AI assistant. Deliberately
 * no delete operations: retired channels are archived (moved into a hidden category) so nothing is lost,
 * and every change carries an audit-log reason.
 */

const PERMISSIONS = Object.keys(PermissionFlagsBits) as [keyof typeof PermissionFlagsBits, ...(keyof typeof PermissionFlagsBits)[]];
const permission = z.enum(PERMISSIONS);
const ARCHIVE_NAME = '🗄️ ARCHIVE';

/** What update_bot_settings accepts for each channel setting: Ordis posts in the text ones, makes rooms next to the lobby and squad channels inside the category. */
const TEXT_CHANNEL = { types: [ChannelType.GuildText, ChannelType.GuildAnnouncement], label: 'a text channel' };
const SETTING_CHANNEL_KINDS: Record<string, { types: ChannelType[]; label: string }> = {
  alerts_channel_id: TEXT_CHANNEL,
  arbitrations_channel_id: TEXT_CHANNEL,
  fissures_channel_id: TEXT_CHANNEL,
  sortie_channel_id: TEXT_CHANNEL,
  cycles_channel_id: TEXT_CHANNEL,
  traders_channel_id: TEXT_CHANNEL,
  invasions_channel_id: TEXT_CHANNEL,
  announcements_channel_id: TEXT_CHANNEL,
  welcome_channel_id: TEXT_CHANNEL,
  chat_channel_id: TEXT_CHANNEL,
  mod_log_channel_id: TEXT_CHANNEL,
  audit_log_channel_id: TEXT_CHANNEL,
  status_channel_id: TEXT_CHANNEL,
  level_channel_id: TEXT_CHANNEL,
  honeypot_channel_id: TEXT_CHANNEL,
  riven_channel_id: TEXT_CHANNEL,
  birthday_channel_id: TEXT_CHANNEL,
  weekly_channel_id: TEXT_CHANNEL,
  promo_channel_id: TEXT_CHANNEL,
  news_channel_id: TEXT_CHANNEL,
  lfg_voice_category_id: { types: [ChannelType.GuildCategory], label: 'a category' },
  auto_vc_hub_channel_id: { types: [ChannelType.GuildVoice], label: 'a voice channel' },
};

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
} as const;

const overwriteSchema = z.object({
  target_id: snowflake.describe('Role ID, member ID, or the server ID for @everyone'),
  allow: z.array(permission).default([]),
  deny: z.array(permission).default([]),
});
type OverwriteInput = z.infer<typeof overwriteSchema>;

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

function hexColor(color: string | undefined): number | undefined {
  if (color === undefined) return undefined;
  const m = color.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new UserError(`"${color}" is not a hex color like #3b9ac7.`);
  return Number.parseInt(m[1]!, 16);
}

async function guildFor(ctx: AppContext): Promise<{ guild: Guild; me: GuildMember }> {
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  return { guild, me: await guild.members.fetchMe() };
}

function requirePermission(me: GuildMember, perm: keyof typeof PermissionFlagsBits) {
  if (!me.permissions.has(PermissionFlagsBits[perm])) {
    throw new UserError(
      `The bot lacks the "${perm}" permission. In Server Settings → Roles, give the bot's role Administrator (or ${perm}) and drag it to the top of the role list.`,
    );
  }
}

async function getChannel(guild: Guild, id: string): Promise<NonThreadGuildBasedChannel> {
  const channel = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
  if (!channel || channel.isThread()) throw new UserError(`Channel ${id} does not exist in the clan server.`);
  return channel as NonThreadGuildBasedChannel;
}

async function getCategory(guild: Guild, id: string | undefined | null): Promise<CategoryChannel | null> {
  if (!id) return null;
  const c = await getChannel(guild, id);
  if (c.type !== ChannelType.GuildCategory) throw new UserError(`${id} is not a category.`);
  return c;
}

async function overwriteTarget(guild: Guild, id: string): Promise<Role | GuildMember> {
  const role = guild.roles.cache.get(id);
  if (role) return role;
  const member = await guild.members.fetch(id).catch(() => null);
  if (!member) throw new UserError(`${id} is neither a role nor a member of the clan server.`);
  return member;
}

/** Overwrites for channel creation. The explicit type matters: discord.js can only infer it for cached roles/users. */
const toCreateOverwrites = (guild: Guild, list: OverwriteInput[]) =>
  list.map((o) => ({
    id: o.target_id,
    type: guild.roles.cache.has(o.target_id) ? OverwriteType.Role : OverwriteType.Member,
    allow: o.allow,
    deny: o.deny,
  }));

function describeChannel(guild: Guild, me: GuildMember, c: NonThreadGuildBasedChannel) {
  const name = (id: string) => (id === guild.id ? '@everyone' : (guild.roles.cache.get(id)?.name ?? guild.members.cache.get(id)?.displayName ?? id));
  return {
    id: c.id,
    name: c.name,
    type: ChannelType[c.type],
    position: c.rawPosition,
    topic: 'topic' in c ? (c.topic ?? null) : undefined,
    nsfw: 'nsfw' in c ? c.nsfw : undefined,
    userLimit: 'userLimit' in c ? c.userLimit : undefined,
    syncedWithCategory: c.parent ? c.permissionsLocked : undefined,
    botCanView: c.permissionsFor(me).has(PermissionFlagsBits.ViewChannel),
    overwrites: [...c.permissionOverwrites.cache.values()].map((o) => ({
      target: name(o.id),
      targetId: o.id,
      allow: o.allow.toArray(),
      deny: o.deny.toArray(),
    })),
  };
}

export function registerAdminTools(server: McpServer, ctx: AppContext): void {
  const reasonFor = (reason?: string) => `${ctx.config.BOT_NAME} via MCP${reason ? `: ${reason}` : ''}`.slice(0, 512);
  const log = (msg: string) => console.log(`[mcp-admin] ${msg}`);

  server.registerTool(
    'get_server_structure',
    {
      title: 'Discord server structure',
      description:
        'Full layout of the clan server: categories with their channels (all types, in order) and permission overwrites, roles in order with colors and permissions, server settings, and what the bot itself is allowed to do.',
      annotations: READ_ONLY,
    },
    tool(async () => {
      const { guild, me } = await guildFor(ctx);
      const channels = [...guild.channels.cache.values()].filter((c) => !c.isThread()) as NonThreadGuildBasedChannel[];
      const byPos = (a: { rawPosition: number }, b: { rawPosition: number }) => a.rawPosition - b.rawPosition;
      const categories = channels.filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory).sort(byPos);
      const children = (parentId: string | null) => channels.filter((c) => c.type !== ChannelType.GuildCategory && c.parentId === parentId).sort(byPos);
      const emojis = await guild.emojis.fetch().catch(() => guild.emojis.cache);
      return {
        server: {
          id: guild.id,
          name: guild.name,
          memberCount: guild.memberCount,
          systemChannel: guild.systemChannel?.name ?? null,
          rulesChannel: guild.rulesChannel?.name ?? null,
          afkChannel: guild.afkChannel?.name ?? null,
          verificationLevel: guild.verificationLevel,
          features: guild.features,
        },
        bot: {
          highestRole: me.roles.highest.name,
          highestRolePosition: me.roles.highest.position,
          isAdministrator: me.permissions.has(PermissionFlagsBits.Administrator),
          permissions: me.permissions.toArray(),
        },
        uncategorized: children(null).map((c) => describeChannel(guild, me, c)),
        categories: categories.map((cat) => ({ ...describeChannel(guild, me, cat), channels: children(cat.id).map((c) => describeChannel(guild, me, c)) })),
        roles: [...guild.roles.cache.values()]
          .sort((a, b) => b.position - a.position)
          .map((r) => ({
            id: r.id,
            name: r.name,
            position: r.position,
            color: r.hexColor,
            hoist: r.hoist,
            mentionable: r.mentionable,
            managed: r.managed,
            members: r.members.size,
            permissions: r.permissions.has(PermissionFlagsBits.Administrator) ? ['Administrator'] : r.permissions.toArray(),
          })),
        // Custom emojis, written as <:name:id> (<a:name:id> when animated) in messages and embeds.
        emojis: [...emojis.values()].map((e) => ({ id: e.id, name: e.name, animated: e.animated ?? false, available: e.available ?? true })),
      };
    }),
  );

  server.registerTool(
    'create_category',
    {
      title: 'Create category',
      description: 'Creates a channel category. Position 0 is the top.',
      inputSchema: {
        name: z.string().min(1).max(100),
        position: z.number().int().min(0).optional(),
        overwrites: z.array(overwriteSchema).optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ name, position, overwrites, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageChannels');
      const created = await guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        position,
        permissionOverwrites: overwrites ? toCreateOverwrites(guild, overwrites) : undefined,
        reason: reasonFor(reason),
      });
      log(`created category ${created.name} (${created.id})`);
      return { id: created.id, name: created.name };
    }),
  );

  server.registerTool(
    'create_channel',
    {
      title: 'Create channel',
      description: 'Creates a text, voice, announcement, forum or stage channel, optionally inside a category (inheriting its permissions unless overwrites are given).',
      inputSchema: {
        name: z.string().min(1).max(100),
        type: z.enum(Object.keys(CHANNEL_TYPES) as [keyof typeof CHANNEL_TYPES]).default('text'),
        category_id: snowflake.optional(),
        topic: z.string().max(1024).optional(),
        position: z.number().int().min(0).optional(),
        user_limit: z.number().int().min(0).max(99).optional().describe('Voice channels only; 0 = unlimited'),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
        overwrites: z.array(overwriteSchema).optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ name, type, category_id, topic, position, user_limit, slowmode_seconds, overwrites, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageChannels');
      const parent = await getCategory(guild, category_id);
      const created = await guild.channels.create({
        name,
        type: CHANNEL_TYPES[type],
        parent: parent ?? undefined,
        topic,
        position,
        userLimit: type === 'voice' ? user_limit : undefined,
        rateLimitPerUser: slowmode_seconds,
        permissionOverwrites: overwrites ? toCreateOverwrites(guild, overwrites) : undefined,
        reason: reasonFor(reason),
      });
      log(`created ${type} channel #${created.name} (${created.id})`);
      return { id: created.id, name: created.name, category: parent?.name ?? null };
    }),
  );

  server.registerTool(
    'edit_channel',
    {
      title: 'Edit channel or category',
      description:
        'Renames, re-topics, moves (category and/or position) or reconfigures a channel or category. sync_with_category=true replaces its permissions with the category\'s.',
      inputSchema: {
        channel_id: snowflake,
        name: z.string().min(1).max(100).optional(),
        topic: z.string().max(1024).optional(),
        category_id: snowflake.nullable().optional().describe('null moves it out of any category'),
        position: z.number().int().min(0).optional().describe('Index within its category (or among categories), 0 = top'),
        sync_with_category: z.boolean().optional(),
        nsfw: z.boolean().optional(),
        slowmode_seconds: z.number().int().min(0).max(21600).optional(),
        user_limit: z.number().int().min(0).max(99).optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ channel_id, name, topic, category_id, position, sync_with_category, nsfw, slowmode_seconds, user_limit, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageChannels');
      const channel = await getChannel(guild, channel_id);
      const parent = category_id === undefined ? undefined : await getCategory(guild, category_id);
      const before = { name: channel.name, category: channel.parent?.name ?? null, position: channel.rawPosition };
      const edited = await channel.edit({
        name,
        topic,
        parent: parent === undefined ? undefined : parent,
        position,
        lockPermissions: sync_with_category,
        nsfw,
        rateLimitPerUser: slowmode_seconds,
        userLimit: user_limit,
        reason: reasonFor(reason),
      } as Parameters<typeof channel.edit>[0]);
      log(`edited #${before.name} -> #${edited.name}`);
      return { id: edited.id, before, after: { name: edited.name, category: edited.parent?.name ?? null, position: edited.rawPosition } };
    }),
  );

  server.registerTool(
    'set_channel_permissions',
    {
      title: 'Set channel permissions',
      description:
        'Sets one permission overwrite on a channel or category for a role or member: listed allow/deny permissions are set, `neutral` ones reset to inherit. remove=true deletes the whole overwrite for that target.',
      inputSchema: {
        channel_id: snowflake,
        target_id: snowflake.describe('Role ID, member ID, or the server ID for @everyone'),
        allow: z.array(permission).default([]),
        deny: z.array(permission).default([]),
        neutral: z.array(permission).default([]),
        remove: z.boolean().optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ channel_id, target_id, allow, deny, neutral, remove, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageRoles');
      const channel = await getChannel(guild, channel_id);
      const target = await overwriteTarget(guild, target_id);
      if (remove) {
        await channel.permissionOverwrites.delete(target, reasonFor(reason));
      } else {
        const options: PermissionOverwriteOptions = {};
        for (const p of allow) options[p] = true;
        for (const p of deny) options[p] = false;
        for (const p of neutral) options[p] = null;
        await channel.permissionOverwrites.edit(target, options, { reason: reasonFor(reason) });
      }
      const after = channel.permissionOverwrites.cache.get(target.id);
      log(`permissions on #${channel.name} for ${target_id}: ${remove ? 'removed' : 'updated'}`);
      return { channel: channel.name, target: target_id, allow: after?.allow.toArray() ?? [], deny: after?.deny.toArray() ?? [] };
    }),
  );

  server.registerTool(
    'archive_channel',
    {
      title: 'Archive channel',
      description: `Retires a channel without deleting it: moves it into the hidden "${ARCHIVE_NAME}" category (created on first use) and syncs its permissions to that category, so only admins see it. Returns the previous category and overwrites so it can be restored.`,
      inputSchema: { channel_id: snowflake, reason: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    tool(async ({ channel_id, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageChannels');
      const channel = await getChannel(guild, channel_id);
      if (channel.type === ChannelType.GuildCategory) throw new UserError('Archive the channels inside a category, not the category itself.');
      const previous = {
        category: channel.parent ? { id: channel.parent.id, name: channel.parent.name } : null,
        overwrites: [...channel.permissionOverwrites.cache.values()].map((o) => ({ target_id: o.id, allow: o.allow.toArray(), deny: o.deny.toArray() })),
      };
      // Case doesn't matter: the category was first created as "🗄️ Archive" and later renamed to match the other categories.
      let archive = guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === ARCHIVE_NAME.toLowerCase());
      archive ??= await guild.channels.create({
        name: ARCHIVE_NAME,
        type: ChannelType.GuildCategory,
        permissionOverwrites: [
          { id: guild.id, deny: ['ViewChannel'] },
          { id: me.id, allow: ['ViewChannel', 'ManageChannels'] },
        ],
        reason: reasonFor('archive for retired channels'),
      });
      await channel.edit({ parent: archive, lockPermissions: true, reason: reasonFor(reason) } as Parameters<typeof channel.edit>[0]);
      log(`archived #${channel.name}`);
      return { archived: channel.name, previous };
    }),
  );

  server.registerTool(
    'create_role',
    {
      title: 'Create role',
      description: 'Creates a role. New roles appear just above @everyone; use edit_role to move it.',
      inputSchema: {
        name: z.string().min(1).max(100),
        color: z.string().optional().describe('Hex like #3b9ac7'),
        hoist: z.boolean().optional().describe('Show members separately in the member list'),
        mentionable: z.boolean().optional(),
        permissions: z.array(permission).optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ name, color, hoist, mentionable, permissions, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageRoles');
      const role = await guild.roles.create({ name, color: hexColor(color), hoist, mentionable, permissions: permissions ?? [], reason: reasonFor(reason) });
      log(`created role ${role.name} (${role.id})`);
      return { id: role.id, name: role.name, position: role.position };
    }),
  );

  server.registerTool(
    'edit_role',
    {
      title: 'Edit role',
      description:
        'Renames, recolors, reorders or changes a role. `permissions` replaces the whole permission set. The bot can only edit roles below its own highest role.',
      inputSchema: {
        role_id: snowflake,
        name: z.string().min(1).max(100).optional(),
        color: z.string().optional().describe('Hex like #3b9ac7'),
        hoist: z.boolean().optional(),
        mentionable: z.boolean().optional(),
        permissions: z.array(permission).optional(),
        position: z.number().int().min(1).optional().describe('Higher is more senior; must stay below the bot\'s own role'),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ role_id, name, color, hoist, mentionable, permissions, position, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageRoles');
      const role = guild.roles.cache.get(role_id);
      if (!role) throw new UserError(`Role ${role_id} does not exist.`);
      if (role.managed) throw new UserError(`${role.name} is managed by an integration and can't be edited.`);
      if (role.position >= me.roles.highest.position) {
        throw new UserError(`${role.name} is at or above the bot's highest role. Drag the bot's role above it in Server Settings → Roles.`);
      }
      // Checked before anything is changed, so a refused move doesn't leave the rename or the new permissions half applied.
      if (position !== undefined && position >= me.roles.highest.position) throw new UserError("A role can't be moved to or above the bot's own highest role.");
      const before = { name: role.name, color: role.hexColor, position: role.position };
      const edited = await role.edit({ name, color: hexColor(color), hoist, mentionable, permissions, reason: reasonFor(reason) });
      if (position !== undefined) {
        // Renumber the roles below the bot from fresh data and send only the ones that change: Role#setPosition also sends
        // roles above the bot (Discord refuses that), and a lone role collides with the cached numbers.
        const fresh = [...(await guild.roles.fetch()).values()].filter((r) => r.id !== guild.id && r.position < me.roles.highest.position);
        const changes = planRoleMove(fresh.map((r) => ({ id: r.id, position: r.position })), edited.id, position);
        if (changes.length) await guild.roles.setPositions(changes.map((c) => ({ role: c.id, position: c.position })));
      }
      log(`edited role ${before.name} -> ${edited.name}`);
      return { id: edited.id, before, after: { name: edited.name, color: edited.hexColor, position: edited.position } };
    }),
  );

  server.registerTool(
    'delete_role',
    {
      title: 'Delete role',
      description:
        'PERMANENTLY deletes a role (members lose it; a server backup still has it). Refuses @everyone, roles managed by an integration, roles at or above the bot, and roles in the self-assign menu (remove it from the menu first). Get the user to confirm first. Requires confirm: true.',
      inputSchema: { role_id: snowflake, confirm: z.literal(true), reason: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    tool(async ({ role_id, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageRoles');
      const role = guild.roles.cache.get(role_id);
      if (!role) throw new UserError(`Role ${role_id} does not exist.`);
      if (role.id === guild.id) throw new UserError("@everyone can't be deleted.");
      if (role.managed) throw new UserError(`${role.name} is managed by an integration and can't be deleted.`);
      if (role.position >= me.roles.highest.position) throw new UserError(`${role.name} is at or above the bot's highest role.`);
      // A role members can still pick must leave the menu first, or its button would point at nothing.
      if (ctx.store.listSelfRoles(guild.id).some((r) => r.roleId === role.id)) throw new UserError(`${role.name} is in the self-assign menu: remove it there first (set_self_role with remove: true).`);
      const gone = { id: role.id, name: role.name, members: role.members.size };
      await role.delete(reasonFor(reason));
      log(`deleted role ${gone.name}`);
      return { deleted: gone };
    }),
  );

  server.registerTool(
    'edit_server',
    {
      title: 'Edit server settings',
      description: 'Sets the system channel (Discord join/boost messages), the AFK voice channel and the verification level (what a new member needs before they can write: 0 none, 1 verified email, 2 account older than 5 minutes, 3 member for 10 minutes, 4 verified phone).',
      inputSchema: {
        verification_level: z.number().int().min(0).max(4).optional(),
        system_channel_id: snowflake.nullable().optional(),
        afk_channel_id: snowflake.nullable().optional(),
        afk_timeout_seconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]).optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ system_channel_id, afk_channel_id, afk_timeout_seconds, verification_level, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageGuild');
      const edited = await guild.edit({
        verificationLevel: verification_level,
        systemChannel: system_channel_id,
        afkChannel: afk_channel_id,
        afkTimeout: afk_timeout_seconds,
        reason: reasonFor(reason),
      });
      log('edited server settings');
      return { systemChannel: edited.systemChannel?.name ?? null, afkChannel: edited.afkChannel?.name ?? null, afkTimeout: edited.afkTimeout, verificationLevel: edited.verificationLevel };
    }),
  );

  server.registerTool(
    'read_messages',
    {
      title: 'Read channel messages',
      description:
        'Reads the latest messages of a text channel (newest first, up to 100), including embed text, what Components V2 messages show (the World State boards: their text, then each row of buttons and menus as [label]) and attachment links. Use it to see what is there before rewriting or clearing a channel.',
      inputSchema: { channel_id: snowflake, limit: z.number().int().min(1).max(100).optional() },
      annotations: READ_ONLY,
    },
    tool(async ({ channel_id, limit }) => {
      const { guild } = await guildFor(ctx);
      const channel = await getChannel(guild, channel_id);
      if (!channel.isTextBased()) throw new UserError(`#${channel.name} is not a text channel.`);
      const batch = await channel.messages.fetch({ limit: limit ?? 50 });
      return {
        channel: channel.name,
        messages: [...batch.values()].map((m) => ({
          id: m.id,
          author: m.author.username,
          bot: m.author.bot,
          pinned: m.pinned,
          at: m.createdAt.toISOString(),
          content: m.content,
          embeds: m.embeds.map((e) => ({ title: e.title, description: e.description, fields: e.fields.map((f) => `${f.name}: ${f.value}`), image: e.image?.url ?? null })),
          components: m.components.length ? componentText(m.components) : undefined,
          attachments: [...m.attachments.values()].map((a) => a.url),
        })),
      };
    }),
  );

  server.registerTool(
    'clear_messages',
    {
      title: 'Clear a channel',
      description:
        'PERMANENTLY deletes every message in a text channel, pinned ones included (messages older than 14 days go one by one, up to 300 per call). Read the channel first and get the user to confirm: it cannot be undone. Requires confirm: true.',
      inputSchema: { channel_id: snowflake, confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    tool(async ({ channel_id }) => {
      const { guild } = await guildFor(ctx);
      const channel = await getChannel(guild, channel_id);
      if (!channel.isTextBased() || channel.isDMBased()) throw new UserError(`#${channel.name} is not a text channel.`);
      const result = await runPurge(channel, 'all', { includePinned: true });
      log(`cleared #${channel.name} (${result.deleted} messages)`);
      return result;
    }),
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post message',
      description:
        'Posts a plain message (e.g. rules or a channel guide) in a channel, optionally pinned. Visible to everyone in that channel: confirm the text with the user first. Mentions never ping.',
      inputSchema: { channel_id: snowflake, content: z.string().min(1).max(2000), pin: z.boolean().optional() },
      annotations: WRITE,
    },
    tool(async ({ channel_id, content, pin }) => {
      const { guild } = await guildFor(ctx);
      const channel = await getChannel(guild, channel_id);
      if (!channel.isSendable()) throw new UserError(`#${channel.name} is not a channel the bot can post in.`);
      const message = await channel.send({ content, allowedMentions: { parse: [] } });
      if (pin) await message.pin();
      log(`posted in #${channel.name}${pin ? ' (pinned)' : ''}`);
      return { messageId: message.id, link: message.url, pinned: Boolean(pin) };
    }),
  );

  server.registerTool(
    'edit_message',
    {
      title: 'Edit a bot message',
      description:
        'Replaces the text of a message the bot wrote earlier (a rules post, a role guide, a notice), keeping its embeds. With `embed`, the message becomes an embed in the same look as Ordis panels (brand colour, optional clan logo and footer) and `content` is an optional line above it (empty removes the old text). Discord only lets the bot edit its own messages: find the message_id with read_messages (bot: true), and anything written by a person is refused. Visible to everyone in that channel: confirm the new text with the user first. Mentions never ping.',
      inputSchema: {
        channel_id: snowflake,
        message_id: snowflake,
        content: z.string().max(2000).optional(),
        embed: z
          .object({
            title: z.string().min(1).max(256),
            description: z.string().max(4096).optional(),
            fields: z.array(z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().optional() })).max(25).optional(),
            logo: z.boolean().optional().describe('Show the clan logo in the corner'),
            footer: z.string().max(2048).optional(),
          })
          .optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ channel_id, message_id, content, embed }) => {
      const { guild } = await guildFor(ctx);
      const channel = await getChannel(guild, channel_id);
      if (!channel.isTextBased()) throw new UserError(`#${channel.name} is not a text channel.`);
      const botId = ctx.client.user?.id ?? '';
      if (!embed && !content?.trim()) throw new UserError('Give the new text (content), an embed, or both.');
      const message = embed
        ? await editOwnMessageCard(channel, message_id, cardEmbed(embed, { color: COLORS.brand, icon: brandIcon(ctx) }), botId, content ?? '')
        : await editOwnMessage(channel, message_id, content ?? '', botId);
      log(`edited a bot message in #${channel.name}`);
      return { messageId: message.id, link: message.url };
    }),
  );

  server.registerTool(
    'delete_message',
    {
      title: 'Delete one bot message',
      description:
        'Permanently deletes ONE message the bot wrote itself (an outdated post or notice); anything a person wrote is refused. Find the message_id with read_messages (bot: true) and confirm with the user first: it cannot be undone.',
      inputSchema: { channel_id: snowflake, message_id: snowflake, confirm: z.literal(true) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    tool(async ({ channel_id, message_id }) => {
      const { guild } = await guildFor(ctx);
      const channel = await getChannel(guild, channel_id);
      if (!channel.isTextBased()) throw new UserError(`#${channel.name} is not a text channel.`);
      await deleteOwnMessage(channel, message_id, ctx.client.user?.id ?? '');
      log(`deleted a bot message in #${channel.name}`);
      return { deleted: message_id };
    }),
  );

  server.registerTool(
    'list_backups',
    {
      title: 'Server backups',
      description: 'Stored server backups (Xenon-style snapshots of roles, channels, permissions, emojis, bans), newest first.',
      annotations: READ_ONLY,
    },
    tool(async () =>
      ctx.store.listBackups(ctx.config.DISCORD_GUILD_ID).map((b) => ({
        id: b.id,
        createdAt: new Date(b.createdAt).toISOString(),
        label: b.label,
        auto: b.auto,
        ...summaryOf(b),
      })),
    ),
  );

  server.registerTool(
    'create_backup',
    {
      title: 'Back up the server',
      description: 'Takes a server backup now. Good practice before restructuring the server. Restoring is done by an admin with /backup load in Discord.',
      inputSchema: { label: z.string().max(80).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async ({ label }) => {
      const stored = await takeBackup(ctx, label ?? null, false);
      return { id: stored.id, createdAt: new Date(stored.createdAt).toISOString(), ...summaryOf(stored) };
    }),
  );

  server.registerTool(
    'update_bot',
    {
      title: 'Update the bot',
      description: 'Makes Watchtower check Docker Hub now and, if a newer bot image exists, pull it and restart the bot on it. Use after a push once CI has finished building the image. The bot is briefly offline.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async () => ({ message: await requestUpdate(ctx.config) })),
  );

  server.registerTool(
    'restart_bot',
    {
      title: 'Restart the bot',
      description: 'Restarts the bot process on the image it already runs (it does not fetch a newer image: use update_bot for that). The bot is briefly offline.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async () => {
      scheduleRestart();
      return { message: 'Restarting in a moment. Docker brings the bot back within seconds.' };
    }),
  );

  server.registerTool(
    'list_activities',
    {
      title: 'List LFG activities',
      description: 'Lists the /lfg activities that have settings: their picture URL and fixed channel.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(async () => ctx.store.listActivities()),
  );

  server.registerTool(
    'set_activity',
    {
      title: 'Set an LFG activity',
      description:
        'Adds or updates an /lfg activity: its picture (https image URL shown on the squad post) and an optional fixed channel its squads are posted in. Only the fields you pass change; null clears one.',
      inputSchema: {
        name: z.string().min(1).max(100),
        image_url: z.string().max(1000).nullable().optional(),
        channel_id: snowflake.nullable().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async (args) => {
      const { guild } = await guildFor(ctx);
      const existing = ctx.store.getActivity(args.name);
      let imageUrl = existing?.imageUrl ?? null;
      if (args.image_url !== undefined) {
        imageUrl = args.image_url === null ? null : validImageUrl(args.image_url);
        if (args.image_url !== null && !imageUrl) throw new UserError('image_url must be a direct https link to an image, without spaces.');
      }
      if (args.channel_id && !guild.channels.cache.has(args.channel_id)) throw new UserError(`channel_id ${args.channel_id} not found in the server.`);
      const saved = {
        name: existing?.name ?? args.name,
        imageUrl,
        channelId: args.channel_id !== undefined ? args.channel_id : (existing?.channelId ?? null),
      };
      ctx.store.saveActivity(saved);
      log(`activity: ${JSON.stringify(saved)}`);
      return saved;
    }),
  );

  server.registerTool(
    'remove_activity',
    {
      title: 'Remove an LFG activity setting',
      description: "Removes an activity's picture and channel settings. The activity still works in /lfg, just plain.",
      inputSchema: { name: z.string().min(1).max(100) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ name }) => {
      if (!ctx.store.removeActivity(name)) throw new UserError(`"${name}" has no settings.`);
      log(`activity removed: ${name}`);
      return { removed: name };
    }),
  );

  server.registerTool(
    'test_welcome',
    {
      title: 'Send a test welcome greeting',
      description: 'Posts the greeting a new member gets, for an existing member, in the welcome channel (the same code as a real join). Visible to everyone there and pings that member: confirm with the user first.',
      inputSchema: { user_id: snowflake },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    tool(async ({ user_id }) => {
      const { guild } = await guildFor(ctx);
      const member = await guild.members.fetch(user_id).catch(() => null);
      if (!member) throw new UserError('That user is not a member of the clan server.');
      const channelId = ctx.store.getSettings(guild.id).welcomeChannelId;
      if (!channelId) throw new UserError('No welcome channel is set: set welcome_channel_id with update_bot_settings first.');
      if (!(await postWelcome(ctx, member))) throw new UserError('The greeting could not be posted (see the bot log): check that Ordis can write in the welcome channel.');
      return { sent: true, channelId, member: member.displayName };
    }),
  );

  server.registerTool(
    'update_bot_settings',
    {
      title: "Set the bot's channels",
      description:
        'Points the bot at channels: the seven World State boards (alerts, arbitrations, fissures, sortie, cycles, traders, invasions; one live board per channel, a channel holds one), announcements & events, welcome messages, the Ordis chat channel, the moderation log, the audit log, the staff status-report channel, the level-up channel, the honeypot trap channel (+ its action), the riven scanning channel, the squads channel, the birthday channel, the weekly reset post channel, the promo codes channel and the game news channel. null turns one off. There are no ping roles: every notification is a DM a member asked for.',
      inputSchema: {
        alerts_channel_id: snowflake.nullable().optional().describe('World State board: alerts, Gifts of the Lotus, events and Nightwave'),
        arbitrations_channel_id: snowflake.nullable().optional().describe('World State board: the Arbitration now, the next 48 hours with tiers and the best of the week'),
        fissures_channel_id: snowflake.nullable().optional().describe('World State board: normal, Steel Path and Void Storm fissures by relic tier'),
        sortie_channel_id: snowflake.nullable().optional().describe('World State board: sortie, Archon Hunt, Archimedeas and Steel Path honors'),
        cycles_channel_id: snowflake.nullable().optional().describe('World State board: open world cycles with their next changes, the Duviri Circuit and bounties'),
        traders_channel_id: snowflake.nullable().optional().describe("World State board: Baro Ki'Teer, Darvo, Varzia's Prime Resurgence and Teshin"),
        invasions_channel_id: snowflake.nullable().optional().describe('World State board: every invasion with both rewards and its progress'),
        announcements_channel_id: snowflake.nullable().optional(),
        welcome_channel_id: snowflake.nullable().optional(),
        chat_channel_id: snowflake.nullable().optional(),
        mod_log_channel_id: snowflake.nullable().optional(),
        audit_log_channel_id: snowflake.nullable().optional().describe('Audit log: deleted/edited messages, role and channel changes, voice. Falls back to the moderation log when null'),
        status_channel_id: snowflake.nullable().optional().describe('Staff channel for the bot\'s start / shutdown / restart reports'),
        level_channel_id: snowflake.nullable().optional().describe('Where level-ups are announced; null announces where the member is talking'),
        honeypot_channel_id: snowflake.nullable().optional().describe('Trap channel: anyone without moderator powers who posts there is removed. Posts a "do not post" notice in it.'),
        honeypot_action: z.enum(HONEYPOT_ACTIONS).optional().describe('softban (default: remove + clear the last hour of messages, can rejoin), ban or kick'),
        riven_channel_id: snowflake.nullable().optional().describe('Riven channel: members post a screenshot of an unveiled riven and Ordis answers with a picture grading every stat. Posts a one-line note in it; null turns it off'),
        lfg_voice_category_id: snowflake.nullable().optional().describe('Category where every /lfg squad gets its own temporary voice channel; null turns squad voice off'),
        auto_vc_hub_channel_id: snowflake.nullable().optional().describe('Join-to-create lobby: a voice channel that gives whoever joins it their own temporary room next to it; null turns it off'),
        lfg_voice_grace_minutes: z.number().int().min(1).max(60).nullable().optional().describe('Minutes the host may be out of voice before the squad ends (default 5)'),
        lfg_channel_id: snowflake.nullable().optional().describe('Where a squad started from a board (the "Squad up" button) is posted; /lfg itself posts where it is used'),
        birthday_channel_id: snowflake.nullable().optional().describe('Where Ordis wishes members a happy birthday (/birthday set)'),
        weekly_channel_id: snowflake.nullable().optional().describe('Where Ordis posts what the Monday reset brought; the first post is the next Monday'),
        promo_channel_id: snowflake.nullable().optional().describe('Channel with the active promo codes from the wiki, updated once a day; the list appears within a minute'),
        news_channel_id: snowflake.nullable().optional().describe('Channel for new game news: in-game news (updates, Prime Access, Devstreams) and Warframe Steam announcements. The first read only records what exists; new posts follow'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async (args) => {
      const { guild } = await guildFor(ctx);
      for (const [key, id] of Object.entries(args)) {
        if (typeof id !== 'string' || !id || key === 'honeypot_action') continue;
        const channel = guild.channels.cache.get(id);
        if (!channel) throw new UserError(`${key}: ${id} not found in the server.`);
        const kind = own(SETTING_CHANNEL_KINDS, key);
        if (kind && !kind.types.includes(channel.type)) throw new UserError(`${key}: ${channel.name} is the wrong kind of channel, this setting needs ${kind.label}.`);
      }
      // Everything is checked before anything is saved, so a refused change leaves the settings as they were.
      assertChannelFree(ctx, {
        chatChannelId: args.chat_channel_id,
        honeypotChannelId: args.honeypot_channel_id,
        rivenChannelId: args.riven_channel_id,
        alertsChannelId: args.alerts_channel_id,
        arbitrationsChannelId: args.arbitrations_channel_id,
        fissuresChannelId: args.fissures_channel_id,
        sortieChannelId: args.sortie_channel_id,
        cyclesChannelId: args.cycles_channel_id,
        tradersChannelId: args.traders_channel_id,
        invasionsChannelId: args.invasions_channel_id,
      });
      const patch = {
        ...(args.alerts_channel_id !== undefined ? { alertsChannelId: args.alerts_channel_id } : {}),
        ...(args.arbitrations_channel_id !== undefined ? { arbitrationsChannelId: args.arbitrations_channel_id } : {}),
        ...(args.fissures_channel_id !== undefined ? { fissuresChannelId: args.fissures_channel_id } : {}),
        ...(args.sortie_channel_id !== undefined ? { sortieChannelId: args.sortie_channel_id } : {}),
        ...(args.cycles_channel_id !== undefined ? { cyclesChannelId: args.cycles_channel_id } : {}),
        ...(args.traders_channel_id !== undefined ? { tradersChannelId: args.traders_channel_id } : {}),
        ...(args.invasions_channel_id !== undefined ? { invasionsChannelId: args.invasions_channel_id } : {}),
        ...(args.announcements_channel_id !== undefined ? { announcementsChannelId: args.announcements_channel_id } : {}),
        ...(args.welcome_channel_id !== undefined ? { welcomeChannelId: args.welcome_channel_id } : {}),
        ...(args.chat_channel_id !== undefined ? { chatChannelId: args.chat_channel_id } : {}),
        ...(args.mod_log_channel_id !== undefined ? { modLogChannelId: args.mod_log_channel_id } : {}),
        ...(args.audit_log_channel_id !== undefined ? { auditLogChannelId: args.audit_log_channel_id } : {}),
        ...(args.status_channel_id !== undefined ? { statusChannelId: args.status_channel_id } : {}),
        ...(args.level_channel_id !== undefined ? { levelChannelId: args.level_channel_id } : {}),
        ...(args.lfg_voice_category_id !== undefined ? { lfgVoiceCategoryId: args.lfg_voice_category_id } : {}),
        ...(args.auto_vc_hub_channel_id !== undefined ? { autoVcHubChannelId: args.auto_vc_hub_channel_id } : {}),
        ...(args.lfg_voice_grace_minutes !== undefined ? { lfgVoiceGraceMinutes: args.lfg_voice_grace_minutes } : {}),
        ...(args.lfg_channel_id !== undefined ? { lfgChannelId: args.lfg_channel_id } : {}),
        ...(args.birthday_channel_id !== undefined ? { birthdayChannelId: args.birthday_channel_id } : {}),
        ...(args.weekly_channel_id !== undefined ? { weeklyChannelId: args.weekly_channel_id } : {}),
        ...(args.promo_channel_id !== undefined ? { promoChannelId: args.promo_channel_id } : {}),
        ...(args.news_channel_id !== undefined ? { newsChannelId: args.news_channel_id } : {}),
      };
      log(`bot settings: ${JSON.stringify(patch)}`);
      // The two channels that get a notice posted in them go first: if the bot can't post there nothing else has been saved yet.
      if (args.honeypot_channel_id) {
        await setupHoneypot(ctx, args.honeypot_channel_id, honeypotAction(args.honeypot_action ?? ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).honeypotAction));
      } else if (args.honeypot_channel_id === null) {
        disableHoneypot(ctx);
      } else if (args.honeypot_action) {
        ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { honeypotAction: args.honeypot_action });
      }
      if (args.riven_channel_id) {
        await setupRivenChannel(ctx, args.riven_channel_id);
      } else if (args.riven_channel_id === null) {
        disableRivenChannel(ctx);
      }
      if (args.weekly_channel_id) skipCurrentWeek(ctx);
      const saved = ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, patch);
      if (args.chat_channel_id) void syncChatTopic(ctx);
      return saved;
    }),
  );
}
