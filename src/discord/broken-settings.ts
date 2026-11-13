import type { AppContext } from '../context.js';
import type { GuildSettings } from '../db.js';
import { levelTier } from '../leveling/xp.js';
import { refreshRolesPanel } from '../selfroles/service.js';
import { masteryOfRoleName } from '../ssroles/roles.js';
import { staffNotice } from './staff.js';

/**
 * A channel, category or role Ordis uses can be deleted in Discord at any moment, and until now the feature behind it just stopped
 * without a word (a board that fails every minute, a role button that does nothing). Now the staff are told what was deleted and what
 * is off because of it, the setting that pointed at it is cleared (a deleted channel never comes back, so the ID is only noise), and
 * the panel's Overview keeps listing what lost its channel until it gets a new one.
 *
 * Two ways in: Discord's own events while Ordis is running (`reportDeletedChannel`, `reportDeletedRole`), and a check at every start
 * for what went while he was offline (`checkSettings`). A setting is only ever cleared on Discord's word that the channel is gone:
 * the delete event, or "Unknown Channel" (10003) for that ID. A channel Ordis merely can't see or reach is left alone.
 */

/** The settings that hold a channel or a category. */
export type ChannelSettingKey = {
  [K in keyof GuildSettings]: K extends `${string}ChannelId` | `${string}CategoryId` ? K : never;
}[keyof GuildSettings];

export interface SettingUse {
  key: ChannelSettingKey;
  /** What the channel is for, as it reads after "…is off:". */
  what: string;
  /** The command that gives it a new channel. */
  setup: string;
}

/** Every setting that points at a channel, with what stops when that channel is gone. `test/broken-settings.test.ts` checks none is missing. */
export const SETTING_USES: readonly SettingUse[] = [
  { key: 'alertsChannelId', what: 'the Alerts board', setup: '/setup feed' },
  { key: 'arbitrationsChannelId', what: 'the Arbitrations board', setup: '/setup feed' },
  { key: 'fissuresChannelId', what: 'the Fissures board', setup: '/setup feed' },
  { key: 'sortieChannelId', what: 'the Sortie and Archon board', setup: '/setup feed' },
  { key: 'cyclesChannelId', what: 'the Cycles board', setup: '/setup feed' },
  { key: 'tradersChannelId', what: 'the Traders board', setup: '/setup feed' },
  { key: 'invasionsChannelId', what: 'the Invasions board', setup: '/setup feed' },
  { key: 'announcementsChannelId', what: 'announcements and clan events', setup: '/setup announcements' },
  { key: 'welcomeChannelId', what: 'the welcome greeting', setup: '/setup welcome' },
  { key: 'chatChannelId', what: 'the Ordis chat', setup: '/setup chat' },
  { key: 'modLogChannelId', what: 'the moderation log', setup: '/setup modlog' },
  { key: 'auditLogChannelId', what: 'the audit log (it falls back on the moderation log)', setup: '/setup auditlog' },
  { key: 'statusChannelId', what: 'the start and stop reports', setup: '/setup status' },
  { key: 'honeypotChannelId', what: 'the honeypot trap', setup: '/setup honeypot' },
  { key: 'ssRolesChannelId', what: 'the screenshot roles', setup: '/setup ssroles' },
  { key: 'rivenChannelId', what: 'riven scanning', setup: '/setup rivens' },
  { key: 'levelChannelId', what: 'the level-up announcements (they go where the member is talking)', setup: '/setup levels' },
  { key: 'lfgVoiceCategoryId', what: 'voice channels for squads', setup: '/setup lfgvoice' },
  { key: 'autoVcHubChannelId', what: 'join-to-create voice rooms', setup: '/setup autovc' },
  { key: 'lfgChannelId', what: 'squads started from a board', setup: '/setup lfg' },
  { key: 'birthdayChannelId', what: 'birthday wishes', setup: '/setup birthdays' },
  { key: 'weeklyChannelId', what: 'the weekly reset post (its DMs still go out)', setup: '/setup weekly' },
  { key: 'promoChannelId', what: 'the promo codes', setup: '/setup promos' },
  { key: 'newsChannelId', what: 'game news', setup: '/setup news' },
];

/** Discord's answer for a channel that does not exist (any more). */
const UNKNOWN_CHANNEL = 10003;
const LOST_META = 'settings_lost';

export interface LostSetting extends SettingUse {
  /** What the channel was called ("#alerts"), or its ID when it went while Ordis was offline. */
  name: string;
  at: number;
}

type Ctx = Pick<AppContext, 'store' | 'config'>;

/** What lost its channel and has not been given a new one since: for the panel's Overview and the health check. */
export function lostSettings(ctx: Ctx): LostSetting[] {
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  let saved: unknown;
  try {
    saved = JSON.parse(ctx.store.getMeta(LOST_META) || '[]');
  } catch {
    saved = [];
  }
  const list = (Array.isArray(saved) ? saved : []).flatMap((entry: Partial<LostSetting> | null): LostSetting[] => {
    const use = SETTING_USES.find((u) => u.key === entry?.key);
    return use && typeof entry?.name === 'string' && typeof entry.at === 'number' ? [{ ...use, name: entry.name, at: entry.at }] : [];
  });
  // Once the setting has a channel again there is nothing to remind anyone of.
  const still = list.filter((l) => !settings[l.key]);
  if (still.length !== (Array.isArray(saved) ? saved.length : 0)) ctx.store.setMeta(LOST_META, JSON.stringify(still));
  return still;
}

