import type { ContainerBuilder } from 'discord.js';
import { discordTime, toMs } from '../../time.js';
import { FISSURE_TIERS, type Fissure } from '../../warframe/worldstate.js';
import { e, emojiUrl, factionTag, tierEmoji } from '../emoji.js';
import { mineButton, notifyRow, buttonRow } from './controls.js';
import { DIVIDER, type Part, card, nodeName, planetOf, section } from './parts.js';
import { type FeedInput, STALE_NOTE } from './types.js';

/**
 * 🌀┃fissures: three messages, normal fissures, Steel Path and Void Storms (Railjack), each grouped by relic tier the way the
 * in-game list is, the soonest to close first. A line is the mission, the node, the faction and when it closes.
 */

const COLOR = { normal: 0x8b5cf6, steel: 0xdc2626, storm: 0x0ea5e9 } as const;

/** Missions that crack a relic quickly, marked so they are easy to find. */
const FAST = /^(capture|extermination|sabotage|rescue|spy)$/i;

function fissureLine(f: Fissure): string {
  const planet = planetOf(f.node);
  const faction = factionTag(f.enemy);
  return `${FAST.test(f.missionType) ? '⚡ ' : ''}**${f.missionType}** · ${nodeName(f.node)}${planet ? `, ${planet}` : ''}${faction ? ` · ${faction}` : ''} · ${discordTime(f.expiry, 'R')}`;
}

/** The fissures of one kind, a heading per tier (Lith first). */
function byTier(list: Fissure[]): Part[] {
  const known: string[] = [...FISSURE_TIERS];
  const tiers = [...known, ...new Set(list.map((f) => f.tier).filter((t) => !known.includes(t)))];
  const parts: Part[] = [];
  for (const tier of tiers) {
    const group = list.filter((f) => f.tier === tier).sort((a, b) => toMs(a.expiry) - toMs(b.expiry));
    if (!group.length) continue;
    parts.push(`### ${tierEmoji(tier)} ${tier} · ${group.length}\n${group.map(fissureLine).join('\n')}`);
  }
  return parts;
}

function kindCard(color: number, title: string, thumb: string | null, list: Fissure[], empty: string, extra: Part[] = []): ContainerBuilder {
  return card(color, [section(`## ${title}\n-# ${list.length} open${list.length ? ` · ${countLine(list)}` : ''}`, thumb), DIVIDER, ...(list.length ? byTier(list) : [empty]), ...extra]);
}

/** "2 Lith · 3 Meso · 1 Axi" */
function countLine(list: Fissure[]): string {
  const known: string[] = [...FISSURE_TIERS];
  return known
    .map((t) => [t, list.filter((f) => f.tier === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${t}`)
    .join(' · ');
}

export function fissureBoard(input: FeedInput): ContainerBuilder[][] {
  const { ws, now } = input;
  const open = (ws?.fissures ?? []).filter((f) => toMs(f.expiry) > now);
  const normal = open.filter((f) => !f.isHard && !f.isStorm);
  const steel = open.filter((f) => f.isHard && !f.isStorm);
  const storms = open.filter((f) => f.isStorm);
  const none = ws ? 'None open right now.' : 'The world state is not available right now.';
  return [
    [kindCard(COLOR.normal, `${e('fissure')} Void fissures`, emojiUrl('fissure'), normal, none)],
    [kindCard(COLOR.steel, `${e('steelPath')} Steel Path fissures`, emojiUrl('steelPath'), steel, none)],
    [
      kindCard(COLOR.storm, `${e('storm')} Void Storms`, emojiUrl('storm'), storms, none, [
        '-# Railjack missions: the relic is cracked in the Railjack or on the boarded ship. ⚡ marks the quick missions.',
        input.stale ? `-# ${STALE_NOTE}` : null,
        DIVIDER,
        notifyRow('fissures', '🔔 DM me when a fissure opens…'),
        buttonRow(mineButton()),
      ]),
    ],
  ];
}
