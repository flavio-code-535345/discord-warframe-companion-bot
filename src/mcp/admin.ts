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
import { setupVerification } from '../discord/verification.js';
import type { AppContext } from '../context.js';
import { HONEYPOT_ACTIONS, disableHoneypot, honeypotAction, setupHoneypot } from '../moderation/honeypot.js';
import { UserError } from '../services/clan.js';
import { READ_ONLY, snowflake, tool } from './util.js';

/**
 * Server administration over MCP, for restructuring the clan Discord with an AI assistant. Deliberately
 * no delete operations: retired channels are archived (moved into a hidden category) so nothing is lost,
 * and every change carries an audit-log reason.
 */

const PERMISSIONS = Object.keys(PermissionFlagsBits) as [keyof typeof PermissionFlagsBits, ...(keyof typeof PermissionFlagsBits)[]];
const permission = z.enum(PERMISSIONS);
const ARCHIVE_NAME = '🗄️ Archive';

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
      let archive = guild.channels.cache.find((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === ARCHIVE_NAME);
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
      const before = { name: role.name, color: role.hexColor, position: role.position };
      const edited = await role.edit({ name, color: hexColor(color), hoist, mentionable, permissions, reason: reasonFor(reason) });
      if (position !== undefined) await edited.setPosition(position, { reason: reasonFor(reason) });
      log(`edited role ${before.name} -> ${edited.name}`);
      return { id: edited.id, before, after: { name: edited.name, color: edited.hexColor, position: edited.position } };
    }),
  );

  server.registerTool(
    'edit_server',
    {
      title: 'Edit server settings',
      description: 'Sets the system channel (Discord join/boost messages) and the AFK voice channel.',
      inputSchema: {
        system_channel_id: snowflake.nullable().optional(),
        afk_channel_id: snowflake.nullable().optional(),
        afk_timeout_seconds: z.union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)]).optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: WRITE,
    },
    tool(async ({ system_channel_id, afk_channel_id, afk_timeout_seconds, reason }) => {
      const { guild, me } = await guildFor(ctx);
      requirePermission(me, 'ManageGuild');
      const edited = await guild.edit({
        systemChannel: system_channel_id,
        afkChannel: afk_channel_id,
        afkTimeout: afk_timeout_seconds,
        reason: reasonFor(reason),
      });
      log('edited server settings');
      return { systemChannel: edited.systemChannel?.name ?? null, afkChannel: edited.afkChannel?.name ?? null, afkTimeout: edited.afkTimeout };
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
    'setup_verification',
    {
      title: 'Set up captcha verification',
      description:
        'Posts the Verify panel in a channel and sets the role members get after solving the captcha (refuses roles with moderator/admin permissions). Re-running moves or refreshes the panel.',
      inputSchema: { channel_id: snowflake, role_id: snowflake, min_account_age_days: z.number().int().min(0).max(365).optional() },
      annotations: WRITE,
    },
    tool(async ({ channel_id, role_id, min_account_age_days }) => ({ panel: await setupVerification(ctx, channel_id, role_id, min_account_age_days || null) })),
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
    'update_bot_settings',
    {
      title: "Set the bot's channels",
      description: 'Points the bot at channels: worldstate alerts (+ ping role), announcements & events, welcome messages, the Ordis chat channel, the moderation log and the honeypot trap channel (+ its action). null turns one off.',
      inputSchema: {
        alerts_channel_id: snowflake.nullable().optional(),
        alerts_role_id: snowflake.nullable().optional(),
        announcements_channel_id: snowflake.nullable().optional(),
        welcome_channel_id: snowflake.nullable().optional(),
        chat_channel_id: snowflake.nullable().optional(),
        mod_log_channel_id: snowflake.nullable().optional(),
        honeypot_channel_id: snowflake.nullable().optional().describe('Trap channel: anyone without moderator powers who posts there is removed. Posts a "do not post" notice in it.'),
        honeypot_action: z.enum(HONEYPOT_ACTIONS).optional().describe('softban (default: remove + clear the last hour of messages, can rejoin), ban or kick'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async (args) => {
      const { guild } = await guildFor(ctx);
      for (const [key, id] of Object.entries(args)) {
        if (!id || key === 'honeypot_action') continue;
        if (key === 'alerts_role_id' ? !guild.roles.cache.has(id) : !guild.channels.cache.has(id)) throw new UserError(`${key}: ${id} not found in the server.`);
      }
      const patch = {
        ...(args.alerts_channel_id !== undefined ? { alertsChannelId: args.alerts_channel_id } : {}),
        ...(args.alerts_role_id !== undefined ? { alertsRoleId: args.alerts_role_id } : {}),
        ...(args.announcements_channel_id !== undefined ? { announcementsChannelId: args.announcements_channel_id } : {}),
        ...(args.welcome_channel_id !== undefined ? { welcomeChannelId: args.welcome_channel_id } : {}),
        ...(args.chat_channel_id !== undefined ? { chatChannelId: args.chat_channel_id } : {}),
        ...(args.mod_log_channel_id !== undefined ? { modLogChannelId: args.mod_log_channel_id } : {}),
      };
      log(`bot settings: ${JSON.stringify(patch)}`);
      const saved = ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, patch);
      if (args.honeypot_channel_id) {
        await setupHoneypot(ctx, args.honeypot_channel_id, honeypotAction(args.honeypot_action ?? saved.honeypotAction));
      } else if (args.honeypot_channel_id === null) {
        disableHoneypot(ctx);
      } else if (args.honeypot_action) {
        ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { honeypotAction: args.honeypot_action });
      }
      return ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
    }),
  );
}
