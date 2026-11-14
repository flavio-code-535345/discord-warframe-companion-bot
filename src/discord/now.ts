import { ButtonBuilder, ButtonStyle, type ContainerBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { discordTime, toMs } from '../time.js';
import { arbitrationView, atLeast, loadArbitrations } from '../warframe/arbitrations.js';
import { projectCycles } from '../warframe/cycles.js';
import { quickFissures } from '../warframe/fissures.js';
import { type Fissure, type WorldState, getWorldState, groupAlerts, isBaroHere, isNotableReward, rewardText, worldStateEnabled } from '../warframe/worldstate.js';
import { cycleEmoji, e, factionTag, rewardEmoji, tierEmoji } from './emoji.js';
import { squadButton, tierBadge } from './feeds/arbitrations.js';
import { buttonRow } from './feeds/controls.js';
import { feedInput } from './feeds/index.js';
import { CARD_TEXT_BUDGET, DIVIDER, type Part, card, fit, nodeName, planetOf } from './feeds/parts.js';
import { type FeedInput, STALE_NOTE } from './feeds/types.js';
import { COLORS } from './style.js';

/**
 * `/now`: one card with what is worth doing in the game at this moment, drawn from the same snapshot as the World State boards (the
 * world state and the Arbitration schedule): the Arbitration with its tier, the quick fissures per relic tier, the alerts and
 * invasions that pay something worth a detour, night on the Plains and warmth in the Vallis, Baro, Darvo, running events and the
 * daily and weekly resets. It is a snapshot, not a board: the times on it keep counting, the lists do not change.
 */

const HOUR = 3_600_000;
const MAX_REWARDS = 5;

/** "Hepit, Void". */
export const place = (node: string): string => {
  const planet = planetOf(node);
  return `${nodeName(node)}${planet ? `, ${planet}` : ''}`;
};

/** One quick fissure as a line: the tier and the mission, where it is and when it closes. */
export const fissureLine = (f: Fissure): string =>
  `${e('bolt')} ${tierEmoji(f.tier)} **${f.tier} ${f.missionType}**${f.isHard ? ` ${e('steelPath')} Steel Path` : ''} · ${place(f.node)} · closes ${discordTime(f.expiry, 'R')}`;

function arbitrationPart(input: FeedInput): string | null {
  const { arby, now } = input;
  const cur = arby.current;
  if (!cur) return null;
  const good = atLeast(cur.tier, 'A');
  const faction = factionTag(cur.faction);
  const lines = [
    `${good ? `${e('star')} ` : ''}${tierBadge(cur.tier)} **Arbitration** · ${cur.name}${cur.planet ? `, ${cur.planet}` : ''} · ${cur.mission}${faction ? ` · ${faction}` : ''} · ends ${discordTime(cur.end, 'R')}`,
  ];
  const next = arby.scheduleTrusted ? arby.upcoming.find((s) => s.start > now && atLeast(s.tier, 'A')) : undefined;
  if (!good && next) lines.push(`-# The next ${next.tier} tier hour starts ${discordTime(next.start, 'R')}: ${next.name} (${next.mission})`);
  return lines.join('\n');
}

function fissurePart(ws: WorldState | null, now: number): string | null {
  if (!ws) return null;
  const quick = quickFissures(ws, now);
  const open = (ws.fissures ?? []).filter((f) => toMs(f.expiry) > now).length;
  if (!quick.length) return open ? `${e('fissure')} **Fissures** · no quick mission open right now (${open} fissures in all)` : null;
  return [`**Quick fissures** · one per relic tier`, ...quick.map(fissureLine)].join('\n');
}

/** The alerts and invasions that pay something worth a detour. */
function rewardPart(ws: WorldState | null, now: number): string | null {
  if (!ws) return null;
  const lines: string[] = [];
  for (const g of groupAlerts((ws.alerts ?? []).filter((a) => toMs(a.expiry) > now))) {
    if (!g.notable) continue;
    const a = g.alerts[0]!;
    const where = g.alerts.length === 1 ? `${a.mission.type} on ${place(a.mission.node)}` : `${g.alerts.length} missions`;
    lines.push(`${`${rewardEmoji(g.reward)} `.trimStart()}**${g.reward}** · alert: ${where} · ends ${discordTime(a.expiry, 'R')}`);
  }
  for (const inv of ws.invasions ?? []) {
    if (inv.completed) continue;
    const pays = [inv.vsInfestation ? '—' : rewardText(inv.attacker.reward), rewardText(inv.defender.reward)].filter((r) => r !== '—' && isNotableReward(r));
    if (pays.length) lines.push(`${`${rewardEmoji(pays[0]!)} `.trimStart()}**${pays.join(' / ')}** · invasion on ${place(inv.node)}`);
  }
  if (!lines.length) return null;
  const more = lines.length - MAX_REWARDS;
  return [`**Worth running**`, ...lines.slice(0, MAX_REWARDS), more > 0 ? `-# …and ${more} more` : ''].filter(Boolean).join('\n');
}

function worldPart(ws: WorldState | null, now: number): string | null {
  if (!ws) return null;
  try {
    const p = projectCycles(ws, now);
    const cetus = p.cetus.isDay
      ? `${cycleEmoji('day')} **Cetus** day · night ${discordTime(p.cetus.expiry, 'R')}`
      : `${cycleEmoji('night')} **Night on the Plains** (Eidolons) · day ${discordTime(p.cetus.expiry, 'R')}`;
    const vallis = p.vallis.isWarm
      ? `${cycleEmoji('warm')} **Orb Vallis is warm** · cold ${discordTime(p.vallis.expiry, 'R')}`
      : `${cycleEmoji('cold')} **Orb Vallis** cold · warm ${discordTime(p.vallis.expiry, 'R')}`;
    return `${cetus}\n${vallis}`;
  } catch {
    return null;
  }
}

function traderPart(input: FeedInput): string | null {
  const { ws, now } = input;
  if (!ws) return null;
  const lines: string[] = [];
  const t = ws.voidTrader;
  if (t && isBaroHere(ws, now)) {
    const resale = (t.inventory ?? [])
      .map((i) => ({ i, plat: input.prices?.(i.item) ?? null }))
      .filter((x): x is { i: (typeof t.inventory)[number]; plat: number } => x.plat !== null && Number(x.i.ducats) > 0)
      .sort((a, b) => b.plat / Number(b.i.ducats) - a.plat / Number(a.i.ducats))[0];
    lines.push(`${e('baro')} **Baro Ki'Teer** is at ${t.location} · leaves ${discordTime(t.expiry, 'R')}`);
    if (resale) lines.push(`-# Best resale: **${resale.i.item}** · ${resale.plat}p for ${resale.i.ducats} ducats`);
  } else if (t && toMs(t.activation) > now && toMs(t.activation) - now <= 48 * HOUR) {
    lines.push(`${e('baro')} **Baro Ki'Teer** arrives ${discordTime(t.activation, 'R')} at ${t.location}`);
  }
  const deal = (ws.dailyDeals ?? []).find((d) => toMs(d.expiry) > now && Number(d.total) - Number(d.sold) > 0);
  if (deal) lines.push(`${e('darvo')} **Darvo:** ${deal.item} for ${deal.salePrice}p (−${deal.discount}%) · ${Number(deal.total) - Number(deal.sold)} left · ${discordTime(deal.expiry, 'R')}`);
  return lines.length ? lines.join('\n') : null;
}

function eventPart(ws: WorldState | null, now: number): string | null {
  const events = (ws?.events ?? []).filter((ev) => toMs(ev.expiry) > now && ev.description);
  if (!events.length) return null;
  return events
    .slice(0, 3)
    .map((ev) => `${e('event')} **${ev.description}** · ends ${discordTime(ev.expiry, 'R')}`)
    .join('\n');
}

function resetPart(ws: WorldState | null, now: number): string | null {
  if (!ws) return null;
  const parts: string[] = [];
  if (ws.sortie && toMs(ws.sortie.expiry) > now) parts.push(`${e('sortie')} Sortie${ws.sortie.boss ? ` (${ws.sortie.boss})` : ''} resets ${discordTime(ws.sortie.expiry, 'R')}`);
  if (ws.archonHunt && toMs(ws.archonHunt.expiry) > now) parts.push(`${e('archon')} Archon Hunt${ws.archonHunt.boss ? ` (${ws.archonHunt.boss})` : ''} ${discordTime(ws.archonHunt.expiry, 'R')}`);
  return parts.length ? `-# ${parts.join(' · ')}` : null;
}

const boardLink = (guildId: string, channelId: string | null, label: string): ButtonBuilder | null =>
  channelId ? new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guildId}/${channelId}`).setLabel(label) : null;

/**
 * The card (pure). `personal` are lines only the member who asked may see (their own relics); they are left out of a shared card by
 * whoever calls this.
 */
export function nowCard(input: FeedInput, opts: { personal?: string[] } = {}): ContainerBuilder {
  const { ws, now, settings } = input;
  const heading = `## 🧭 Right now`;
  const body = [arbitrationPart(input), fissurePart(ws, now), opts.personal?.length ? opts.personal.join('\n') : null, rewardPart(ws, now), worldPart(ws, now), traderPart(input), eventPart(ws, now)].filter(
    (part): part is string => Boolean(part),
  );
  const footer = [
    resetPart(ws, now),
    !ws && body.length ? '-# The live world state is switched off or not answering, so fissures, alerts and the open worlds are missing.' : null,
    input.stale ? `-# ${STALE_NOTE}` : null,
    `-# As of ${discordTime(now, 't')}. The World State channels keep themselves up to date.`,
  ]
    .filter(Boolean)
    .join('\n');
  // The last lines say how old the card is, so they are kept whatever the day is like: the body gets what is left of the budget.
  let left = CARD_TEXT_BUDGET - heading.length - footer.length;
  const parts: Part[] = [heading];
  for (const part of body) {
    const text = fit(part, left);
    if (!text) continue;
    left -= text.length;
    parts.push(DIVIDER, text);
  }
  if (!body.length) parts.push(DIVIDER, 'Nothing can be read right now: the Arbitration schedule and the world state are both unavailable. Try again in a few minutes.');
  parts.push(
    DIVIDER,
    footer,
    buttonRow(
      settings.lfgChannelId && input.arby.current ? squadButton() : null,
      boardLink(settings.guildId, settings.arbitrationsChannelId, 'Arbitrations'),
      boardLink(settings.guildId, settings.fissuresChannelId, 'Fissures'),
      boardLink(settings.guildId, settings.alertsChannelId, 'Alerts'),
      boardLink(settings.guildId, settings.tradersChannelId, 'Traders'),
    ),
  );
  return card(COLORS.brand, parts);
}

/** Reads what the card is drawn from, the way the `world-state` job does: both sources are cached, so this asks nothing new. */
export async function nowInput(ctx: AppContext, now = Date.now()): Promise<FeedInput> {
  const ws = worldStateEnabled() ? await getWorldState().catch(() => null) : null;
  const arbyData = await loadArbitrations().catch(() => null);
  const arby = arbitrationView(arbyData, ws, now, { hours: 48, bestDays: 0 });
  return feedInput(ctx, { ws, arbyData, arby, now });
}
