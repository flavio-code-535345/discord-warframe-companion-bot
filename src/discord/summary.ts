import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { discordTime, toMs } from '../time.js';
import { projectCycles } from '../warframe/cycles.js';
import { type WorldState, activeArbitration, foldAlerts, isBaroHere, isNotableReward, rewardText, worldStateStaleNote } from '../warframe/worldstate.js';
import { COLORS, clampLines } from './embeds.js';

/**
 * The one message in the alerts channel that says what is going on in Warframe right now: cycles, fissures by tier, the sortie, the
 * Archon Hunt, the Arbitration, Baro, the Steel Path honors, alerts and the invasions worth running. It is edited in place (see notifier.ts) so the
 * channel keeps a single, current message instead of a growing pile of separate alerts. It is four coloured embeds (open worlds, the Void,
 * daily and weekly resets, then alerts and invasions) so each block reads as its own card; short sections sit side by side. Pure: it is handed the world state.
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const TIERS = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
const FIELD_LIMIT = 1000;

const COLOR_VOID = 0x8b5cf6;

export interface SummaryOptions {
  botName: string;
  clanName: string;
  iconURL?: string | undefined;
}

interface Field {
  name: string;
  value: string;
  inline?: boolean;
}

type Group = 'worlds' | 'void' | 'resets' | 'events';
const GROUPS: { id: Group; color: number }[] = [
  { id: 'worlds', color: COLORS.brand },
  { id: 'void', color: COLOR_VOID },
  { id: 'resets', color: COLORS.void },
  { id: 'events', color: COLORS.warn },
];

/** Runs one section of the summary; a malformed piece of the world state drops that section instead of the whole message. */
function section(fields: Field[], name: string, build: () => string | null, inline = false): void {
  try {
    const value = build();
    if (value) fields.push({ name: name.slice(0, 256), value: value.slice(0, 1024), inline });
  } catch (err) {
    console.warn(`[summary] skipped "${name}":`, err instanceof Error ? err.message : err);
  }
}

/** "Isos (Eris)" → "Eris". */
const planetOf = (node: string): string | null => /\(([^)]+)\)\s*$/.exec(node)?.[1] ?? null;

/**
 * Alerts as lines; an event's endless resource missions share one reward, so they are folded into a single line. When they are all on one
 * planet that line names the planet once and only the mission types ("3 event missions on Eris: Hive, Mobile Defense, Survival").
 */
export function alertLines(alerts: NonNullable<WorldState['alerts']>): string[] {
  return foldAlerts(alerts).map((g) => {
    const planets = new Set((g.missions ?? []).map((m) => planetOf(m.node)));
    if (g.missions && planets.size === 1 && !planets.has(null)) {
      const types = [...new Set(g.missions.map((m) => m.type))].join(', ');
      return `**${g.name}** on ${[...planets][0]}: ${types} · ${g.reward} each · first ends ${discordTime(g.endsAt)}`;
    }
    return `**${g.name}** — ${g.where.join('; ')} · ${g.reward} · ${g.count > 1 ? 'first ends' : 'ends'} ${discordTime(g.endsAt)}`;
  });
}

/** One emoji per state, so every cycle reads the same way at a glance. */
const CYCLE_EMOJI: Record<string, string> = {
  fass: '🟠',
  vome: '🔵',
  corpus: '💠',
  grineer: '🪖',
  joy: '😄',
  anger: '😠',
  envy: '😒',
  sorrow: '😢',
  fear: '😨',
};
const stateText = (state: string) => `${CYCLE_EMOJI[state.toLowerCase()] ?? ''} ${state.toLowerCase()}`.trim();

