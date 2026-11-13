import type { AppContext } from '../context.js';
import { refreshRolesPanel } from '../selfroles/service.js';
import { type TrackerSpec, describeTracker } from '../trackers.js';
import { noticeDm, sendDm } from './dm.js';
import { brandIcon } from './identity.js';
import { staffNotice } from './staff.js';
import { subscribe } from './subscriptions.js';

/**
 * The one-time move from ping roles to DM subscriptions (2026-11-11, at the owner's request: "DM based subscription only"). Ordis used
 * to ping six roles from the self-assign menu: Alerts, Arbitrations, Baro Ki'Teer, Weeklies, Clan Events and Squad Finder. The database
 * migration put their IDs in bot_meta (`legacy_ping_roles:<guild>`); here, once Discord is ready, everyone who holds one of those
 * roles gets the DM notification that says the same thing, the roles leave the menu, each member moved is told in a DM, and the staff
 * channel gets a summary. The roles themselves are not deleted here: that is a decision for a person (they are listed in the summary).
 *
 * Nothing is marked as done until the member list could be read, so a start without it just tries again at the next one.
 */

/** What each role was pinged for, as the notification that replaces it. */
export const ROLE_SUBSCRIPTIONS: Record<string, TrackerSpec> = {
  alerts: { kind: 'notable' },
  arbitrations: { kind: 'arbitration', minTier: 'A' },
  baro: { kind: 'baro' },
  weekly: { kind: 'weekly' },
  events: { kind: 'clanEvent' },
  squads: { kind: 'squad' },
};

const metaKey = (guildId: string) => `legacy_ping_roles:${guildId}`;
/** What the conversion did, kept for the health check: the roles that are now unused and how many members were moved. */
export const DONE_META = 'ping_roles_converted';

export interface PingRoleConversion {
  at: number;
  /** The roles nothing uses any more (id and name), for whoever deletes them. */
  roles: { id: string; name: string }[];
  members: number;
  subscriptions: number;
}

export function pingRoleConversion(ctx: Pick<AppContext, 'store'>): PingRoleConversion | null {
  try {
    return JSON.parse(ctx.store.getMeta(DONE_META) || 'null') as PingRoleConversion | null;
  } catch {
    return null;
  }
}

/** Runs the move when it is still pending. Returns what it did, or null when there was nothing to do (or the members could not be read). */
export async function convertPingRoles(ctx: AppContext): Promise<PingRoleConversion | null> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const raw = ctx.store.getMeta(metaKey(guildId));
  if (!raw) return null;
  let legacy: Record<string, unknown>;
  try {
    legacy = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    ctx.store.setMeta(metaKey(guildId), '');
    return null;
  }

  const guild = await ctx.client.guilds.fetch(guildId);
  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    console.warn('[ping-roles] could not read the member list, so the move to DM notifications waits for the next start:', (err as Error).message);
    return null;
  }

  const roles: { id: string; name: string }[] = [];
  const moved = new Map<string, { roles: string[]; specs: TrackerSpec[]; added: number }>();
  for (const [key, spec] of Object.entries(ROLE_SUBSCRIPTIONS)) {
    const roleId = typeof legacy[key] === 'string' ? (legacy[key] as string) : null;
    if (!roleId) continue;
    const name = guild.roles.cache.get(roleId)?.name ?? key;
    roles.push({ id: roleId, name });
    for (const member of members.values()) {
      if (member.user.bot || !member.roles.cache.has(roleId)) continue;
      const entry = moved.get(member.id) ?? { roles: [], specs: [], added: 0 };
      entry.roles.push(name);
      entry.specs.push(spec);
      // Past the usual limit on purpose: nobody loses a notification they had.
      if (subscribe(ctx, member.id, spec, { force: true }) === 'added') entry.added++;
      moved.set(member.id, entry);
    }
    // The role is no longer something to pick: it leaves the self-assign menu.
    ctx.store.deleteSelfRole(guildId, roleId);
  }

  const result: PingRoleConversion = { at: Date.now(), roles, members: moved.size, subscriptions: [...moved.values()].reduce((n, m) => n + m.added, 0) };
  ctx.store.setMeta(DONE_META, JSON.stringify(result));
  ctx.store.setMeta(metaKey(guildId), '');

  await refreshRolesPanel(ctx).catch((err) => console.warn('[ping-roles] could not update the roles panel:', (err as Error).message));
  const avatar = brandIcon(ctx) ?? null;
  for (const [userId, m] of moved) {
    const lines = [
      `Ordis no longer pings roles. What you want to hear about now comes as a DM, like this one.`,
      `You had the ${m.roles.map((r) => `**${r}**`).join(', ')} role${m.roles.length === 1 ? '' : 's'}, so Ordis keeps telling you about:`,
      ...m.specs.map((spec) => `• ${describeTracker(spec)}`),
      '',
      '-# Change it any time: the **My notifications** button under a World State board lists and removes them, the 🔔 menus there add more, and `/track list` works everywhere.',
    ];
    await sendDm(ctx, userId, noticeDm('🔔 Your notifications are DMs now', lines, avatar), 'the move to DM notifications');
  }
  await staffNotice(ctx, {
    title: '🔔 Notifications are DMs now',
    text: `Ordis pings no role any more. ${moved.size} member${moved.size === 1 ? '' : 's'} held a ping role and now ${moved.size === 1 ? 'has' : 'have'} the same notification as a DM (${result.subscriptions} added). The roles left the role menu and nothing uses them now.`,
    fields: [{ name: 'Roles that can be deleted', value: roles.map((r) => `<@&${r.id}> (${r.name})`).join('\n') || 'none' }],
  });
  console.log(`[ping-roles] moved ${moved.size} members to DM notifications (${result.subscriptions} added); unused roles: ${roles.map((r) => r.name).join(', ') || 'none'}`);
  return result;
}
