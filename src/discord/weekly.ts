import { type ContainerBuilder, MessageFlags, type SendableChannels } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { WEEK_MS, discordTime, toMs, weekStart } from '../time.js';
import type { WorldState } from '../warframe/worldstate.js';
import { sendDm } from './dm.js';
import { e } from './emoji.js';
import { buttonRow, incarnonButton, notifyButton } from './feeds/controls.js';
import { DIVIDER, card } from './feeds/parts.js';
import { archonPart, honorsPart } from './feeds/sortie.js';
import { COLORS } from './style.js';
import { subscribersOf } from './subscriptions.js';

/**
 * The Monday post: what the weekly reset (Monday 00:00 UTC) brought, as one Components V2 card in the /setup weekly channel and as a
 * DM to everyone with the weekly notification (`/track weekly` or the "Weeklies by DM" button). It waits until the world state shows
 * the new week (the Archon Hunt started after the reset), or posts anyway after WAIT_LIMIT_MS; bot_meta `weekly_posted` holds the week
 * it last posted, so it goes out once per week, also across restarts.
 */

const WAIT_LIMIT_MS = 6 * 3_600_000;

/** Whether the post for this week is due now. */
export function weeklyDue(ws: WorldState, lastPosted: number, now: number): number | null {
  const week = weekStart(now);
  if (lastPosted >= week) return null;
  const fresh = ws.archonHunt ? toMs(ws.archonHunt.activation) >= week : false;
  return fresh || now - week >= WAIT_LIMIT_MS ? week : null;
}

/**
 * The week's post as one card: this week's Duviri Circuit, the weekly Nightwave challenges, the Archon Hunt and Teshin's Steel Path
 * honor. `button` adds the Weeklies by DM toggle, for the channel post only (a tap in a DM would not reach the clan server's
 * interactions). Pure.
 */
export function weeklyCard(ws: WorldState, week: number, now: number, button = false): ContainerBuilder {
  const d = ws.duviriCycle as { choices?: { category?: string; choices?: string[] }[] } | undefined;
  const normal = d?.choices?.find((c) => c.category === 'normal')?.choices ?? [];
  const hard = d?.choices?.find((c) => c.category === 'hard')?.choices ?? [];
  const circuit = [
    normal.length ? `${e('warframe')} **Warframes:** ${normal.join(', ')}` : null,
    hard.length ? `${e('steelPath')} **Steel Path Incarnons:** ${hard.join(', ')}` : null,
  ].filter(Boolean);
  const weeklies = (ws.nightwave?.activeChallenges ?? []).filter((c) => !c.isDaily);
  const nightwave = weeklies.map((c) => `${c.isElite ? e('star') : '•'} **${c.title}** · ${c.reputation.toLocaleString('en-US')}\n-# ${c.desc}`);
  return card(COLORS.brand, [
    `## ${e('weekly')} Weekly reset\nThe week of ${discordTime(week, 'D')} · the next reset is ${discordTime(week + WEEK_MS, 'R')}`,
    DIVIDER,
    circuit.length ? `### ${e('duviri')} Duviri Circuit\n${circuit.join('\n')}` : null,
    DIVIDER,
    nightwave.length ? `### ${e('nightwave')} Nightwave this week\n${nightwave.join('\n')}` : null,
    DIVIDER,
    ...archonPart(ws, now, '###'),
    DIVIDER,
    honorsPart(ws, now),
    DIVIDER,
    button ? buttonRow(notifyButton('weekly'), incarnonButton()) : null,
  ]);
}

/** What a card says once it is out of date: grey, no buttons, and a line that the next post replaced it. */
const OUTDATED_NOTE = '### ⚠️ Outdated\nThis is an old weekly post: the Circuit, the challenges and the Archon Hunt below are from an earlier week. The latest one is further down.';

type Raw = { type?: number; accent_color?: number | null; components?: Raw[]; content?: string };

/** A weekly post as Discord has it: one Components V2 container whose first text is the "Weekly reset" heading. */
const isWeeklyCard = (raw: Raw): boolean => raw.type === 17 && raw.accent_color !== COLORS.muted && !!raw.components?.some((c) => c.type === 10 && c.content?.includes('Weekly reset'));

/** The same card, greyed out: the accent turns grey, the buttons are taken away and a note goes on top. Pure; the text stays as it was. */
export function outdatedCard(raw: Raw): Raw {
  const rest = (raw.components ?? []).filter((c) => c.type !== 1);
  return { ...raw, accent_color: COLORS.muted, components: [{ type: 10, content: OUTDATED_NOTE }, { type: 14, divider: true, spacing: 1 } as Raw, ...rest] };
}

type RawEmbed = { title?: string; description?: string; color?: number };

/** The posts from before the cards were Components V2 were embeds: the first one is titled "Weekly reset · week of …". */
const isWeeklyEmbeds = (embeds: RawEmbed[]): boolean => !!embeds[0]?.title?.includes('Weekly reset') && embeds[0].color !== COLORS.muted;

