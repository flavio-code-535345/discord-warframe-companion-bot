import { createHash } from 'node:crypto';
import { EmbedBuilder } from 'discord.js';
import { discordTime, toMs } from '../time.js';
import { projectCycles } from '../warframe/cycles.js';
import { NOTABLE_REWARD, type WorldState, alertName, isBaroHere, rewardText, worldStateStaleNote } from '../warframe/worldstate.js';
import { COLORS, clampLines } from './embeds.js';

/**
 * The one message in the alerts channel that says what is going on in Warframe right now: cycles, fissures by tier, the sortie, the
 * Archon Hunt, Baro, the Steel Path honors, alerts and the invasions worth running. It is edited in place (see notifier.ts) so the
 * channel keeps a single, current message instead of a growing pile of separate alerts. Pure: it is handed the world state.
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const TIERS = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
const FIELD_LIMIT = 1000;

export interface SummaryOptions {
  botName: string;
  clanName: string;
  iconURL?: string | undefined;
}

/** Runs one section of the summary; a malformed piece of the world state drops that section instead of the whole message. */
function section(fields: { name: string; value: string; inline?: boolean }[], name: string, build: () => string | null, inline = false): void {
  try {
    const value = build();
    if (value) fields.push({ name: name.slice(0, 256), value: value.slice(0, 1024), inline });
  } catch (err) {
    console.warn(`[summary] skipped "${name}":`, err instanceof Error ? err.message : err);
  }
}

export function summaryEmbed(ws: WorldState, opts: SummaryOptions, now = Date.now()): EmbedBuilder {
  const live = (expiry: Parameters<typeof toMs>[0]) => toMs(expiry) > now;
  const fields: { name: string; value: string; inline?: boolean }[] = [];

  section(fields, '🌍 Cycles', () => {
    const p = projectCycles(ws, now);
    const lines = [
      `**Cetus** ${p.cetus.isDay ? '☀️ day' : '🌙 night'} · ${discordTime(p.cetus.expiry)}`,
      `**Orb Vallis** ${p.vallis.isWarm ? '🔥 warm' : '❄️ cold'} · ${discordTime(p.vallis.expiry)}`,
      `**Cambion Drift** ${cap(p.cambion.state)} · ${discordTime(p.cambion.expiry)}`,
      `**Zariman** ${cap(p.zariman.state)} · ${discordTime(p.zariman.expiry)}`,
    ];
    if (ws.duviriCycle?.state) lines.push(`**Duviri** ${cap(ws.duviriCycle.state)} · ${discordTime(ws.duviriCycle.expiry)}`);
    return lines.join('\n');
  });

  section(fields, '🌀 Void fissures', () => {
    const open = (ws.fissures ?? []).filter((f) => live(f.expiry));
    if (!open.length) return null;
    const counts = TIERS.map((t) => [t, open.filter((f) => f.tier === t).length] as const).filter(([, n]) => n > 0);
    const extra = [
      open.some((f) => f.isHard) ? `🔱 ${open.filter((f) => f.isHard).length} Steel Path` : '',
      open.some((f) => f.isStorm) ? `🌀 ${open.filter((f) => f.isStorm).length} Void Storm${open.filter((f) => f.isStorm).length === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return `${counts.map(([t, n]) => `**${t}** ${n}`).join(' · ')}${extra.length ? `\n${extra.join(' · ')}` : ''}\n-# Details: /wf fissures`;
  });

  section(fields, `⚔️ Daily sortie${ws.sortie?.boss ? ` — ${ws.sortie.boss}` : ''}`, () => {
    const s = ws.sortie;
    if (!s || !live(s.expiry)) return null;
    const lines = (s.variants ?? []).map((v, i) => `**${i + 1}.** ${v.missionType} — ${v.node} · ${v.modifier}`);
    return `${clampLines(lines, FIELD_LIMIT - 60)}\nResets ${discordTime(s.expiry)}`;
  });

  section(fields, `🗡️ Archon Hunt${ws.archonHunt?.boss ? ` — ${ws.archonHunt.boss}` : ''}`, () => {
    const a = ws.archonHunt;
    if (!a || !live(a.expiry)) return null;
    const lines = (a.missions ?? []).map((m, i) => `**${i + 1}.** ${m.type} — ${m.node}`);
    return `${clampLines(lines, FIELD_LIMIT - 60)}\nResets ${discordTime(a.expiry)}`;
  });

  section(fields, "👑 Baro Ki'Teer", () => {
    const t = ws.voidTrader;
    if (!t) return null;
    if (isBaroHere(ws, now)) return `At **${t.location}**, leaves ${discordTime(t.expiry)}\n${(t.inventory ?? []).length} items for sale: /wf baro`;
    return `Arrives at **${t.location}** ${discordTime(t.activation)}`;
  });

  section(fields, '🔱 Steel Path honors', () => {
    const sp = ws.steelPath;
    if (!sp?.currentReward || !live(sp.expiry)) return null;
    return `${sp.currentReward.name} — ${sp.currentReward.cost} Steel Essence\nRotates ${discordTime(sp.expiry)}`;
  });

  section(fields, '⚠️ Alerts', () => {
    const open = (ws.alerts ?? []).filter((a) => live(a.expiry));
    if (!open.length) return null;
    return clampLines(
      open.map((a) => `**${alertName(a)}** — ${a.mission.node} · ${rewardText(a.mission.reward)} · ends ${discordTime(a.expiry)}`),
      FIELD_LIMIT,
    );
  });

  section(fields, '🎯 Invasions worth running', () => {
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

  // Without the minutes: the note would otherwise change every minute and the message would be edited every minute.
  const stale = worldStateStaleNote(now) ? 'Live data may be outdated: the world state source is lagging or not answering.' : null;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🌌 Warframe right now')
    .setDescription(`Updated by ${opts.botName} for ${opts.clanName}. This message is edited as things change.`)
    .setFooter({ text: stale ?? `${opts.botName} · ${opts.clanName}`, iconURL: opts.iconURL });
  if (fields.length) embed.addFields(fields);
  else embed.setDescription('Nothing to show right now: the world state has no data.');
  return embed;
}

/** A fingerprint of what the message says, so it is only edited when something changed. */
export function summaryHash(embed: EmbedBuilder): string {
  return createHash('sha1').update(JSON.stringify(embed.toJSON())).digest('hex');
}
