import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { type TimeInput, discordTime, toMs } from '../time.js';
import { type WorldState, getWorldState, isBaroHere, rewardText } from '../warframe/worldstate.js';
import { COLORS, archonEmbed, baroEmbed, sortieEmbed, steelPathEmbed } from './embeds.js';

const REMINDER_WINDOW_MS = 15 * 60 * 1000;
const SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Invasion rewards worth pinging the clan about. */
const NOTABLE_REWARD = /orokin (catalyst|reactor)|forma|exilus|wraith|vandal|umbra|aura/i;

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
    alerts.push({
      key: `alert:${a.id}`,
      embed: new EmbedBuilder()
        .setColor(COLORS.warn)
        .setTitle(`⚠️ Alert: ${a.mission.description ?? a.mission.type}`)
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

export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.ctx.config.WORLDSTATE_POLL_SECONDS * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.postWorldStateAlerts();
      await this.sendEventReminders();
      this.ctx.store.pruneSeen(SEEN_RETENTION_MS);
    } catch (err) {
      console.error('[notifier] tick failed:', err);
    } finally {
      this.running = false;
    }
  }

  private async postWorldStateAlerts(): Promise<void> {
    const { store } = this.ctx;
    const ws = await getWorldState();
    // On a brand-new database, record what's already live instead of flooding the channel with it.
    const bootstrap = store.seenCount() === 0;
    const fresh = collectAlerts(ws).filter((a) => store.markSeen(a.key));
    if (bootstrap || fresh.length === 0) return;

    for (const settings of store.allSettings()) {
      if (!settings.alertsChannelId) continue;
      try {
        const channel = await getSendableChannel(this.ctx, settings.alertsChannelId);
        for (let i = 0; i < fresh.length; i += 10) {
          await channel.send({
            content: i === 0 && settings.alertsRoleId ? `<@&${settings.alertsRoleId}>` : undefined,
            embeds: fresh.slice(i, i + 10).map((a) => a.embed),
            allowedMentions: { roles: settings.alertsRoleId ? [settings.alertsRoleId] : [] },
          });
        }
      } catch (err) {
        console.error(`[notifier] could not post alerts to ${settings.alertsChannelId}:`, err);
      }
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
