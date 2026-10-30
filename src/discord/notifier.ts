import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel, refreshEventMessage } from '../services/clan.js';
import { type TimeInput, discordTime, toMs } from '../time.js';
import { collectTrackables, describeTracker, matchTracker, parseSpec } from '../trackers.js';
import { NOTABLE_REWARD, type WorldState, alertName, getWorldState, isBaroHere, worldStateEnabled, rewardText } from '../warframe/worldstate.js';
import { alertsComponents } from './alerts-panel.js';
import { COLORS, archonEmbed, baroEmbed, clampLines, sortieEmbed, steelPathEmbed } from './embeds.js';
import { brandIcon } from './identity.js';
import { summaryEmbeds, summaryHash } from './summary.js';

const REMINDER_WINDOW_MS = 15 * 60 * 1000;
/** How often the notifier wakes up (event reminders). The worldstate itself is fetched at most every WORLDSTATE_POLL_SECONDS. */
const TICK_MS = 60_000;
const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface WorldStateAlert {
  /** Stable identity used to post each alert only once, across restarts. */
  key: string;
  embed: EmbedBuilder;
}

/** Everything currently in the worldstate that deserves an alert; the caller filters out what was already posted. */
export function collectAlerts(ws: WorldState, now = Date.now()): WorldStateAlert[] {
  const alerts: WorldStateAlert[] = [];
  const live = (expiry: TimeInput) => toMs(expiry) > now;

  if (ws.sortie && live(ws.sortie.expiry)) alerts.push({ key: `sortie:${ws.sortie.id}`, embed: sortieEmbed(ws) });
  if (ws.archonHunt && live(ws.archonHunt.expiry)) alerts.push({ key: `archon:${ws.archonHunt.id}`, embed: archonEmbed(ws) });
  if (ws.voidTrader && isBaroHere(ws, now)) {
    alerts.push({ key: `baro:${ws.voidTrader.id}:${toMs(ws.voidTrader.activation)}`, embed: baroEmbed(ws) });
  }
  if (ws.steelPath?.currentReward && live(ws.steelPath.expiry)) {
    alerts.push({ key: `steelpath:${toMs(ws.steelPath.activation)}`, embed: steelPathEmbed(ws) });
  }

  for (const a of ws.alerts ?? []) {
    if (!live(a.expiry)) continue;
    // Only an alert with something worth a detour is announced (like invasions below); the rest, such as an event's endless resource
    // nodes that appear every half hour, is still listed in the summary.
    if (!NOTABLE_REWARD.test(rewardText(a.mission.reward))) continue;
    alerts.push({
      key: `alert:${a.id}`,
      embed: new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`⚠️ Alert: ${alertName(a)}`)
        .setDescription(
          `${a.mission.type} — ${a.mission.node} · ${a.mission.faction}\n**Reward:** ${rewardText(a.mission.reward)}\nEnds ${discordTime(a.expiry)}`,
        ),
    });
  }

  for (const inv of ws.invasions ?? []) {
    if (inv.completed) continue;
    const rewards = [rewardText(inv.attacker.reward), rewardText(inv.defender.reward)];
    if (!rewards.some((r) => NOTABLE_REWARD.test(r))) continue;
    alerts.push({
      key: `invasion:${inv.id}`,
      embed: new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`🎯 Invasion worth running: ${inv.node}`)
        .setDescription(
          `${inv.desc}\n${inv.vsInfestation ? '' : `**${inv.attacker.faction}:** ${rewards[0]}\n`}**${inv.defender.faction}:** ${rewards[1]}\n${Math.round(inv.completion)}% complete`,
        ),
    });
  }

  return alerts;
}

/** The most that is said in the short "something new" message; the rest is in the summary. */
const MAX_TITLES = 8;
/** The summary is edited at most this often, unless something new just appeared. */
const SUMMARY_MIN_EDIT_MS = 2 * 60_000;

/** The little of a channel that the summary needs (a real text channel has all of it), so it can be tested without Discord. */
export interface SummaryChannel {
  id: string;
  guildId: string;
  send(payload: { content?: string; embeds?: EmbedBuilder[]; components?: ReturnType<typeof alertsComponents>; allowedMentions: { parse?: []; roles?: string[] } }): Promise<{ id: string }>;
  messages: { edit(messageId: string, payload: { embeds: EmbedBuilder[]; components?: ReturnType<typeof alertsComponents> }): Promise<unknown>; delete(messageId: string): Promise<unknown>; fetch(messageId: string): Promise<unknown> };
}

/** An unchanged summary is not edited, so every so often it is checked that the message is still there (someone may have deleted it). */
const SUMMARY_VERIFY_MS = 10 * 60_000;

interface SummaryRecord {
  messageId: string;
  hash: string;
  at: number;
  /** When the message was last seen to exist. */
  checked: number;
}

