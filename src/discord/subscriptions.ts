import { type ButtonInteraction, MessageFlags } from 'discord.js';
import type { AppContext } from '../context.js';
import type { ClanEvent, LfgPost } from '../db.js';
import { UserError } from '../errors.js';
import { MAX_TRACKERS_PER_USER, type TrackerSpec, parseSpec } from '../trackers.js';
import { clanEventDm, sendDm, squadDm } from './dm.js';
import { TOGGLES, isToggle, sameSpec } from './feeds/controls.js';
import { brandIcon } from './identity.js';

/**
 * Ordis pings no role: whoever wants to hear about something asks for it and gets a DM. Most notifications are matched against the
 * world state every minute (trackers.ts, the notifier). The ones here are not: a clan event or a squad is announced the moment it is
 * posted, and the on/off notifications (`TOGGLES`) are switched with one tap on a `notify:<key>` button.
 */

type Ctx = Pick<AppContext, 'store' | 'config'>;

/**
 * Adds a notification for a member unless they already have the same one. `force` skips the per-member limit: it is for moving people
 * over from something they already had, where refusing would silently take a notification away.
 */
export function subscribe(ctx: Ctx, userId: string, spec: TrackerSpec, opts: { force?: boolean } = {}): 'added' | 'had' | 'full' {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const mine = ctx.store.listTrackers(guildId, userId);
  if (mine.some((t) => sameSpec(t.spec, spec))) return 'had';
  if (!opts.force && mine.length >= MAX_TRACKERS_PER_USER) return 'full';
  ctx.store.createTracker(guildId, userId, JSON.stringify(spec));
  return 'added';
}

/** Removes a member's notifications with exactly this spec; true when there was one. */
export function unsubscribe(ctx: Ctx, userId: string, spec: TrackerSpec): boolean {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const same = ctx.store.listTrackers(guildId, userId).filter((t) => sameSpec(t.spec, spec));
  for (const t of same) ctx.store.deleteTracker(guildId, userId, t.id);
  return same.length > 0;
}

/** A tap on `notify:<key>` (or the older `weekly:toggle`): switches that notification on or off for the member. Ephemeral answer. */
export async function handleNotifyButton(interaction: ButtonInteraction, ctx: AppContext, key: string): Promise<void> {
  if (!isToggle(key)) throw new UserError('That button is no longer supported.');
  const toggle = TOGGLES[key];
  const userId = interaction.user.id;
  if (unsubscribe(ctx, userId, toggle.spec)) {
    await interaction.reply({ content: toggle.off, flags: MessageFlags.Ephemeral });
    return;
  }
  if (subscribe(ctx, userId, toggle.spec) === 'full') {
    throw new UserError(`You already have ${MAX_TRACKERS_PER_USER} notifications. Remove one with **My notifications** or /track remove first.`);
  }
  await interaction.reply({
    content: `${toggle.on} Make sure Direct Messages from server members are on for this server.`,
    flags: MessageFlags.Ephemeral,
  });
}

/** The members who asked for something, each once: everyone with a notification `wanted` says yes to. */
export function subscribersOf(ctx: Ctx, wanted: (spec: TrackerSpec) => boolean): string[] {
  const ids = new Set<string>();
  for (const t of ctx.store.listTrackers(ctx.config.DISCORD_GUILD_ID)) {
    const spec = parseSpec(t.spec);
    if (spec && wanted(spec)) ids.add(t.userId);
  }
  return [...ids];
}

/** DMs a new clan event to everyone who asked for them, except whoever created it. Returns how many were reached. */
export async function notifyClanEvent(ctx: AppContext, event: ClanEvent, url: string): Promise<number> {
  const avatar = brandIcon(ctx) ?? null;
  let sent = 0;
  for (const userId of subscribersOf(ctx, (s) => s.kind === 'clanEvent')) {
    if (userId === event.createdBy) continue;
    if (await sendDm(ctx, userId, clanEventDm(event, url, avatar), `clan event #${event.id}`)) sent++;
  }
  return sent;
}

/** DMs a new squad to everyone who asked for squads (all of them, or this activity), except its host. Returns how many were reached. */
export async function notifySquad(ctx: AppContext, post: LfgPost, url: string, hostName: string): Promise<number> {
  const avatar = brandIcon(ctx) ?? null;
  const activity = post.activity.trim().toLowerCase();
  const wanted = (s: TrackerSpec) => s.kind === 'squad' && (!s.activity || s.activity.trim().toLowerCase() === activity);
  const card = squadDm({ activity: post.activity, details: post.details, size: post.size, hostName, voice: Boolean(post.voiceChannelId) }, url, avatar);
  let sent = 0;
  for (const userId of subscribersOf(ctx, wanted)) {
    if (userId === post.hostId) continue;
    if (await sendDm(ctx, userId, card, `squad #${post.id}`)) sent++;
  }
  return sent;
}
