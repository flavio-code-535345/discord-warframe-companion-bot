import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { type TimeInput, discordTime, toMs } from '../time.js';
import { collectTrackables, describeTracker, matchTracker, parseSpec } from '../trackers.js';
import { NOTABLE_REWARD, type WorldState, getWorldState, isBaroHere, worldStateEnabled, rewardText } from '../warframe/worldstate.js';
import { COLORS, archonEmbed, baroEmbed, clampLines, sortieEmbed, steelPathEmbed } from './embeds.js';
import { brandIcon } from './identity.js';

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
    // On a brand-new database, record what's already live instead of flooding the channel with it.
    const bootstrap = store.seenCount() === 0;
    const fresh = collectAlerts(ws).filter((a) => store.markSeen(a.key));
    if (bootstrap || fresh.length === 0) return;
    const footer = { text: `${this.ctx.config.BOT_NAME} · ${this.ctx.config.CLAN_NAME}`, iconURL: brandIcon(this.ctx) };
    for (const a of fresh) a.embed.setFooter(footer);

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
