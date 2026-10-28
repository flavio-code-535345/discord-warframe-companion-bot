import { EmbedBuilder } from 'discord.js';
import { COLORS, type IconName, footer, heading } from './style.js';
import type { DropGroup } from '../warframe/drops.js';
import { projectCycles } from '../warframe/cycles.js';
import type { PriceCheck } from '../warframe/market.js';
import {
  FISSURE_TIERS,
  type Fissure,
  type WorldState,
  archimedeaName,
  isBaroHere,
  resurgenceItemName,
  bountyStanding,
  rewardText,
  worldStateStaleNote,
} from '../warframe/worldstate.js';
import { discordTime, toMs } from '../time.js';

export { COLORS };

/** A new embed: colour, icon + title, and the standard footer (where the data came from is added by the caller when it matters). */
const base = (color: number, icon: IconName, title: string): EmbedBuilder => new EmbedBuilder().setColor(color).setTitle(heading(icon, title)).setFooter(footer());

const DESCRIPTION_LIMIT = 4000;

/** Joins lines and cuts at a line boundary so embeds stay under Discord's description limit. */
export function clampLines(lines: string[], limit = DESCRIPTION_LIMIT): string {
  let out = '';
  for (const [i, line] of lines.entries()) {
    const more = `\n…and ${lines.length - i} more`;
    if (out.length + line.length + 1 + more.length > limit) return out + more;
    out += (out ? '\n' : '') + line;
  }
  return out || '—';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function cyclesEmbed(ws: WorldState, now = Date.now()): EmbedBuilder {
  // Cetus, Vallis, Earth and Cambion follow fixed schedules: if the cached feed is older than a phase, roll it forward locally.
  const p = projectCycles(ws, now);
  const c = { isDay: p.cetus.isDay, expiry: p.cetus.expiry };
  const v = { isWarm: p.vallis.isWarm, expiry: p.vallis.expiry };
  const cam = { state: p.cambion.state, expiry: p.cambion.expiry };
  const z = p.zariman;
  const d = ws.duviriCycle;
  const e = { isDay: p.earth.isDay, expiry: p.earth.expiry };
  const embed = base(COLORS.info, 'cycles', 'Open world cycles').addFields(
      { name: 'Cetus', value: `${c.isDay ? '☀️ Day' : '🌙 Night'}\nends ${discordTime(c.expiry)}`, inline: true },
      { name: 'Orb Vallis', value: `${v.isWarm ? '🔥 Warm' : '❄️ Cold'}\nends ${discordTime(v.expiry)}`, inline: true },
      { name: 'Cambion Drift', value: `${cap(cam.state)}\nends ${discordTime(cam.expiry)}`, inline: true },
      { name: 'Zariman', value: `${cap(z.state)} control\nends ${discordTime(z.expiry)}`, inline: true },
      { name: 'Earth', value: `${e.isDay ? '☀️ Day' : '🌙 Night'}\nends ${discordTime(e.expiry)}`, inline: true },
      { name: 'Duviri', value: `${cap(d.state)}\nends ${discordTime(d.expiry)}`, inline: true },
  );
  const stale = worldStateStaleNote(now);
  if (stale) embed.setFooter(footer(stale));
  const normal = d.choices?.find((x) => x.category === 'normal')?.choices ?? [];
  const hard = d.choices?.find((x) => x.category === 'hard')?.choices ?? [];
  if (normal.length || hard.length) {
    embed.addFields({
      name: 'Duviri Circuit',
      value: [normal.length ? `**Normal:** ${normal.join(', ')}` : '', hard.length ? `**Steel Path:** ${hard.join(', ')}` : '']
        .filter(Boolean)
        .join('\n'),
    });
  }
  return embed;
}

/** Fissures grouped by relic tier (Lith first), soonest to end on top, so the list reads like the in-game one. */
export function fissuresEmbed(fissures: Fissure[], title = 'Void fissures'): EmbedBuilder {
  const embed = base(COLORS.void, 'fissures', `${title} (${fissures.length})`);
  const stale = worldStateStaleNote();
  if (stale) embed.setFooter(footer(stale));
  if (!fissures.length) return embed.setDescription('No fissures match those filters right now.');
  const known: string[] = [...FISSURE_TIERS];
  const tiers = [...known, ...new Set(fissures.map((f) => f.tier).filter((t) => !known.includes(t)))];
  for (const tier of tiers) {
    const list = fissures.filter((f) => f.tier === tier).sort((a, b) => toMs(a.expiry) - toMs(b.expiry));
    if (!list.length) continue;
    const lines = list.map(
      (f) => `**${f.missionType}** · ${f.node}${f.enemy ? ` · ${f.enemy}` : ''}${f.isHard ? ' · 🔱 Steel Path' : ''}${f.isStorm ? ' · 🌀 Storm' : ''} · ends ${discordTime(f.expiry)}`,
    );
    // Six tiers at most 900 characters each stay well under the 6000 an embed may hold.
    embed.addFields({ name: `${tier} (${list.length})`, value: clampLines(lines, 900) });
  }
  return embed;
}

export function sortieEmbed(ws: WorldState): EmbedBuilder {
  const s = ws.sortie;
  if (!s) return base(COLORS.warn, 'sortie', 'Sortie').setDescription('No sortie data right now.');
  const embed = base(COLORS.brand, 'sortie', `Daily sortie${s.boss ? ` — ${s.boss}` : ''}`).setDescription(`${s.faction ? `**${s.faction}** · ` : ''}resets ${discordTime(s.expiry)}`);
  s.variants.forEach((v, i) =>
    embed.addFields({ name: `${i + 1}. ${v.missionType} — ${v.node}`, value: `${v.modifier}\n-# ${v.modifierDescription ?? ''}` }),
  );
  return embed;
}

export function archonEmbed(ws: WorldState): EmbedBuilder {
  const a = ws.archonHunt;
  if (!a) return base(COLORS.warn, 'archon', 'Archon Hunt').setDescription('No Archon Hunt data right now.');
  return base(COLORS.danger, 'archon', `Archon Hunt${a.boss ? ` — ${a.boss}` : ''}`)
    .setDescription(
      [
        ...a.missions.map((m, i) => `**${i + 1}.** ${m.type} — ${m.node}`),
        '',
        `Resets ${discordTime(a.expiry)}`,
      ].join('\n'),
    );
}

export function baroEmbed(ws: WorldState): EmbedBuilder {
  const t = ws.voidTrader;
  const embed = base(COLORS.void, 'baro', "Baro Ki'Teer");
  if (!t) return embed.setDescription('No Void Trader data right now.');
  if (!isBaroHere(ws)) {
    return embed.setDescription(`Arrives at **${t.location}** ${discordTime(t.activation)} (${discordTime(t.activation, 'f')}).`);
  }
  const lines = (t.inventory ?? []).map(
    (i) => `• ${i.item} — **${i.ducats}** ducats · ${Number(i.credits).toLocaleString('en-US')} cr`,
  );
  return embed.setDescription(`At **${t.location}**, leaves ${discordTime(t.expiry)}.\n\n${clampLines(lines, 3800)}`);
}

export function steelPathEmbed(ws: WorldState): EmbedBuilder {
  const sp = ws.steelPath;
  if (!sp) return base(COLORS.warn, 'steelPath', 'Steel Path').setDescription('No Steel Path data right now.');
  const rotation = sp.rotation ?? [];
  const idx = rotation.findIndex((r) => r.name === sp.currentReward?.name);
  const next = idx >= 0 ? rotation[(idx + 1) % rotation.length] : undefined;
  return base(COLORS.danger, 'steelPath', "Teshin's Steel Path honors")
    .addFields(
      { name: 'This week', value: sp.currentReward ? `${sp.currentReward.name} — ${sp.currentReward.cost} Steel Essence` : '—' },
      { name: 'Next week', value: next ? `${next.name} — ${next.cost} Steel Essence` : '—' },
      { name: 'Rotates', value: discordTime(sp.expiry) },
    );
}

export function invasionsEmbed(ws: WorldState): EmbedBuilder {
  const active = ws.invasions.filter((i) => !i.completed);
  const lines = active.map((i) => {
    const attacker = i.vsInfestation ? '' : `${i.attacker.faction}: ${rewardText(i.attacker.reward)} vs `;
    return `**${i.node}** · ${i.desc}\n${attacker}${i.defender.faction}: ${rewardText(i.defender.reward)} · ${Math.round(i.completion)}%`;
  });
  return base(COLORS.warn, 'invasions', `Invasions (${active.length})`).setDescription(active.length ? clampLines(lines) : 'No active invasions.');
}

export function nightwaveEmbed(ws: WorldState): EmbedBuilder {
  const nw = ws.nightwave;
  if (!nw) return base(COLORS.warn, 'nightwave', 'Nightwave').setDescription('Nightwave is not running right now.');
  const lines = nw.activeChallenges
    .slice()
    .sort((a, b) => Number(b.isDaily) - Number(a.isDaily) || Number(a.isElite) - Number(b.isElite))
    .map(
      (c) =>
        `${c.isDaily ? '📅 Daily' : c.isElite ? '⭐ Elite' : '🗓️ Weekly'} · **${c.title}** (${c.reputation.toLocaleString('en-US')}) — ${c.desc}`,
    );
  return base(COLORS.danger, 'nightwave', `Nightwave — season ${nw.season}`)
    .setDescription(clampLines(lines, 3900))
    .addFields({ name: 'Season ends', value: `${discordTime(nw.expiry, 'D')} (${discordTime(nw.expiry)})` });
}

export function priceEmbed(p: PriceCheck): EmbedBuilder {
  const fmt = (orders: PriceCheck['sell']) =>
    orders.length
      ? orders
          .map((o) => `**${o.platinum}p** · ${o.user.ingameName}${o.rank !== undefined ? ` (R${o.rank})` : ''}${o.quantity > 1 ? ` ×${o.quantity}` : ''}`)
          .join('\n')
      : 'No online orders';
  const embed = base(COLORS.info, 'price', p.item.name)
    .setURL(p.url)
    .addFields({ name: 'Cheapest sellers', value: fmt(p.sell), inline: true }, { name: 'Top buyers', value: fmt(p.buy), inline: true })
    .setFooter(
      footer(
        p.staleMs !== undefined ? `warframe.market · cached ${Math.max(1, Math.round(p.staleMs / 60_000))} min ago, may be outdated (warframe.market is not answering)` : 'warframe.market · online and in-game traders only',
      ),
    );
  const first = p.sell[0];
  if (first) {
    embed.setDescription(
      `Whisper: \`/w ${first.user.ingameName} Hi! I want to buy: "${p.item.name}" for ${first.platinum} platinum. (warframe.market)\``,
    );
  }
  return embed;
}

export function dropsEmbed(query: string, groups: DropGroup[]): EmbedBuilder {
  const embed = base(COLORS.success, 'drops', `Drop locations: ${query}`);
  if (!groups.length) return embed.setDescription('Nothing in the drop tables matches that name.');
  for (const g of groups) {
    embed.addFields({
      name: g.item,
      value: clampLines(
        g.locations.map((l) => `${l.place} — ${l.rarity} · **${l.chance}%**`),
        1000,
      ),
    });
  }
  return embed.setFooter(footer('Drop tables via warframestat.us'));
}

export const BOUNTY_SYNDICATES = ['Ostrons', 'Solaris United', 'Entrati', 'The Holdfasts', 'Cavia', 'The Hex'] as const;

export function dealsEmbed(ws: WorldState): EmbedBuilder {
  const embed = base(COLORS.info, 'deal', "Darvo's deal");
  const deal = ws.dailyDeals?.[0];
  if (!deal) return embed.setDescription('No deal right now.');
  const left = deal.total - deal.sold;
  return embed.setDescription(
    `**${deal.item}**\n~~${deal.originalPrice}p~~ → **${deal.salePrice} platinum** (-${deal.discount}%)\n` +
      `${left > 0 ? `${left} of ${deal.total} left` : '**Sold out**'} · ends ${discordTime(deal.expiry)}`,
  );
}

export function eventsEmbed(ws: WorldState): EmbedBuilder {
  const events = (ws.events ?? []).filter((e) => toMs(e.expiry) > Date.now());
  const embed = base(COLORS.warn, 'events', `Events (${events.length})`);
  if (!events.length) return embed.setDescription('No in-game events are running.');
  for (const e of events.slice(0, 10)) {
    const progress =
      e.maximumScore > 1 ? `Progress ${Math.round((e.currentScore / e.maximumScore) * 100)}% · ` : typeof e.health === 'number' ? `${Math.round(e.health)}% · ` : '';
    const rewards = (e.rewards ?? []).map(rewardText).filter((r) => r !== '—');
    embed.addFields({
      name: e.description.slice(0, 256),
      value: `${e.node ? `${e.node} · ` : ''}${progress}ends ${discordTime(e.expiry)}${rewards.length ? `\n**Rewards:** ${rewards.join(', ').slice(0, 800)}` : ''}`,
    });
  }
  return embed;
}

export function archimedeaEmbed(ws: WorldState): EmbedBuilder {
  const list = ws.archimedeas ?? [];
  const embed = base(COLORS.danger, 'archimedea', 'Archimedea');
  if (!list.length) return embed.setDescription('No Archimedea data right now.');
  for (const a of list) {
    const expiry = (a as unknown as { expiry?: Date }).expiry;
    const missions = a.missions.map((m, i) => {
      const risks = (m.risks ?? []).map((r) => `${r.isHard ? '⚠️ ' : ''}${r.name}`).join(', ');
      return `**${i + 1}. ${m.missionType}** (${m.faction})${m.deviation?.name ? ` · deviation: ${m.deviation.name}` : ''}${risks ? `\n-# risks: ${risks}` : ''}`;
    });
    const personal = (a.personalModifiers ?? []).map((p) => p.name).join(', ');
    embed.addFields({
      name: `${archimedeaName(a.type)}${expiry ? ` · resets ${new Date(expiry).toUTCString().slice(0, 16)}` : ''}`,
      value: `${missions.join('\n')}${personal ? `\n**Personal modifiers:** ${personal}` : ''}`.slice(0, 1024),
    });
  }
  return embed;
}

export function bountiesEmbed(ws: WorldState, syndicate: string): EmbedBuilder {
  const mission = (ws.syndicateMissions ?? []).find((m) => m.syndicate.toLowerCase() === syndicate.toLowerCase());
  const jobs = mission?.jobs ?? [];
  const embed = base(COLORS.success, 'bounties', `${syndicate} bounties`);
  if (!jobs.length) return embed.setDescription(`No ${syndicate} bounties are listed right now.`);
  embed.setDescription(`Rotate ${discordTime(mission!.expiry)}`);
  for (const j of jobs.slice(0, 10)) {
    const standing = bountyStanding(j.standingStages);
    const levels = j.enemyLevels?.length ? `Lv ${j.enemyLevels[0]}-${j.enemyLevels.at(-1)}` : '';
    const rewards = [...new Set(j.rewardPool ?? [])].slice(0, 6).join(', ');
    embed.addFields({
      name: `${j.type ?? 'Bounty'}${j.isVault ? ' (Vault)' : ''}`.slice(0, 256),
      value: `${[levels, standing ? `${standing.toLocaleString('en-US')} standing` : '', j.minMR ? `MR ${j.minMR}+` : ''].filter(Boolean).join(' · ') || '—'}${rewards ? `\n-# ${rewards}` : ''}`.slice(0, 1024),
    });
  }
  return embed;
}

export function resurgenceEmbed(ws: WorldState): EmbedBuilder {
  const t = ws.vaultTrader;
  const embed = base(COLORS.void, 'resurgence', 'Prime Resurgence (Varzia)');
  if (!t?.inventory?.length) return embed.setDescription('No Prime Resurgence stock right now.');
  const lines = t.inventory.map((i) => `• ${resurgenceItemName(i.item)}${i.ducats ? ` — **${i.ducats}** Aya` : ''}${i.credits ? ` · ${Number(i.credits).toLocaleString('en-US')} cr` : ''}`);
  return embed.setDescription(`Rotates ${discordTime(t.expiry)}\n\n${clampLines(lines, 3800)}`);
}