export function summaryEmbeds(ws: WorldState, opts: SummaryOptions, now = Date.now()): EmbedBuilder[] {
  const live = (expiry: Parameters<typeof toMs>[0]) => toMs(expiry) > now;
  const by: Record<Group, Field[]> = { worlds: [], void: [], resets: [], events: [] };

  section(by.worlds, '🌍 Cycles', () => {
    const p = projectCycles(ws, now);
    const lines = [
      `**Cetus** ${p.cetus.isDay ? '☀️ day' : '🌙 night'} · ${discordTime(p.cetus.expiry)}`,
      `**Orb Vallis** ${p.vallis.isWarm ? '🔥 warm' : '❄️ cold'} · ${discordTime(p.vallis.expiry)}`,
      `**Cambion Drift** ${stateText(p.cambion.state)} · ${discordTime(p.cambion.expiry)}`,
      `**Zariman** ${stateText(p.zariman.state)} · ${discordTime(p.zariman.expiry)}`,
      `**Earth** ${p.earth.isDay ? '☀️ day' : '🌙 night'} · ${discordTime(p.earth.expiry)}`,
    ];
    if (p.duviri) lines.push(`**Duviri** ${stateText(p.duviri.state)} · ${discordTime(p.duviri.expiry)}`);
    return lines.join('\n');
  }, true);

  section(by.worlds, "👑 Baro Ki'Teer", () => {
    const t = ws.voidTrader;
    if (!t) return null;
    if (isBaroHere(ws, now)) return `At **${t.location}**, leaves ${discordTime(t.expiry)}\n${(t.inventory ?? []).length} items for sale: /wf baro`;
    return `Arrives at **${t.location}** ${discordTime(t.activation)}`;
  }, true);

  section(by.void, '🌀 Void fissures', () => {
    const open = (ws.fissures ?? []).filter((f) => live(f.expiry));
    if (!open.length) return null;
    const counts = TIERS.map((t) => [t, open.filter((f) => f.tier === t).length] as const).filter(([, n]) => n > 0);
    const extra = [
      open.some((f) => f.isHard) ? `🔱 ${open.filter((f) => f.isHard).length} Steel Path` : '',
      open.some((f) => f.isStorm) ? `☄️ ${open.filter((f) => f.isStorm).length} Void Storm${open.filter((f) => f.isStorm).length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return `${counts.map(([t, n]) => `**${t}** ${n}`).join(' · ')}${extra.length ? `\n${extra.join(' · ')}` : ''}\n-# 🔱 hard mode · ☄️ Railjack · **Fissures** below lists them all`;
  });

  section(by.void, '⚖️ Arbitration', () => {
    const a = activeArbitration(ws, now);
    if (!a) return null;
    const flags = [a.archwing ? 'Archwing' : '', a.sharkwing ? 'Sharkwing' : ''].filter(Boolean);
    return `**${a.type ?? 'Unknown'}** — ${a.node}${a.enemy ? ` · ${a.enemy}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}\nEnds ${discordTime(a.expiry)}\n-# Endless mission that changes every hour and drops Vitus Essence`;
  });

  // Full width: three missions with their modifiers wrap into a tall, narrow block as a column. The Archon Hunt and Steel Path honors
  // below share the next row, half the width each.
  section(by.resets, `⚔️ Daily sortie${ws.sortie?.boss ? ` — ${ws.sortie.boss}` : ''}`, () => {
    const s = ws.sortie;
    if (!s || !live(s.expiry)) return null;
    const lines = (s.variants ?? []).map((v, i) => `**${i + 1}.** ${v.missionType} — ${v.node} · ${v.modifier}`);
    return `${clampLines(lines, FIELD_LIMIT - 60)}\nResets ${discordTime(s.expiry)}`;
  });

  section(by.resets, `🗡️ Archon Hunt${ws.archonHunt?.boss ? ` — ${ws.archonHunt.boss}` : ''}`, () => {
    const a = ws.archonHunt;
    if (!a || !live(a.expiry)) return null;
    const missions = a.missions ?? [];
    // The hunt's missions are usually all on one planet: then it is named once instead of on every line.
    const planets = new Set(missions.map((m) => planetOf(m.node)));
    const planet = planets.size === 1 ? [...planets][0] : null;
    const lines = missions.map((m, i) => `**${i + 1}.** ${m.type} — ${planet ? m.node.replace(/\s*\([^)]*\)\s*$/, '') : m.node}`);
    return `${clampLines(lines, FIELD_LIMIT - 60)}\n${planet ? `On **${planet}** · resets` : 'Resets'} ${discordTime(a.expiry)}`;
  }, true);

  section(by.resets, '🔱 Steel Path honors', () => {
    const sp = ws.steelPath;
    if (!sp?.currentReward || !live(sp.expiry)) return null;
    return `${sp.currentReward.name} — ${sp.currentReward.cost} Steel Essence\nRotates ${discordTime(sp.expiry)}\n-# This week's reward from Teshin`;
  }, true);

  section(by.events, '⚠️ Alerts', () => {
    const open = (ws.alerts ?? []).filter((a) => live(a.expiry));
    if (!open.length) return null;
    return `${clampLines(alertLines(open), FIELD_LIMIT - 90)}\n-# Time-limited missions; only worthwhile rewards ping the alerts role`;
  });

  section(by.events, '🎯 Invasions worth running', () => {
    const lines: string[] = [];
    for (const inv of ws.invasions ?? []) {
      if (inv.completed) continue;
      const attacker = rewardText(inv.attacker.reward);
      const defender = rewardText(inv.defender.reward);
      if (![attacker, defender].some((r) => isNotableReward(r))) continue;
      lines.push(`**${inv.node}** · ${inv.vsInfestation ? '' : `${attacker} vs `}${defender} · ${Math.round(inv.completion)}%`);
    }
    return lines.length ? clampLines(lines, FIELD_LIMIT) : null;
  });

  const embeds = GROUPS.filter((g) => by[g.id].length).map((g) => new EmbedBuilder().setColor(g.color).addFields(by[g.id]));
  const empty = !embeds.length;
  if (empty) embeds.push(new EmbedBuilder().setColor(COLORS.brand).setDescription('Nothing to show right now: the world state has no data.'));

  // Without the minutes: the note would otherwise change every minute and the message would be edited every minute.
  const stale = worldStateStaleNote(now) ? 'Live data may be outdated: the world state source is lagging or not answering.' : null;
  embeds[0]!.setTitle('🌌 Warframe right now');
  if (!empty) {
    embeds[0]!.setDescription('Live overview, kept up to date. **Buttons** for details, the **menu** for DM alerts.');
  }
  embeds[embeds.length - 1]!.setFooter({ text: stale ?? `${opts.botName} · ${opts.clanName}`, iconURL: opts.iconURL });
  return embeds;
}

/** A fingerprint of what the message says, so it is only edited when something changed. */
export function summaryHash(embeds: EmbedBuilder[]): string {
  return createHash('sha1').update(JSON.stringify(embeds.map((e) => e.toJSON()))).digest('hex');
}