/**
 * Clears every setting that points at one of these channels, remembers what was lost and tells the staff. Returns what was cleared
 * (nothing when no setting used them, which is the usual case: most deleted channels are none of Ordis's business).
 */
async function dropSettings(ctx: AppContext, gone: { id: string; name: string }[], offline: boolean): Promise<LostSetting[]> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const settings = ctx.store.getSettings(guildId);
  const now = Date.now();
  const lost: LostSetting[] = [];
  const patch: Partial<Record<ChannelSettingKey, null>> = {};
  for (const channel of gone) {
    for (const use of SETTING_USES) {
      if (settings[use.key] !== channel.id) continue;
      patch[use.key] = null;
      lost.push({ ...use, name: channel.name, at: now });
    }
  }
  if (!lost.length) return [];
  ctx.store.updateSettings(guildId, patch);
  ctx.store.setMeta(LOST_META, JSON.stringify([...lostSettings(ctx).filter((l) => !lost.some((n) => n.key === l.key)), ...lost]));

  const names = [...new Set(gone.filter((g) => lost.some((l) => l.name === g.name)).map((g) => `**${g.name}**`))];
  await staffNotice(ctx, {
    tone: 'warn',
    title: names.length === 1 ? '⚠️ A channel Ordis used was deleted' : '⚠️ Channels Ordis used were deleted',
    text: `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} gone${offline ? ' (deleted while Ordis was offline)' : ''}. What it was for is switched off until it gets a new channel:`,
    fields: [{ name: 'Off now', value: lost.map((l) => `• ${l.what}: \`${l.setup}\``).join('\n') }],
  });
  console.warn(`[settings] ${names.join(', ')} deleted; cleared ${lost.map((l) => l.key).join(', ')}`);
  return lost;
}

/** A channel's name as members see it: "#alerts", but a category or voice channel without the hash. */
const shownName = (channel: { name?: string | null; id: string; isTextBased?: () => boolean }): string =>
  channel.name ? `${channel.isTextBased?.() ? '#' : ''}${channel.name}` : `channel ${channel.id}`;

/** Discord says a channel or category was deleted (the ChannelDelete event). */
export async function reportDeletedChannel(ctx: AppContext, channel: { id: string; name?: string | null; guildId?: string | null; isTextBased?: () => boolean }): Promise<LostSetting[]> {
  if (channel.guildId !== ctx.config.DISCORD_GUILD_ID) return [];
  return dropSettings(ctx, [{ id: channel.id, name: shownName(channel) }], false);
}

/**
 * At every start: the settings whose channel was deleted while Ordis was offline. A channel that is not in the cache is asked for by
 * ID, and only "Unknown Channel" counts as gone; any other answer (no access, Discord having a bad minute) changes nothing.
 */
export async function checkSettings(ctx: AppContext): Promise<LostSetting[]> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const settings = ctx.store.getSettings(guildId);
  const ids = [...new Set(SETTING_USES.map((u) => settings[u.key]).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return [];
  const guild = await ctx.client.guilds.fetch(guildId);
  const gone: { id: string; name: string }[] = [];
  for (const id of ids) {
    if (guild.channels.cache.has(id)) continue;
    try {
      await guild.channels.fetch(id);
    } catch (err) {
      if ((err as { code?: unknown }).code === UNKNOWN_CHANNEL) gone.push({ id, name: `channel ${id}` });
    }
  }
  return dropSettings(ctx, gone, true);
}

/**
 * Discord says a role was deleted (the GuildRoleDelete event). No setting holds a role any more, but three things hand roles out:
 * the self-assign menu (the role leaves it, so its button does not point at nothing), leveling and the screenshot roles (both find
 * their roles by name). Returns what the staff were told, one line per effect.
 */
export async function reportDeletedRole(ctx: AppContext, role: { id: string; name: string; guild: { id: string } }): Promise<string[]> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  if (role.guild.id !== guildId) return [];
  const effects: string[] = [];
  if (ctx.store.deleteSelfRole(guildId, role.id)) {
    await refreshRolesPanel(ctx).catch((err) => console.warn('[settings] could not update the roles panel:', (err as Error).message));
    effects.push('It was in the self-assign menu: its button is gone from the roles panel (`/roles add` puts a role back).');
  }
  if (levelTier(role.name) !== null) effects.push('Leveling handed it out: members who reach that level get no role until one with the same name exists again.');
  if (masteryOfRoleName(role.name) !== null) effects.push('The screenshot roles handed it out: a profile card with that mastery rank gets no role until one with the same name exists again.');
  if (!effects.length) return [];
  await staffNotice(ctx, { tone: 'warn', title: '⚠️ A role Ordis used was deleted', text: `The role **${role.name}** is gone.`, fields: [{ name: 'What that changes', value: effects.map((x) => `• ${x}`).join('\n') }] });
  return effects;
}
