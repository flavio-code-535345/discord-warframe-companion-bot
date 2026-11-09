import { ActionRowBuilder, type ContainerBuilder, type MessageActionRowComponentBuilder, StringSelectMenuBuilder } from 'discord.js';
import { WEEK_MS, discordTime, weekStart } from '../../time.js';
import { CETUS, DUVIRI_MOODS, DUVIRI_MOOD_MS, VALLIS, projectCycles } from '../../warframe/cycles.js';
import { type WorldState, bountyStanding } from '../../warframe/worldstate.js';
import { BOUNTY_SYNDICATES } from '../embeds.js';
import { cycleEmoji, e, emojiFor, emojiUrl } from '../emoji.js';
import { buttonRow, mineButton, notifyRow } from './controls.js';
import { DIVIDER, type Part, cap, card, num, section } from './parts.js';
import { type FeedInput, STALE_NOTE } from './types.js';

/**
 * 🌗┃cycles: the open worlds with their state, when it changes and the next times worth planning around (Eidolon nights, warm Orb
 * Vallis), all worked out from the fixed phase lengths (warframe/cycles.ts), so they are right between world state reads. The second
 * message is this week's Duviri Circuit and the bounties of each syndicate, with a menu that shows one syndicate's bounties in full.
 */

const COLOR = { worlds: 0x0f766e, duviri: 0x7c3aed } as const;

const state = (s: string) => `${cycleEmoji(s)} ${cap(s.toLowerCase())}`.trim();

/** The next `n` starts of a phase that repeats every `cycle` ms; `nextStart` is when it starts next. */
const repeats = (nextStart: number, cycle: number, n = 3) => Array.from({ length: n }, (_, i) => nextStart + i * cycle);
const times = (list: number[]) => list.map((t) => discordTime(t, 't')).join(', ');

/** The worlds as lines; each says what it is now, what comes next and when. */
export function worldLines(ws: WorldState, now: number): string[] {
  const p = projectCycles(ws, now);
  const cetusCycle = CETUS.day + CETUS.night;
  const nextNight = p.cetus.isDay ? p.cetus.expiry : p.cetus.expiry + CETUS.day;
  const vallisCycle = VALLIS.warm + VALLIS.cold;
  const nextWarm = p.vallis.isWarm ? p.vallis.expiry + VALLIS.cold : p.vallis.expiry;
  const other = (s: string, a: string, b: string) => (s.toLowerCase() === a ? b : a);
  const out = [
    `**Cetus** · ${state(p.cetus.isDay ? 'day' : 'night')} · ${p.cetus.isDay ? 'night' : 'day'} ${discordTime(p.cetus.expiry, 'R')}`,
    `-# Next nights (Eidolons): ${times(repeats(nextNight, cetusCycle))}`,
    `**Orb Vallis** · ${state(p.vallis.isWarm ? 'warm' : 'cold')} · ${p.vallis.isWarm ? 'cold' : 'warm'} ${discordTime(p.vallis.expiry, 'R')}`,
    `-# Warm again: ${times(repeats(nextWarm, vallisCycle))}`,
    `**Cambion Drift** · ${state(p.cambion.state)} · ${other(p.cambion.state, 'fass', 'vome')} ${discordTime(p.cambion.expiry, 'R')}`,
    `**Zariman** · ${state(p.zariman.state)} · ${p.zariman.state === 'corpus' ? 'Grineer' : 'Corpus'} ${discordTime(p.zariman.expiry, 'R')}`,
    `**Earth** · ${state(p.earth.isDay ? 'day' : 'night')} · ${p.earth.isDay ? 'night' : 'day'} ${discordTime(p.earth.expiry, 'R')}`,
  ];
  if (p.duviri) {
    const at = DUVIRI_MOODS.indexOf(p.duviri.state.toLowerCase());
    const next = at >= 0 ? [1, 2].map((i) => DUVIRI_MOODS[(at + i) % DUVIRI_MOODS.length]!) : [];
    out.push(
      `**Duviri** · ${state(p.duviri.state)}${next[0] ? ` · ${cap(next[0])} ${discordTime(p.duviri.expiry, 'R')}` : ` · changes ${discordTime(p.duviri.expiry, 'R')}`}`,
    );
    if (next[1]) out.push(`-# Then ${cap(next[1])} at ${discordTime(p.duviri.expiry + DUVIRI_MOOD_MS, 't')}`);
  }
  return out;
}