const readRecord = (raw: string | null): SummaryRecord | null => {
  try {
    const r = JSON.parse(raw ?? 'null') as Partial<SummaryRecord> | null;
    return r && typeof r.messageId === 'string' && typeof r.hash === 'string' ? { messageId: r.messageId, hash: r.hash, at: Number(r.at) || 0, checked: Number(r.checked) || Number(r.at) || 0 } : null;
  } catch {
    return null;
  }
};

/** The short message that goes with a ping: what is new, and where the whole picture is. */
export function newItemsText(titles: string[], summaryUrl: string, roleId: string | null | undefined): string {
  const shown = titles.slice(0, MAX_TITLES).join(' · ');
  const more = titles.length > MAX_TITLES ? ` · +${titles.length - MAX_TITLES} more` : '';
  return `${roleId ? `<@&${roleId}> ` : ''}🔔 **New:** ${shown}${more}\n[Everything right now](<${summaryUrl}>)`;
}

/**
 * Keeps the alerts channel's single summary message up to date: it is edited in place when something in it changed (not more often than
 * every two minutes, unless something new just appeared), posted again if someone deleted it, and left alone when nothing changed. The
 * message id and a fingerprint of its content are kept in bot_meta, so a restart continues with the same message. Returns its link.
 */
export async function updateSummaryMessage(ctx: AppContext, channel: SummaryChannel, ws: WorldState, opts: { force: boolean; now?: number }): Promise<string> {
  const { store, config } = ctx;
  const now = opts.now ?? Date.now();
  const key = `alerts_summary:${channel.id}`;
  const link = (id: string) => `https://discord.com/channels/${channel.guildId}/${channel.id}/${id}`;
  const embeds = summaryEmbeds(ws, { botName: config.BOT_NAME, clanName: config.CLAN_NAME, iconURL: brandIcon(ctx) }, now);
  // The suffix versions the layout and buttons of the message, so a message saved with an older one is edited once to get the new.
  const hash = `${summaryHash(embeds)}:c2`;
  const saved = readRecord(store.getMeta(key));
  // 10008: someone deleted the message, so post a new one. Anything else (no permission, Discord down) is for the caller to log.
  const gone = (err: unknown) => {
    if ((err as { code?: number }).code !== 10008) throw err;
  };
  let missing = false;
  if (saved && saved.hash === hash && now - saved.checked >= SUMMARY_VERIFY_MS) {
    try {
      await channel.messages.fetch(saved.messageId);
      store.setMeta(key, JSON.stringify({ ...saved, checked: now }));
    } catch (err) {
      gone(err);
      missing = true;
    }
  }
  if (saved && !missing && (saved.hash === hash || (!opts.force && now - saved.at < SUMMARY_MIN_EDIT_MS))) return link(saved.messageId);
  embeds[embeds.length - 1]!.setTimestamp(now);
  if (saved && !missing) {
    try {
      await channel.messages.edit(saved.messageId, { embeds, components: alertsComponents() });
      store.setMeta(key, JSON.stringify({ messageId: saved.messageId, hash, at: now, checked: now }));
      return link(saved.messageId);
    } catch (err) {
      gone(err);
    }
  }
  const sent = await channel.send({ embeds, components: alertsComponents(), allowedMentions: { parse: [] } });
  store.setMeta(key, JSON.stringify({ messageId: sent.id, hash, at: now, checked: now }));
  return link(sent.id);
}

/** How long the short "something new" message stays: what it announced is in the summary, which is all the channel keeps. */
const NOTE_TTL_MS = 3 * 60 * 60_000;
const noteKey = (channelId: string) => `alerts_note:${channelId}`;

const readNote = (raw: string | null): { messageId: string; at: number } | null => {
  try {
    const r = JSON.parse(raw || 'null') as { messageId?: unknown; at?: unknown } | null;
    return r && typeof r.messageId === 'string' ? { messageId: r.messageId, at: Number(r.at) || 0 } : null;
  } catch {
    return null;
  }
};

/** Posts the "something new" message and removes the previous one, so a busy day doesn't leave a pile of them in the channel. */
export async function postNote(ctx: AppContext, channel: SummaryChannel, payload: Parameters<SummaryChannel['send']>[0], now = Date.now()): Promise<void> {
  const previous = readNote(ctx.store.getMeta(noteKey(channel.id)));
  const sent = await channel.send(payload);
  ctx.store.setMeta(noteKey(channel.id), JSON.stringify({ messageId: sent.id, at: now }));
  if (previous) await channel.messages.delete(previous.messageId).catch(() => {});
}

/** Removes the "something new" message once it is old. */
export async function expireNote(ctx: AppContext, channel: SummaryChannel, now = Date.now()): Promise<void> {
  const saved = readNote(ctx.store.getMeta(noteKey(channel.id)));
  if (!saved || now - saved.at < NOTE_TTL_MS) return;
  await channel.messages.delete(saved.messageId).catch(() => {});
  ctx.store.setMeta(noteKey(channel.id), '');
}

