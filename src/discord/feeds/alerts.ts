import type { ContainerBuilder } from 'discord.js';
import { discordTime, toMs } from '../../time.js';
import { type AlertGroup, type WorldState, groupAlerts, rewardText } from '../../warframe/worldstate.js';
import { e, emojiUrl, factionTag, rewardEmoji } from '../emoji.js';
import { buttonRow, mineButton, notifyRow } from './controls.js';
import { DIVIDER, type Part, bar, card, fit, nodeName, num, planetOf, section } from './parts.js';
import { type FeedInput, STALE_NOTE } from './types.js';

/**
 * 🚨┃alerts: alerts and Gifts of the Lotus, then the running events with their goals, in the first message; Nightwave's daily and
 * weekly acts with the controls in the second. An event's endless resource missions are folded into one line (`groupAlerts`).
 */

const COLOR = { alerts: 0xf59e0b, nightwave: 0xbe123c } as const;

function alertBlock(g: AlertGroup): string {
  const star = g.notable ? `${e('star')} ` : '';
  const pay = `${rewardEmoji(g.reward)} ${g.reward}`.trim();
  const ends = toMs(g.alerts[0]!.expiry);
  if (g.alerts.length === 1) {
    const a = g.alerts[0]!;
    const m = a.mission;
    const planet = planetOf(m.node);
    const levels = m.minEnemyLevel && m.maxEnemyLevel ? ` · Lv ${m.minEnemyLevel}–${m.maxEnemyLevel}` : '';
    const flags = [m.archwingRequired ? 'Archwing' : '', m.nightmare ? 'Nightmare' : ''].filter(Boolean).join(', ');
    return [
      `${star}**${g.name}** · ${m.type} · ${nodeName(m.node)}${planet ? `, ${planet}` : ''}${m.faction ? ` · ${factionTag(m.faction)}` : ''}`,
      `-# ${pay}${levels}${flags ? ` · ${flags}` : ''} · ends ${discordTime(ends, 'R')}`,
    ].join('\n');
  }
  const planets = new Set(g.alerts.map((a) => planetOf(a.mission.node)));
  const types = [...new Set(g.alerts.map((a) => a.mission.type).filter(Boolean))].join(', ');
  const where = planets.size === 1 && !planets.has(null) ? ` on ${[...planets][0]}` : '';
  return [`${star}**${g.name}** ×${g.alerts.length}${where} · ${types}`, `-# ${pay} each · the first ends ${discordTime(ends, 'R')}`].join('\n');
}

type WorldEvent = WorldState['events'][number];

function eventBlock(ev: WorldEvent): string {
  const max = Number(ev.maximumScore) || 0;
  const pct = max > 1 ? Math.round((Number(ev.currentScore) / max) * 100) : typeof ev.health === 'number' ? Math.round(ev.health) : null;
  const goal = (ev.interimSteps ?? [])
    .filter((s) => max > 1 && Number(s.goal) > Number(ev.currentScore))
    .map((s) => ({ goal: Number(s.goal), reward: rewardText(s.reward) }))
    .find((s) => s.reward !== '—');
  const rewards = (ev.rewards ?? []).map(rewardText).filter((r) => r !== '—');
  const lines = [
    `**${ev.description}**${ev.node ? ` · ${ev.node}` : ''}${ev.tooltip && ev.tooltip !== ev.description ? `\n-# ${ev.tooltip}` : ''}`,
    pct !== null ? `${bar(pct)} \`${pct}%\`${max > 1 ? ` · ${num(ev.currentScore)} / ${num(max)}` : ''} · ends ${discordTime(ev.expiry, 'R')}` : `Ends ${discordTime(ev.expiry, 'R')}`,
    goal ? `-# Next goal at ${num(goal.goal)}: ${goal.reward}` : '',
    rewards.length ? `-# Final reward: ${rewards.join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function nightwavePart(ws: WorldState, now: number): Part[] {
  const nw = ws.nightwave;
  const acts = (nw?.activeChallenges ?? []).filter((c) => toMs(c.expiry) > now);
  if (!nw || !acts.length) return [`## ${e('nightwave')} Nightwave\nNightwave is not running right now.`];
  const block = (title: string, list: typeof acts) =>
    list.length ? `### ${title}\n${list.map((c) => `**${c.title}** · ${c.desc} · ${num(c.reputation)}${c.isDaily ? ` · ${discordTime(c.expiry, 'R')}` : ''}`).join('\n')}` : null;
  const weekly = acts.filter((c) => !c.isDaily && !c.isElite);
  const elite = acts.filter((c) => c.isElite);
  const weeklyEnds = [...weekly, ...elite].map((c) => toMs(c.expiry)).sort((a, b) => a - b)[0];
  return [
    section(`## ${e('nightwave')} Nightwave · season ${nw.season}\n-# Season ends ${discordTime(nw.expiry, 'D')}${weeklyEnds ? ` · weekly acts reset ${discordTime(weeklyEnds, 'R')}` : ''}`, emojiUrl('nightwave')),
    DIVIDER,
    block('Daily', acts.filter((c) => c.isDaily)),
    block('Weekly', weekly),
    block('Elite weekly', elite),
  ];
}

export function alertBoard(input: FeedInput): ContainerBuilder[][] {
  const { ws, now } = input;
  if (!ws) {
    const off = 'The world state is not available right now.';
    return [[card(COLOR.alerts, [`## ${e('alert')} Alerts`, off])], [card(COLOR.nightwave, [`## ${e('nightwave')} Nightwave`, off, DIVIDER, notifyRow('alerts'), buttonRow(mineButton())])]];
  }
  const alerts = groupAlerts((ws.alerts ?? []).filter((a) => toMs(a.expiry) > now));
  const events = (ws.events ?? []).filter((ev) => toMs(ev.expiry) > now);
  return [
    [
      card(COLOR.alerts, [
        section(`## ${e('alert')} Alerts\n-# ${alerts.length ? `${alerts.reduce((n, g) => n + g.alerts.length, 0)} running · ${e('star')} marks a reward worth a detour` : 'None running right now.'}`, emojiUrl('alert')),
        alerts.length ? DIVIDER : null,
        fit(alerts.map(alertBlock).join('\n'), 2000),
        events.length ? DIVIDER : null,
        events.length ? `## ${e('event')} Events` : null,
        events.length ? fit(events.map(eventBlock).join('\n\n'), 1600) : null,
      ]),
    ],
    [card(COLOR.nightwave, [...nightwavePart(ws, now), input.stale ? `-# ${STALE_NOTE}` : null, DIVIDER, notifyRow('alerts', '🔔 DM me when a reward shows up…'), buttonRow(mineButton())])],
  ];
}
