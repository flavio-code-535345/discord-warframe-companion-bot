import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ContainerBuilder, type MessageActionRowComponentBuilder, MessageFlags } from 'discord.js';
import type { AppContext } from '../context.js';
import { discordTime } from '../time.js';
import type { Trackable } from '../trackers.js';
import { e, rewardEmoji, tierEmoji } from './emoji.js';
import { CYCLE_EMOJI } from './feeds/cycles.js';
import { DIVIDER, type Part, card, section } from './feeds/parts.js';
import { COLORS } from './style.js';

/**
 * Ordis's DMs (tracker matches, price alerts) in the look of the World State boards: one Components V2 card with the bot's avatar at the
 * top right, an icon per item and the small print at the bottom. DMs carry no buttons that need the server (a tap in a DM does not
 * reach the guild-only interaction handler); a link button is fine.
 */

/** The icon that says what a matched item is: the tier badge of an Arbitration, the relic tier of a fissure, the state of a cycle… */
export function trackableEmoji(item: Trackable): string {
  switch (item.source) {
    case 'arbitration':
      return item.arbitration?.tier ? e(`tier${item.arbitration.tier}`) : e('arbitration');
    case 'fissure':
      return tierEmoji(item.fissure?.tier);
    case 'cycle':
      return CYCLE_EMOJI[item.cycle?.state ?? ''] ?? e('cycle');
    case 'deal':
      return e('darvo');
    case 'resurgence':
      return e('varzia');
    case 'circuit':
      return e('warframe');
    default:
      return e(item.source);
  }
}

/** Rewards listed per item; a keyword such as "prime" can match a whole Varzia stock. */
const MAX_HITS = 6;

/** One matched item: icon and title (with the matching rewards), then the detail and when it ends in small print. */
export function itemLines(item: Trackable, hits: string[]): string {
  const more = hits.length > MAX_HITS ? `, +${hits.length - MAX_HITS} more` : '';
  const rewards = hits.slice(0, MAX_HITS).map((h) => `${rewardEmoji(h)} ${h}`.trim()).join(', ') + (hits.length ? more : '');
  const ends = item.expiry ? ` · ends ${discordTime(item.expiry, 'R')}` : '';
  return `${trackableEmoji(item)} **${item.title}**${rewards ? ` · ${rewards}` : ''}\n-# ${item.detail}${ends}`;
}

export interface DmGroup {
  /** What the member asked for ("Reward containing "forma"") and the tracker's number. */
  label: string;
  items: { item: Trackable; hits: string[] }[];
}

/** The DM about what matched a member's trackers this round: one block per tracker. */
export function trackerDm(groups: DmGroup[], avatar: string | null): ContainerBuilder {
  const blocks: Part[] = groups.flatMap((g) => [DIVIDER, [`-# 🔔 ${g.label}`, ...g.items.map(({ item, hits }) => itemLines(item, hits))].join('\n')]);
  return card(COLORS.brand, [
    section(`### Operator, something you asked Ordis to watch for is here`, avatar),
    ...blocks,
    DIVIDER,
    '-# Manage your notifications with /track list and /track remove, or the "My notifications" button on the World State boards.',
  ]);
}

/** The DM when a tracked item reaches the member's price on warframe.market. */
export function priceDm(p: { name: string; price: number; below: number; seller: string | null; url: string; trackerId: number }, avatar: string | null): ContainerBuilder {
  const open = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(p.url).setLabel('Open on warframe.market'),
  );
  return card(COLORS.success, [
    section(
      `### ${e('platinum')} ${p.name} is at ${p.price}p\nYour limit was **${p.below}p**. The cheapest online seller right now is **${p.seller ?? 'someone'}**.`,
      avatar,
    ),
    open,
    `-# Tracker #${p.trackerId} · Ordis tells you again once the price has gone back above your limit.`,
  ]);
}

/** Sends a card as a DM. False when the member can't be reached (DMs closed, left the server); that is logged, not thrown. */
export async function sendDm(ctx: Pick<AppContext, 'client'>, userId: string, container: ContainerBuilder, what: string): Promise<boolean> {
  try {
    const user = await ctx.client.users.fetch(userId);
    await user.send({ components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    console.warn(`[dm] could not send ${what} to ${userId} (DMs closed?):`, (err as Error).message);
    return false;
  }
}
