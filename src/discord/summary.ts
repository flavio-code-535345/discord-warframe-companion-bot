import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { discordTime, toMs } from '../time.js';
import { projectCycles } from '../warframe/cycles.js';
import { NOTABLE_REWARD, type WorldState, activeArbitration, alertName, isBaroHere, rewardText, worldStateStaleNote } from '../warframe/worldstate.js';
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

/** Alerts as lines; an event's endless resource missions share one reward, so they are folded into a single line. */
function alertLines(alerts: NonNullable<WorldState['alerts']>): string[] {
  const lines: string[] = [];
  const events = new Map<string, typeof alerts>();
  for (const a of alerts) {
    if (alertName(a).startsWith('Event mission')) {
      const reward = rewardText(a.mission.reward);
      events.set(reward, [...(events.get(reward) ?? []), a]);
    } else {
      lines.push(`**${alertName(a)}** — ${a.mission.node} · ${rewardText(a.mission.reward)} · ends ${discordTime(a.expiry)}`);
    }
  }
  for (const [reward, group] of events) {
    if (group.length === 1) {
      const a = group[0]!;
      lines.push(`**${alertName(a)}** — ${a.mission.node} · ${reward} · ends ${discordTime(a.expiry)}`);
      continue;
    }
    const where = group.map((a) => `${a.mission.type ?? 'Mission'} (${a.mission.node})`).join(', ');
    const next = group.reduce((soonest, a) => (toMs(a.expiry) < toMs(soonest.expiry) ? a : soonest));
    lines.push(`**${group.length} event missions** — ${where} · ${reward} · first ends ${discordTime(next.expiry)}`);
  }
  return lines;
}

export function summaryEmbeds(ws: WorldState, opts: SummaryOptions, now = Date.now()): EmbedBuilder[] {
  const live = (expiry: Parameters<typeof toMs>[0]) => toMs(expiry) > now;
  const by: Record<Group, Field[]> = { worlds: [], void: [], resets: [], events: [] };

  section(by.worlds, '🌍 Cycles', () => {
    const p = projectCycles(ws, now);
    const lines = [
      `**Cetus** ${p.cetus.isDay ? '☀️ day' : '🌙 night'} · ${discordTime(p.cetus.expiry)}`,
      `**Orb Vallis** ${p.vallis.isWarm ? '🔥 warm' : '❄️ cold'} · ${discordTime(p.vallis.expiry)}`,
      `**Cambion Drift** ${cap(p.cambion.state)} · ${discordTime(p.cambion.expiry)}`,
      `**Zariman** ${cap(p.zariman.state)} · ${discordTime(p.zariman.expiry)}`,
    ];
    if (ws.duviriCycle?.state) lines.push(`**Duviri** ${cap(ws.duviriCycle.state)} · ${discordTime(ws.duviriCycle.expiry)}`);
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
      open.some((f) => f.isStorm) ? `🌀 ${open.filter((f) => f.isStorm).length} Void Storm${open.filter((f) => f.isStorm).length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return `${counts.map(([t, n]) => `**${t}** ${n}`).join(' · ')}${extra.length ? `\n${extra.join(' · ')}` : ''}\n-# 🔱 Steel Path = hard mode · 🌀 Void Storm = Railjack fissure · tap **Fissures** below for the full list`;
  });

  section(by.void, '⚖️ Arbitration', () => {
    const a = activeArbitration(ws, now);
    if (!a) return null;
    const flags = [a.archwing ? 'Archwing' : '', a.sharkwing ? 'Sharkwing' : ''].filter(Boolean);
    return `**${a.type ?? 'Unknown'}** — ${a.node}${a.enemy ? ` · ${a.enemy}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}\nEnds ${discordTime(a.expiry)}\n-# Endless mission that changes every hour and drops Vitus Essence`;
  });

  section(by.resets, `⚔️ Daily sortie${ws.sortie?.boss ? ` — ${ws.sortie.boss}` : ''}`, () => {
    const s = ws.sortie;
    if (!s || !live(s.expiry)) return null;
    const lines = (s.variants ?? []).map((v, i) => `**${i + 1}.** ${v.missionType} — ${v.node} · ${v.modifier}`);
    return `${clampLines(lines, FIELD_LIMIT - 60)}\nResets ${discordTime(s.expiry)}`;
  }, true);

  section(by.resets, `🗡️ Archon Hunt${ws.archonHunt?.boss ? ` — ${ws.archonHunt.boss}` : ''}`, () => {
    const a = ws.archonHunt;
    if (!a || !live(a.expiry)) return null;
    const lines = (a.missions ?? []).map((m, i) => `**${i + 1}.** ${m.type} — ${m.node}`);
    return `${clampLines(lines, FIELD_LIMIT - 60)}\nResets ${discordTime(a.expiry)}`;
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
      if (![attacker, defender].some((r) => NOTABLE_REWARD.test(r))) continue;
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
    embeds[0]!.setDescription(`Live overview for ${opts.clanName}, edited as things change.\n**Tap a button** for details, or **pick something in the menu** to get a DM from ${opts.botName} when it shows up.`);
  }
  embeds[embeds.length - 1]!.setFooter({ text: stale ?? `${opts.botName} · ${opts.clanName}`, iconURL: opts.iconURL });
  return embeds;
}

/** A fingerprint of what the message says, so it is only edited when something changed. */
export function summaryHash(embeds: EmbedBuilder[]): string {
  return createHash('sha1').update(JSON.stringify(embeds.map((e) => e.toJSON()))).digest('hex');
}
