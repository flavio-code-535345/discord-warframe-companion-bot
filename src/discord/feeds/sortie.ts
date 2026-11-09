import type { ContainerBuilder } from 'discord.js';
import { discordTime, toMs } from '../../time.js';
import { type WorldState, archimedeaName } from '../../warframe/worldstate.js';
import { e, emojiUrl, factionTag, shardEmoji } from '../emoji.js';
import { buttonRow, mineButton, notifyRow, weeklyButton } from './controls.js';
import { DIVIDER, type Part, card, nodeName, planetOf, section } from './parts.js';
import { type FeedInput, STALE_NOTE } from './types.js';

/**
 * 🗡️┃sortie-archon: the daily sortie and the weekly Archon Hunt (with the shard its archon drops) in one message, and the weekly
 * Archimedeas (Deep and Temporal) with the Steel Path honors and the controls in the second.
 */

const COLOR = { sortie: 0xd97706, weekly: 0xb91c1c } as const;

/** Which shard each archon drops. */
const ARCHON_SHARD: [RegExp, string][] = [
  [/amar/i, 'Crimson'],
  [/nira/i, 'Amber'],
  [/boreal/i, 'Azure'],
];
export const archonShard = (boss: string | null | undefined): string | null => ARCHON_SHARD.find(([re]) => re.test(boss ?? ''))?.[1] ?? null;

const live = (expiry: unknown, now: number) => toMs(expiry as never) > now;

function sortiePart(ws: WorldState, now: number): Part[] {
  const s = ws.sortie;
  if (!s || !live(s.expiry, now) || !s.variants?.length) return [`## ${e('sortie')} Daily sortie\nNo sortie right now.`];
  const faction = factionTag(s.faction);
  const head = `## ${e('sortie')} Daily sortie${s.boss ? ` · ${s.boss}` : ''}\n${faction ? `${faction}${faction === s.faction ? '' : ` ${s.faction}`} · ` : ''}resets ${discordTime(s.expiry, 'R')}`;
  const missions = s.variants
    .map((v, i) => `**${i + 1}. ${v.missionType}** · ${nodeName(v.node)}${planetOf(v.node) ? `, ${planetOf(v.node)}` : ''}\n-# ${v.modifier}${v.modifierDescription ? `: ${v.modifierDescription}` : ''}`)
    .join('\n');
  return [section(head, emojiUrl('sortie')), missions];
}

/** The Archon Hunt: the archon, the shard it drops, the planet and the three missions (also in the weekly post, a heading lower). */
export function archonPart(ws: WorldState, now: number, heading: '##' | '###' = '##'): Part[] {
  const a = ws.archonHunt;
  if (!a || !live(a.expiry, now) || !a.missions?.length) return [`${heading} ${e('archon')} Archon Hunt\nNo Archon Hunt right now.`];
  const shard = archonShard(a.boss);
  const planets = new Set(a.missions.map((m) => planetOf(m.node)));
  const planet = planets.size === 1 ? [...planets][0] : null;
  const head = [
    `${heading} ${shard ? shardEmoji(shard) : e('archon')} Archon Hunt${a.boss ? ` · ${a.boss}` : ''}`,
    `${shard ? `Drops a **${shard} Archon Shard** · ` : ''}${planet ? `on **${planet}** · ` : ''}resets ${discordTime(a.expiry, 'R')}`,
  ].join('\n');
  const missions = a.missions.map((m, i) => `**${i + 1}. ${m.type}** · ${planet ? nodeName(m.node) : m.node}`).join('\n');
  return [section(head, emojiUrl('archon')), missions, '-# Three missions in a row; the archon waits in the last one. Once a week per account.'];
}

function archimedeaPart(ws: WorldState, now: number): Part[] {
  const list = (ws.archimedeas ?? []).filter((a) => live((a as { expiry?: unknown }).expiry ?? now + 1, now));
  if (!list.length) return [];
  return list.map((a) => {
    const expiry = (a as { expiry?: unknown }).expiry;
    const missions = (a.missions ?? []).map((m, i) => {
      const risks = (m.risks ?? []).map((r) => (r.isHard ? `**${r.name}**` : r.name)).join(', ');
      return `**${i + 1}. ${m.missionType}**${m.deviation?.name ? ` · ${m.deviation.name}` : ''}${risks ? `\n-# Risks: ${risks}` : ''}`;
    });
    const personal = (a.personalModifiers ?? []).map((p) => p.name).join(', ');
    const faction = a.missions?.[0]?.faction;
    return [
      `### 🧩 ${archimedeaName(a.type)}${faction ? ` · ${faction}` : ''}`,
      missions.join('\n'),
      personal ? `-# Personal modifiers: ${personal}` : '',
      expiry ? `-# Resets ${discordTime(expiry as never, 'R')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
}

/** Teshin's Steel Path honor this week and the next one (also the weekly post's). */
export function honorsPart(ws: WorldState, now: number): Part {
  const sp = ws.steelPath;
  if (!sp?.currentReward || !live(sp.expiry, now)) return null;
  const rotation = sp.rotation ?? [];
  const idx = rotation.findIndex((r) => r.name === sp.currentReward.name);
  const next = idx >= 0 ? rotation[(idx + 1) % rotation.length] : undefined;
  return [
    `### ${e('steelPath')} Steel Path honors`,
    `This week: **${sp.currentReward.name}** · ${sp.currentReward.cost} ${e('steelPath')} · rotates ${discordTime(sp.expiry, 'R')}`,
    next ? `-# Next week: ${next.name} (${next.cost}) · the whole rotation is in the traders channel` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function sortieBoard(input: FeedInput): ContainerBuilder[][] {
  const { ws, now } = input;
  if (!ws) {
    const off = 'The world state is not available right now.';
    return [[card(COLOR.sortie, [`## ${e('sortie')} Daily sortie`, off])], [card(COLOR.weekly, [`## 🧩 Weekly missions`, off, DIVIDER, notifyRow('sortie'), buttonRow(mineButton(), weeklyButton())])]];
  }
  const archimedeas = archimedeaPart(ws, now);
  return [
    [card(COLOR.sortie, [...sortiePart(ws, now), DIVIDER, ...archonPart(ws, now)])],
    [
      card(COLOR.weekly, [
        archimedeas.length ? null : '## 🧩 Weekly missions',
        ...archimedeas.flatMap((p, i) => (i ? [DIVIDER, p] : [p])),
        DIVIDER,
        honorsPart(ws, now),
        input.stale ? `-# ${STALE_NOTE}` : null,
        DIVIDER,
        notifyRow('sortie'),
        buttonRow(mineButton(), weeklyButton()),
        '-# **Weeklies by DM**: every Monday the Circuit, Nightwave, the Archon Hunt and Steel Path in one message.',
      ]),
    ],
  ];
}