/** The same embeds, greyed out, with the note under the first title. Pure. */
export function outdatedEmbeds(embeds: RawEmbed[]): RawEmbed[] {
  return embeds.map((e, i) => ({ ...e, color: COLORS.muted, ...(i === 0 ? { title: `⚠️ Outdated · ${e.title ?? ''}`, description: `**This is an old weekly post. The latest one is further down.**\n${e.description ?? ''}`.trim() } : {}) }));
}

/**
 * Greys out the weekly posts the bot left in the channel, all but `keepId` (the one just posted) or, without one, all but the newest. It
 * reads the channel's last 50 messages, which takes in the Components V2 cards and the older embed posts. A failure is logged per message
 * and stops nothing. Returns how many it greyed out.
 */
export async function markOutdatedWeeklies(channel: SendableChannels, botId: string, keepId?: string): Promise<number> {
  let batch;
  try {
    batch = await channel.messages.fetch({ limit: 50 });
  } catch (err) {
    console.warn('[weekly] could not read the channel to grey out the older posts:', err instanceof Error ? err.message : err);
    return 0;
  }
  // [message, its edit] for every live (not yet grey) weekly post of the bot's.
  const posts: { id: string; edit: () => Promise<unknown> }[] = [];
  for (const message of batch.values()) {
    if (message.author.id !== botId) continue;
    if (message.flags.has(MessageFlags.IsComponentsV2)) {
      const raw = message.components.map((c) => (c as { toJSON(): Raw }).toJSON());
      if (raw.some(isWeeklyCard)) posts.push({ id: message.id, edit: () => message.edit({ components: raw.map((r) => (isWeeklyCard(r) ? outdatedCard(r) : r)) as never, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } }) });
    } else {
      const embeds = message.embeds.map((e) => e.toJSON() as RawEmbed);
      if (isWeeklyEmbeds(embeds)) posts.push({ id: message.id, edit: () => message.edit({ embeds: outdatedEmbeds(embeds), components: [], allowedMentions: { parse: [] } }) });
    }
  }
  const keep = keepId ?? posts.reduce<string | null>((best, p) => (best === null || BigInt(p.id) > BigInt(best) ? p.id : best), null);
  let done = 0;
  for (const post of posts) {
    if (post.id === keep) continue;
    try {
      await post.edit();
      done++;
    } catch (err) {
      console.warn('[weekly] could not grey out a post:', err instanceof Error ? err.message : err);
    }
  }
  return done;
}

/** Once at every start: the weekly channel's posts that a newer one replaced turn grey. Does nothing without a channel. */
export async function greyOldWeeklies(ctx: AppContext): Promise<number> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).weeklyChannelId;
  if (!channelId || !ctx.client.user) return 0;
  const channel = await getSendableChannel(ctx, channelId);
  return markOutdatedWeeklies(channel, ctx.client.user.id);
}

/** Called when the channel is set: the week already under way is not posted halfway through, the first post is the next Monday. */
export function skipCurrentWeek(ctx: Pick<AppContext, 'store'>, now = Date.now()): void {
  ctx.store.setMeta('weekly_posted', String(weekStart(now)));
}

/** Who gets the post as a DM: the members with the weekly notification (`/track weekly` or the "Weeklies by DM" button), each once. */
export const weeklySubscribers = (ctx: Pick<AppContext, 'store' | 'config'>): string[] => subscribersOf(ctx, (s) => s.kind === 'weekly');

/** Posts the week's summary in the weekly channel (when one is set) and DMs it to every subscriber. Returns who was reached. */
export async function sendWeekly(ctx: AppContext, ws: WorldState, week: number, now = Date.now()): Promise<{ channel: boolean; dms: number; failed: number }> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).weeklyChannelId;
  let posted = false;
  if (channelId) {
    const channel = await getSendableChannel(ctx, channelId);
    const sent = await channel.send({ components: [weeklyCard(ws, week, now, true)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    if (ctx.client.user && sent?.id) await markOutdatedWeeklies(channel, ctx.client.user.id, sent.id);
    posted = true;
  }
  const dm = weeklyCard(ws, week, now);
  let dms = 0;
  let failed = 0;
  for (const userId of weeklySubscribers(ctx)) {
    if (await sendDm(ctx, userId, dm, 'the weekly post')) dms++;
    else failed++;
  }
  return { channel: posted, dms, failed };
}

export async function postWeeklyReset(ctx: AppContext, ws: WorldState, now = Date.now()): Promise<void> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const settings = ctx.store.getSettings(guildId);
  if (!settings.weeklyChannelId && !weeklySubscribers(ctx).length) return;
  const week = weeklyDue(ws, Number(ctx.store.getMeta('weekly_posted')) || 0, now);
  if (week === null || now - week > WEEK_MS) return;
  // Marked first: a failure to post is logged, not retried every minute.
  ctx.store.setMeta('weekly_posted', String(week));
  await sendWeekly(ctx, ws, week, now);
}