function circuitPart(ws: WorldState, now: number): Part {
  const d = ws.duviriCycle as { choices?: { category?: string; choices?: string[] }[] } | undefined;
  const normal = d?.choices?.find((c) => c.category === 'normal')?.choices ?? [];
  const hard = d?.choices?.find((c) => c.category === 'hard')?.choices ?? [];
  if (!normal.length && !hard.length) return null;
  return [
    `### ${e('duviri')} Duviri Circuit · resets ${discordTime(weekStart(now) + WEEK_MS, 'R')}`,
    normal.length ? `**Warframes:** ${normal.join(', ')}` : '',
    hard.length ? `**Incarnon (Steel Path):** ${hard.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The syndicates whose bounties are listed now (an empty one is left out). */
export function bountySyndicates(ws: WorldState | null): string[] {
  const listed = new Set((ws?.syndicateMissions ?? []).filter((m) => m.jobs?.length).map((m) => m.syndicate));
  return BOUNTY_SYNDICATES.filter((s) => listed.has(s));
}

function bountiesPart(ws: WorldState): Part[] {
  const lines: string[] = [];
  let rotates: unknown = null;
  for (const name of bountySyndicates(ws)) {
    const m = ws.syndicateMissions.find((s) => s.syndicate === name)!;
    rotates ??= m.expiry;
    const levels = m.jobs.flatMap((j) => j.enemyLevels ?? []);
    const top = m.jobs.at(-1);
    const standing = bountyStanding(top?.standingStages);
    const bits = [`${m.jobs.length} bounties`, levels.length ? `Lv ${Math.min(...levels)}–${Math.max(...levels)}` : '', standing ? `up to ${num(standing)} standing` : ''].filter(Boolean);
    lines.push(`**${name}** · ${bits.join(' · ')}`);
  }
  if (!lines.length) return [];
  const menu = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('feeds:bounty')
      .setPlaceholder('📜 Show the bounties of…')
      .addOptions(bountySyndicates(ws).map((s) => ({ label: s, value: s, emoji: emojiFor('bounty') }))),
  );
  return [`### ${e('bounty')} Bounties${rotates ? ` · rotate ${discordTime(rotates as never, 'R')}` : ''}\n${lines.join('\n')}`, menu];
}

export function cycleBoard(input: FeedInput): ContainerBuilder[][] {
  const { ws, now } = input;
  if (!ws) {
    const off = 'The world state is not available right now.';
    return [[card(COLOR.worlds, [`## ${e('cycle')} Open worlds`, off])], [card(COLOR.duviri, [`## ${e('duviri')} Duviri and bounties`, off, DIVIDER, notifyRow('cycles'), buttonRow(mineButton())])]];
  }
  let worlds: string[] = [];
  try {
    worlds = worldLines(ws, now);
  } catch (err) {
    console.warn('[feeds] cycles skipped:', (err as Error).message);
  }
  return [
    [card(COLOR.worlds, [section(`## ${e('cycle')} Open worlds\n-# Worked out from the fixed cycle lengths, so they stay right between updates.`, emojiUrl('cycle')), DIVIDER, worlds.join('\n') || 'No cycle data right now.'])],
    [
      card(COLOR.duviri, [
        circuitPart(ws, now),
        DIVIDER,
        ...bountiesPart(ws),
        input.stale ? `-# ${STALE_NOTE}` : null,
        DIVIDER,
        notifyRow('cycles', '🔔 DM me when it turns…'),
        buttonRow(mineButton()),
      ]),
    ],
  ];
}
