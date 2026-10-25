import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { PLATFORMS } from '../discord/commands/clan.js';
import { UserError, cancelClanEvent, createClanEvent, postAnnouncement } from '../services/clan.js';
import { parseWhen } from '../time.js';
import { searchDrops } from '../warframe/drops.js';
import { lookupItem, summarizeLookup } from '../warframe/items.js';
import { readWikiPage, searchWiki } from '../warframe/wiki.js';
import { priceCheck } from '../warframe/market.js';
import { FISSURE_TIERS, filterFissures, getWorldState } from '../warframe/worldstate.js';
import { registerAdminTools } from './admin.js';
import { READ_ONLY, snowflake, tool } from './util.js';
import { DEFAULT_SECTIONS, SECTIONS, summarizeFissures, summarizeWorldState } from './worldstate-summary.js';


/**
 * Builds the MCP server exposing Warframe data and clan management. A new instance is created
 * per HTTP request (stateless Streamable HTTP), so this must stay cheap: no I/O at build time.
 */
export function createMcpServer(ctx: AppContext): McpServer {
  const { config, store, client } = ctx;
  const guildId = config.DISCORD_GUILD_ID;
  const server = new McpServer(
    { name: 'cephalon-ordis', title: config.BOT_NAME, version: '1.0.0' },
    {
      instructions:
        `${config.BOT_NAME}, the companion bot for the Warframe clan "${config.CLAN_NAME}" and its Discord server. ` +
        'Use the get_* tools for live Warframe data and clan info. Tools that post to Discord ' +
        '(send_announcement, create_event) are visible to the whole clan: confirm wording with the user first. ' +
        'Call list_channels_and_roles to find channel and role IDs. Server admin tools (create/edit channels and roles) ' +
        'change the real server: show the user the plan and get approval before using them.',
    },
  );

  // --- Warframe data ---

  server.registerTool(
    'get_worldstate',
    {
      title: 'Warframe world state',
      description:
        'Live Warframe world state: open-world cycles, daily sortie, weekly Archon Hunt, Baro Ki\'Teer, Steel Path reward, Nightwave, invasions, alerts, Darvo\'s deal, events, Deep/Temporal Archimedea, syndicate bounties and Varzia\'s Prime Resurgence. Times are ISO-8601 UTC with a relative "in" string.',
      inputSchema: {
        sections: z.array(z.enum(SECTIONS)).optional().describe('Limit to these sections (default: all except bounties and resurgence)'),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ sections }) => summarizeWorldState(await getWorldState(), sections?.length ? sections : DEFAULT_SECTIONS)),
  );

  server.registerTool(
    'get_fissures',
    {
      title: 'Void fissures',
      description: 'Active Void fissure missions for cracking relics, sorted by tier then time left.',
      inputSchema: {
        tier: z.enum(FISSURE_TIERS).optional(),
        steel_path: z.boolean().optional().describe('true = only Steel Path, false = only normal'),
        void_storm: z.boolean().optional().describe('true = only Railjack Void Storms, false = exclude them'),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ tier, steel_path, void_storm }) => {
      const ws = await getWorldState();
      return summarizeFissures(filterFissures(ws.fissures, { tier, steelPath: steel_path, storm: void_storm }));
    }),
  );

  server.registerTool(
    'price_check',
    {
      title: 'warframe.market price check',
      description: 'Cheapest online sellers and best online buyers for a tradable item on warframe.market.',
      inputSchema: { item: z.string().min(2).describe('Item name, e.g. "Arcane Energize" or "Wisp Prime Set"') },
      annotations: READ_ONLY,
    },
    tool(async ({ item }) => {
      const p = await priceCheck(item, config.WARFRAME_PLATFORM);
      const order = (o: (typeof p.sell)[number]) => ({ platinum: o.platinum, quantity: o.quantity, rank: o.rank, seller: o.user.ingameName, status: o.user.status });
      return { item: p.item.name, url: p.url, platform: config.WARFRAME_PLATFORM, sell: p.sell.map(order), buy: p.buy.map(order) };
    }),
  );

  server.registerTool(
    'search_drops',
    {
      title: 'Drop table search',
      description: 'Where an item, mod, resource or relic drops, with drop chances.',
      inputSchema: { item: z.string().min(2) },
      annotations: READ_ONLY,
    },
    tool(async ({ item }) => searchDrops(item)),
  );

  server.registerTool(
    'lookup_item',
    {
      title: 'Item lookup',
      description:
        'Stats for a Warframe, weapon (incl. riven disposition), mod or arcane (effect at max rank), or relic (contents with intact/radiant chances, vaulted status).',
      inputSchema: { name: z.string().min(2).describe('e.g. "Wisp Prime", "Kuva Bramma", "Neo N16"') },
      annotations: READ_ONLY,
    },
    tool(async ({ name }) => {
      const result = await lookupItem(name);
      if (!result) throw new UserError(`No item matches "${name}".`);
      return summarizeLookup(result);
    }),
  );

  server.registerTool(
    'search_wiki',
    {
      title: 'Warframe wiki search',
      description: 'Search wiki.warframe.com; returns the top pages with intro paragraphs. Pass read_full=true to get the first result as full text.',
      inputSchema: { query: z.string().min(2), read_full: z.boolean().optional() },
      annotations: READ_ONLY,
    },
    tool(async ({ query, read_full }) => {
      const results = await searchWiki(query, 3);
      if (read_full && results[0]) return (await readWikiPage(results[0].title)) ?? results;
      return results;
    }),
  );

  // --- Clan & Discord ---

  server.registerTool(
    'get_clan_overview',
    {
      title: 'Clan overview',
      description: 'Clan name, Discord server stats, configured bot channels and the next scheduled events.',
      annotations: READ_ONLY,
    },
    tool(async () => {
      const guild = await client.guilds.fetch(guildId);
      const settings = store.getSettings(guildId);
      return {
        clan: config.CLAN_NAME,
        bot: config.BOT_NAME,
        discordServer: { id: guild.id, name: guild.name, memberCount: guild.memberCount },
        registeredMembers: store.listMembers(guildId).length,
        channels: {
          alerts: settings.alertsChannelId,
          alertsPingRole: settings.alertsRoleId,
          announcements: settings.announcementsChannelId,
          welcome: settings.welcomeChannelId,
        },
        upcomingEvents: store.upcomingEvents(guildId).slice(0, 5).map((e) => ({ id: e.id, title: e.title, startsAt: new Date(e.startsAt).toISOString() })),
      };
    }),
  );

  server.registerTool(
    'list_clan_members',
    {
      title: 'Clan roster',
      description: 'Members who linked their Warframe in-game name with the bot, with Discord username, mastery rank and platform.',
      annotations: READ_ONLY,
    },
    tool(async () =>
      Promise.all(
        store.listMembers(guildId).map(async (m) => {
          const user = await client.users.fetch(m.userId).catch(() => null);
          return {
            ign: m.ign,
            discordUserId: m.userId,
            discordUsername: user?.username ?? null,
            displayName: user?.globalName ?? user?.username ?? null,
            masteryRank: m.masteryRank,
            platform: m.platform,
            registeredAt: new Date(m.registeredAt).toISOString(),
          };
        }),
      ),
    ),
  );

  server.registerTool(
    'list_channels_and_roles',
    {
      title: 'Discord channels and roles',
      description: 'Text channels (with whether the bot can post there) and roles in the clan Discord server.',
      annotations: READ_ONLY,
    },
    tool(async () => {
      const guild = await client.guilds.fetch(guildId);
      const [channels, roles, me] = await Promise.all([guild.channels.fetch(), guild.roles.fetch(), guild.members.fetchMe()]);
      return {
        channels: [...channels.values()]
          .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
          .map((c) => ({
            id: c!.id,
            name: c!.name,
            category: c!.parent?.name ?? null,
            botCanPost: c!.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
          })),
        roles: [...roles.values()]
          .filter((r) => r.id !== guild.id && !r.managed)
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, mentionable: r.mentionable })),
      };
    }),
  );

  server.registerTool(
    'list_events',
    {
      title: 'Upcoming clan events',
      description: 'Scheduled clan events that have not started yet, with RSVPs.',
      annotations: READ_ONLY,
    },
    tool(async () =>
      store.upcomingEvents(guildId).map((e) => {
        const r = store.getRsvps(e.id);
        return {
          id: e.id,
          title: e.title,
          description: e.description,
          startsAt: new Date(e.startsAt).toISOString(),
          rsvps: { going: r.going, maybe: r.maybe, declined: r.declined },
          link: e.channelId && e.messageId ? `https://discord.com/channels/${guildId}/${e.channelId}/${e.messageId}` : null,
        };
      }),
    ),
  );

  server.registerTool(
    'create_event',
    {
      title: 'Create clan event',
      description:
        'Schedules a clan event and posts it with RSVP buttons. Attendees get a reminder 15 minutes before it starts. Posts publicly in Discord.',
      inputSchema: {
        title: z.string().min(1).max(200),
        starts_at: z.string().describe('ISO-8601 time with zone (e.g. "2026-11-02T20:00:00Z") or relative like "2h", "1d 4h"'),
        description: z.string().max(2000).optional(),
        channel_id: snowflake.optional().describe('Defaults to the configured announcements channel'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(async ({ title, starts_at, description, channel_id }) => {
      const startsAt = parseWhen(starts_at);
      if (startsAt === null) throw new UserError(`Could not parse starts_at "${starts_at}".`);
      const event = await createClanEvent(ctx, { title, description, startsAt, createdBy: client.user!.id, channelId: channel_id });
      return { id: event.id, title: event.title, startsAt: new Date(event.startsAt).toISOString(), link: `https://discord.com/channels/${guildId}/${event.channelId}/${event.messageId}` };
    }),
  );

  server.registerTool(
    'cancel_event',
    {
      title: 'Cancel clan event',
      description: 'Marks a clan event as cancelled and updates its Discord post.',
      inputSchema: { event_id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    tool(async ({ event_id }) => {
      const e = await cancelClanEvent(ctx, event_id);
      return { id: e.id, title: e.title, cancelled: e.cancelled };
    }),
  );

  server.registerTool(
    'send_announcement',
    {
      title: 'Send clan announcement',
      description:
        'Posts an announcement embed in the clan Discord. @everyone/@here in the text will not ping; use ping_role_id to notify a role.',
      inputSchema: {
        message: z.string().min(1).max(4000).describe('Markdown body'),
        title: z.string().max(256).optional(),
        channel_id: snowflake.optional().describe('Defaults to the configured announcements channel'),
        ping_role_id: snowflake.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(async ({ message, title, channel_id, ping_role_id }) => {
      const sent = await postAnnouncement(ctx, { message, title, channelId: channel_id, pingRoleId: ping_role_id });
      return { messageId: sent.id, channelId: sent.channelId, link: sent.url };
    }),
  );

  server.registerTool(
    'register_member',
    {
      title: 'Register clan member',
      description: "Links a Discord member to their Warframe in-game name in the clan roster (adds or updates).",
      inputSchema: {
        discord_user_id: snowflake,
        ign: z.string().min(1).max(32),
        mastery_rank: z.number().int().min(0).max(60).optional(),
        platform: z.enum(PLATFORMS).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ discord_user_id, ign, mastery_rank, platform }) => {
      const guild = await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(discord_user_id).catch(() => null);
      if (!member) throw new UserError(`User ${discord_user_id} is not in the clan Discord server.`);
      try {
        return store.upsertMember({ guildId, userId: discord_user_id, ign, masteryRank: mastery_rank ?? null, platform: platform ?? null });
      } catch (err) {
        throw new UserError((err as Error).message);
      }
    }),
  );

  server.registerTool(
    'remove_member',
    {
      title: 'Remove clan member',
      description: 'Removes a member from the clan roster (does not kick them from Discord).',
      inputSchema: { discord_user_id: snowflake },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ discord_user_id }) => ({ removed: store.removeMember(guildId, discord_user_id) })),
  );

  registerAdminTools(server, ctx);

  return server;
}
