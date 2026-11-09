import type { ContainerBuilder } from 'discord.js';
import { type WorldState, isNotableReward, rewardText } from '../../warframe/worldstate.js';
import { e, emojiUrl, factionTag, rewardEmoji } from '../emoji.js';
import { buttonRow, mineButton, notifyRow } from './controls.js';
import { DIVIDER, bar, card, nodeName, planetOf, section } from './parts.js';
import { type FeedInput, type FeedPing, STALE_NOTE } from './types.js';

/**
 * ⚔️┃invasions: every running invasion, the ones with a reward worth running (Forma, Catalysts, Wraith and Vandal parts…) first. A
 * line says where it is, what each side pays and how far each side has pushed (the bar is the attacker's share).
 */

const COLOR = 0xea580c;
type Invasion = WorldState['invasions'][number];

const notable = (inv: Invasion) => [rewardText(inv.attacker.reward), rewardText(inv.defender.reward)].some((r) => r !== '—' && isNotableReward(r));

function side(faction: string, reward: string, right = false): string {
  const tag = factionTag(faction);
  const label = tag === faction ? `**${faction}**` : tag;
  const pay = reward === '—' ? '' : `${rewardEmoji(reward)} ${reward}`.trim();
  return right ? [pay, label].filter(Boolean).join(' ') : [label, pay].filter(Boolean).join(' ');
}

export function invasionLines(inv: Invasion): string {
  const planet = planetOf(inv.node);
  const atk = Math.max(0, Math.min(100, Math.round(inv.completion)));
  const attacker = side(inv.attacker.faction, inv.vsInfestation ? '—' : rewardText(inv.attacker.reward));
  const defender = side(inv.defender.faction, rewardText(inv.defender.reward), true);
  return [
    `${notable(inv) ? `${e('star')} ` : ''}**${nodeName(inv.node)}**${planet ? `, ${planet}` : ''} · ${inv.desc}`,
    `${attacker} \`${atk}%\` ${bar(atk)} \`${100 - atk}%\` ${defender}`,
  ].join('\n');
}

export function invasionBoard(input: FeedInput): ContainerBuilder[][] {
  const { ws } = input;
  const open = (ws?.invasions ?? []).filter((i) => !i.completed);
  const sorted = [...open].sort((a, b) => Number(notable(b)) - Number(notable(a)) || b.completion - a.completion);
  const worth = sorted.filter(notable).length;
  return [
    [
      card(COLOR, [
        section(
          `## ${e('invasion')} Invasions\n-# ${open.length ? `${open.length} running${worth ? ` · ${e('star')} ${worth} worth running` : ''}` : ws ? 'None running right now.' : 'The world state is not available right now.'}`,
          emojiUrl('invasion'),
        ),
        DIVIDER,
        sorted.map(invasionLines).join('\n\n') || null,
        open.length ? '-# Run a side three times for its reward. The bar shows how far the attacker has pushed.' : null,
        input.stale ? `-# ${STALE_NOTE}` : null,
        DIVIDER,
        notifyRow('invasions', '🔔 DM me when a reward shows up…'),
        buttonRow(mineButton()),
      ]),
    ],
  ];
}

/** A new invasion with a notable reward: the alerts role's note, for three hours (invasions have no end time). */
export function invasionPings(input: FeedInput): FeedPing[] {
  const { ws, now } = input;
  return (ws?.invasions ?? [])
    .filter((i) => !i.completed && notable(i))
    .map((i) => {
      const rewards = [rewardText(i.attacker.reward), rewardText(i.defender.reward)].filter((r) => r !== '—' && isNotableReward(r));
      return { key: `invasion:${i.id}`, until: now + 3 * 3_600_000, text: `${e('invasion')} **Invasion** on ${i.node}: **${rewards.join(' / ')}**` };
    });
}
