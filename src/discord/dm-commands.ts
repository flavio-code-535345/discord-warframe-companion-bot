import { type Interaction, InteractionContextType, ApplicationIntegrationType } from 'discord.js';
import type { AppContext } from '../context.js';
import type { Command } from './command.js';

/**
 * Commands in a DM with Ordis. The bot serves one server only, so a DM is answered for a member of that server and for nobody else
 * (`isClanMember`). Only the personal commands work there: the ones that read the world state, look things up, keep a member's own
 * trackers, reminders, wishlist and roster entry. Everything that posts in or changes the server (events, squads, roles, setup,
 * moderation, levels, stickies, backups) stays in the server.
 */
export const DM_COMMAND_NAMES: ReadonlySet<string> = new Set(['now', 'wf', 'item', 'price', 'relics', 'wishlist', 'riven', 'alecaframe', 'drops', 'wiki', 'ask', 'track', 'clan', 'remindme']);

/** The menus a DM command's reply can carry (`/track` pickers, the wishlist card). */
const DM_COMPONENT_PREFIXES = ['trackpick:', 'wish:'];

/** The global commands: the DM-safe ones, for the bot's DM only (the server keeps its own guild-scoped copies, so nothing shows twice). */
export function dmCommandData(commands: readonly Command[]): Command['data'][] {
  return commands
    .filter((c) => DM_COMMAND_NAMES.has(c.data.name))
    .map((c) => ({ ...c.data, contexts: [InteractionContextType.BotDM], integration_types: [ApplicationIntegrationType.GuildInstall] }));
}

/**
 * Registers them with Discord, but only when the list changed since the last start (bot_meta `dm_commands`): a bulk overwrite of the
 * global commands is rate-limited, and nothing changes at most starts.
 */
export async function syncDmCommands(ctx: AppContext, commands: readonly Command[]): Promise<boolean> {
  const data = dmCommandData(commands);
  const fingerprint = JSON.stringify(data);
  if (ctx.store.getMeta('dm_commands') === fingerprint) return false;
  await ctx.client.application?.commands.set(data);
  ctx.store.setMeta('dm_commands', fingerprint);
  return true;
}

const MEMBER_OK_MS = 5 * 60_000;
const MEMBER_NO_MS = 60_000;
const memberCache = new Map<string, { member: boolean; at: number }>();

/** Whether this person is in the clan's server (asked of Discord, kept 5 minutes, a "no" only one). */
export async function isClanMember(ctx: Pick<AppContext, 'client' | 'config'>, userId: string, now = Date.now()): Promise<boolean> {
  const known = memberCache.get(userId);
  if (known && now - known.at < (known.member ? MEMBER_OK_MS : MEMBER_NO_MS)) return known.member;
  let member = false;
  try {
    const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
    member = !!(await guild.members.fetch(userId));
  } catch (err) {
    // Only Discord's "Unknown Member" (10007) means they are not in the server; anything else is a failure to ask, not an answer.
    if ((err as { code?: number } | null)?.code !== 10007) throw err;
  }
  memberCache.set(userId, { member, at: now });
  return member;
}

/** Forgets what was cached (tests). */
export const clearMemberCache = (): void => memberCache.clear();

/** Whether a DM interaction is one of the DM commands (or a menu its reply carries). */
export function isDmInteraction(interaction: Interaction): boolean {
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) return DM_COMMAND_NAMES.has(interaction.commandName);
  if (interaction.isStringSelectMenu()) return DM_COMPONENT_PREFIXES.some((p) => interaction.customId.startsWith(p));
  return false;
}