export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Reminders don't depend on the worldstate, so they still go out when the world state source is down.
      await this.sendEventReminders();
      await this.finishEvents();
      if (!worldStateEnabled()) return;
      const ws = await getWorldState();
      await this.postWorldStateAlerts(ws);
      await this.notifyTrackers(ws);
      this.ctx.store.pruneSeen(SEEN_RETENTION_MS);
    } catch (err) {
      console.error('[notifier] tick failed:', err);
    } finally {
      this.running = false;
    }
  }

  private async postWorldStateAlerts(ws: WorldState): Promise<void> {
    const { store } = this.ctx;
    // On a brand-new database, record what's already live instead of announcing all of it as new.
    const bootstrap = store.seenCount() === 0;
    const fresh = collectAlerts(ws).filter((a) => store.markSeen(a.key));
    const notify = !bootstrap && fresh.length > 0;

    for (const settings of store.allSettings()) {
      if (!settings.alertsChannelId) continue;
      try {
        const channel = await getSendableChannel(this.ctx, settings.alertsChannelId);
        // One message says everything that is going on and is edited in place; it is brought up to date before anyone is pinged.
        const target = channel as unknown as SummaryChannel;
        const url = await updateSummaryMessage(this.ctx, target, ws, { force: notify });
        if (notify) {
          await postNote(this.ctx, target, {
            content: newItemsText(fresh.map((a) => a.embed.data.title ?? 'Something new'), url, settings.alertsRoleId),
            allowedMentions: { roles: settings.alertsRoleId ? [settings.alertsRoleId] : [] },
          });
        } else await expireNote(this.ctx, target);
      } catch (err) {
        console.error(`[notifier] could not post alerts to ${settings.alertsChannelId}:`, err);
      }
    }
  }

  /** DMs each member about new worldstate items matching their /track trackers, one message per member per poll. */
  private async notifyTrackers(ws: WorldState): Promise<void> {
    const { store, config, client } = this.ctx;
    const trackers = store.listTrackers(config.DISCORD_GUILD_ID);
    if (!trackers.length) return;
    const items = collectTrackables(ws);
    const perUser = new Map<string, { label: string; lines: string[] }[]>();

    for (const tracker of trackers) {
      const spec = parseSpec(tracker.spec);
      if (!spec) continue;
      const lines: string[] = [];
      for (const item of items) {
        const hits = matchTracker(spec, item);
        if (hits === null || !store.markSeen(`track:${tracker.id}:${item.key}`)) continue;
        const ends = item.expiry ? ` · ends ${discordTime(item.expiry)}` : '';
        lines.push(`**${item.title}**${hits.length ? ` — ${hits.join(', ')}` : ''}
${item.detail}${ends}`);
      }
      if (lines.length) {
        const list = perUser.get(tracker.userId) ?? [];
        list.push({ label: `#${tracker.id} ${describeTracker(spec)}`, lines });
        perUser.set(tracker.userId, list);
      }
    }

    for (const [userId, groups] of perUser) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setAuthor({ name: config.BOT_NAME, iconURL: brandIcon(this.ctx) })
        .setTitle('Operator, something you asked Ordis to watch for is here!')
        .setFooter({ text: 'Manage with /track list and /track remove' });
      for (const g of groups.slice(0, 20)) {
        embed.addFields({ name: g.label.slice(0, 256), value: clampLines(g.lines, 1000) });
      }
      try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [embed] });
      } catch (err) {
        console.warn(`[notifier] could not DM tracker update to ${userId} (DMs closed?):`, (err as Error).message);
      }
    }
  }

  /** Events with an end time that has passed: mark them, and re-render their post as ended (the RSVP buttons go away). */
  private async finishEvents(): Promise<void> {
    const { store } = this.ctx;
    for (const event of store.eventsDueToEnd(Date.now())) {
      store.markEventEnded(event.id);
      await refreshEventMessage(this.ctx, event.id).catch((err) => console.error(`[notifier] could not mark event #${event.id} as ended:`, err));
    }
  }

  private async sendEventReminders(): Promise<void> {
    const { store } = this.ctx;
    for (const event of store.eventsDueForReminder(Date.now(), REMINDER_WINDOW_MS)) {
      store.markEventReminded(event.id);
      if (!event.channelId) continue;
      const rsvps = store.getRsvps(event.id);
      const attendees = [...rsvps.going, ...rsvps.maybe];
      try {
        const channel = await getSendableChannel(this.ctx, event.channelId);
        await channel.send({
          content: `⏰ **${event.title}** starts ${discordTime(event.startsAt)}! ${attendees.map((u) => `<@${u}>`).join(' ')}`,
          reply: event.messageId ? { messageReference: event.messageId, failIfNotExists: false } : undefined,
          allowedMentions: { users: attendees, repliedUser: false },
        });
      } catch (err) {
        console.error(`[notifier] reminder for event #${event.id} failed:`, err);
      }
    }
  }
}
