import type { ContainerBuilder } from 'discord.js';
import { discordTime, toMs } from '../../time.js';
import { type WorldState, isBaroHere, resurgenceItemName } from '../../warframe/worldstate.js';
import { e, emojiUrl } from '../emoji.js';
import { buttonRow, mineButton, notifyRow, roleButton } from './controls.js';
import { DIVIDER, type Part, card, compact, fit, num, section } from './parts.js';
import { type FeedInput, type FeedPing, type PriceLookup, STALE_NOTE } from './types.js';

/**
 * 🛒┃traders: Baro Ki'Teer in the first message (his whole inventory with ducats and credits while he is at a relay, else where and
 * when he lands), and Darvo's deal, Varzia's Prime Resurgence and Teshin's Steel Path honors with the controls in the second.
 */

const COLOR = { baro: 0x0891b2, others: 0xca8a04 } as const;
/** The room Baro's list has in its message, below the heading. */
const BARO_LIST_BUDGET = 3500;

export type { PriceLookup };

function baroCard(ws: WorldState | null, now: number, prices: PriceLookup | null): ContainerBuilder {
  const t = ws?.voidTrader;
  if (!t) return card(COLOR.baro, [`## ${e('baro')} Baro Ki'Teer`, ws ? 'No Void Trader data right now.' : 'The world state is not available right now.']);
  if (!isBaroHere(ws!, now)) {
    return card(COLOR.baro, [
      section(
        [`## ${e('baro')} Baro Ki'Teer`, `Arrives ${discordTime(t.activation, 'R')} at **${t.location}**`, `-# ${discordTime(t.activation, 'F')} · he stays until ${discordTime(t.expiry, 'f')}`].join('\n'),
        emojiUrl('baro'),
      ),
    ]);
  }
  const items = [...(t.inventory ?? [])].sort((a, b) => Number(b.ducats) - Number(a.ducats) || a.item.localeCompare(b.item));
  const ducats = items.reduce((sum, i) => sum + Number(i.ducats || 0), 0);
  // With an icon on every price; a big visit (an anniversary brings 60 items) gets plain words instead, so the whole stock fits.
  const line = (i: (typeof items)[number], icons: boolean) => {
    const plat = prices?.(i.item) ?? null;
    const value = plat && Number(i.ducats) ? ` · ${icons ? `${e('platinum')} ${plat}` : `${plat}p`} (${(plat / Number(i.ducats)).toFixed(2)}/ducat)` : '';
    const cost = icons ? `${e('ducats')} ${num(i.ducats)} · ${e('credits')} ${compact(i.credits)}` : `${num(i.ducats)} ducats · ${compact(i.credits)} cr`;
    return `**${i.item}** · ${cost}${value}`;
  };
  const rich = items.map((i) => line(i, true)).join('\n');
  // The item that sells for the most plat per ducat spent, once the market read has priced some of the stock.
  const resale = items
    .map((i) => ({ i, plat: prices?.(i.item) ?? null }))
    .filter((x): x is { i: (typeof items)[number]; plat: number } => x.plat !== null && Number(x.i.ducats) > 0)
    .sort((a, b) => b.plat / Number(b.i.ducats) - a.plat / Number(a.i.ducats))[0];
  return card(COLOR.baro, [
    section(
      [
        `## ${e('baro')} Baro Ki'Teer is here`,
        `At **${t.location}** · leaves ${discordTime(t.expiry, 'R')}`,
        `-# ${items.length} items · ${num(ducats)} ducats for one of each`,
        resale ? `-# Best resale: **${resale.i.item}** · ${resale.plat}p (${(resale.plat / Number(resale.i.ducats)).toFixed(2)}/ducat) · prices from warframe.market` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      emojiUrl('baro'),
    ),
    DIVIDER,
    rich.length <= BARO_LIST_BUDGET ? rich : fit(items.map((i) => line(i, false)).join('\n'), BARO_LIST_BUDGET),
  ]);
}

function darvoPart(ws: WorldState, now: number): Part {
  const deal = (ws.dailyDeals ?? []).find((d) => toMs(d.expiry) > now);
  if (!deal) return null;
  const left = deal.total - deal.sold;
  return [
    `### ${e('darvo')} Darvo's deal`,
    `**${deal.item}** · ~~${deal.originalPrice}~~ **${deal.salePrice}** ${e('platinum')} (−${deal.discount}%)`,
    `-# ${left > 0 ? `${left} of ${deal.total} left` : 'Sold out'} · ends ${discordTime(deal.expiry, 'R')}`,
  ].join('\n');
}

function varziaPart(ws: WorldState, now: number): Part {
  const t = ws.vaultTrader;
  if (!t?.inventory?.length || toMs(t.expiry) <= now) return null;
  // The feed's "ducats" are Regal Aya (bought, for Primes, packs and accessories) and its "credits" are Aya (earned, for relics).
  const items = [...t.inventory].sort((a, b) => Number(b.ducats ?? 0) - Number(a.ducats ?? 0) || Number(b.credits ?? 0) - Number(a.credits ?? 0));
  const lines = items.map((i) => {
    const price = [i.ducats ? `${e('regalAya')} ${num(i.ducats)}` : '', i.credits ? `${e('aya')} ${num(i.credits)}` : ''].filter(Boolean).join(' · ');
    return `${resurgenceItemName(i.item)}${price ? ` · ${price}` : ''}`;
  });
  return [
    `### ${e('varzia')} Prime Resurgence · Varzia`,
    `-# At ${t.location} · rotates ${discordTime(t.expiry, 'R')} · relics cost Aya (from missions), the rest Regal Aya`,
    fit(lines.join('\n'), 2200),
  ].join('\n');
}

function teshinPart(ws: WorldState, now: number): Part {
  const sp = ws.steelPath;
  if (!sp?.currentReward || toMs(sp.expiry) <= now) return null;
  const rotation = sp.rotation ?? [];
  const at = rotation.findIndex((r) => r.name === sp.currentReward.name);
  const upcoming = at >= 0 ? [1, 2, 3].map((i) => rotation[(at + i) % rotation.length]!).filter(Boolean) : [];
  return [
    `### ${e('teshin')} Teshin · Steel Path honors`,
    `This week: **${sp.currentReward.name}** · ${e('steelPath')} ${sp.currentReward.cost} · rotates ${discordTime(sp.expiry, 'R')}`,
    upcoming.length ? `-# Then: ${upcoming.map((r) => `${r.name} (${r.cost})`).join(' → ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function traderBoard(input: FeedInput, prices: PriceLookup | null = null): ContainerBuilder[][] {
  const { ws, now, settings, selfRoles } = input;
  const role = settings.baroRoleId && selfRoles.has(settings.baroRoleId) ? settings.baroRoleId : null;
  const parts: Part[] = ws ? [darvoPart(ws, now), DIVIDER, varziaPart(ws, now), DIVIDER, teshinPart(ws, now)] : ['The world state is not available right now.'];
  return [
    [baroCard(ws, now, prices)],
    [
      card(COLOR.others, [
        ...parts,
        ws ? '-# Waiting for a Prime to come back? `/track reward` with its name DMs you when Varzia or Baro has it.' : null,
        input.stale ? `-# ${STALE_NOTE}` : null,
        DIVIDER,
        notifyRow('traders', '🔔 DM me when…'),
        buttonRow(mineButton(), role ? roleButton(role, "Ping me when Baro lands", 'baro') : null),
      ]),
    ],
  ];
}

/** Baro landing: the Baro role's note, until he leaves. */
export function traderPings(input: FeedInput): FeedPing[] {
  const { ws, now } = input;
  const t = ws?.voidTrader;
  if (!ws || !t || !isBaroHere(ws, now)) return [];
  return [
    {
      key: `baro:${toMs(t.activation)}`,
      until: toMs(t.expiry),
      text: `${e('baro')} **Baro Ki'Teer has arrived** at **${t.location}** with ${t.inventory.length} items · leaves ${discordTime(t.expiry, 'R')}`,
    },
  ];
}
