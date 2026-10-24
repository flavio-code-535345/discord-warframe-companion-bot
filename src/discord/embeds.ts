import { EmbedBuilder } from 'discord.js';
import type { DropGroup } from '../warframe/drops.js';
import type { PriceCheck } from '../warframe/market.js';
import { type Fissure, type WorldState, isBaroHere, rewardText } from '../warframe/worldstate.js';
import { discordTime } from '../time.js';

export const COLORS = {
  /** Crystal blue sampled from the clan logo's glow. */
  brand: 0x3b9ac7,
  info: 0x3b82f6,
  success: 0x22c55e,
  warn: 0xf59e0b,
  danger: 0xef4444,
  void: 0xc9a227,
} as const;

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

export function cyclesEmbed(ws: WorldState): EmbedBuilder {
  const c = ws.cetusCycle;
  const v = ws.vallisCycle;
  const cam = ws.cambionCycle;
  const z = ws.zarimanCycle;
  const d = ws.duviriCycle;
  const e = ws.earthCycle;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Open world cycles')
    .addFields(
      { name: 'Cetus', value: `${c.isDay ? '☀️ Day' : '🌙 Night'}\nends ${discordTime(c.expiry)}`, inline: true },
      { name: 'Orb Vallis', value: `${v.isWarm ? '🔥 Warm' : '❄️ Cold'}\nends ${discordTime(v.expiry)}`, inline: true },
      { name: 'Cambion Drift', value: `${cap(cam.state)}\nends ${discordTime(cam.expiry)}`, inline: true },
      { name: 'Zariman', value: `${cap(z.state)} control\nends ${discordTime(z.expiry)}`, inline: true },
      { name: 'Earth', value: `${e.isDay ? '☀️ Day' : '🌙 Night'}\nends ${discordTime(e.expiry)}`, inline: true },
      { name: 'Duviri', value: `${cap(d.state)}\nends ${discordTime(d.expiry)}`, inline: true },
    );
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

export function fissuresEmbed(fissures: Fissure[], title = 'Void fissures'): EmbedBuilder {
  const lines = fissures.map(
    (f) =>
      `**${f.tier}** · ${f.missionType} — ${f.node} · ${f.enemy}${f.isHard ? ' · 🔱 SP' : ''}${f.isStorm ? ' · 🌀 Storm' : ''} · ends ${discordTime(f.expiry)}`,
  );
  return new EmbedBuilder()
    .setColor(COLORS.void)
    .setTitle(`${title} (${fissures.length})`)
    .setDescription(fissures.length ? clampLines(lines) : 'No fissures match those filters right now.');
}

export function sortieEmbed(ws: WorldState): EmbedBuilder {
  const s = ws.sortie;
  if (!s) return new EmbedBuilder().setColor(COLORS.warn).setTitle('Sortie').setDescription('No sortie data right now.');
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(`Daily sortie${s.boss ? ` — ${s.boss}` : ''}`)
    .setDescription(`${s.faction ? `**${s.faction}** · ` : ''}resets ${discordTime(s.expiry)}`);
  s.variants.forEach((v, i) =>
    embed.addFields({ name: `${i + 1}. ${v.missionType} — ${v.node}`, value: `${v.modifier}\n-# ${v.modifierDescription ?? ''}` }),
  );
  return embed;
}

export function archonEmbed(ws: WorldState): EmbedBuilder {
  const a = ws.archonHunt;
  if (!a) return new EmbedBuilder().setColor(COLORS.warn).setTitle('Archon Hunt').setDescription('No Archon Hunt data right now.');
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle(`Archon Hunt${a.boss ? ` — ${a.boss}` : ''}`)
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
  const embed = new EmbedBuilder().setColor(COLORS.void).setTitle("Baro Ki'Teer");
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
  if (!sp) return new EmbedBuilder().setColor(COLORS.warn).setTitle('Steel Path').setDescription('No Steel Path data right now.');
  const rotation = sp.rotation ?? [];
  const idx = rotation.findIndex((r) => r.name === sp.currentReward?.name);
  const next = idx >= 0 ? rotation[(idx + 1) % rotation.length] : undefined;
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle("Teshin's Steel Path honors")
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
  return new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(`Invasions (${active.length})`)
    .setDescription(active.length ? clampLines(lines) : 'No active invasions.');
}

export function nightwaveEmbed(ws: WorldState): EmbedBuilder {
  const nw = ws.nightwave;
  if (!nw) return new EmbedBuilder().setColor(COLORS.warn).setTitle('Nightwave').setDescription('Nightwave is not running right now.');
  const lines = nw.activeChallenges
    .slice()
    .sort((a, b) => Number(b.isDaily) - Number(a.isDaily) || Number(a.isElite) - Number(b.isElite))
    .map(
      (c) =>
        `${c.isDaily ? '📅 Daily' : c.isElite ? '⭐ Elite' : '🗓️ Weekly'} · **${c.title}** (${c.reputation.toLocaleString('en-US')}) — ${c.desc}`,
    );
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle(`Nightwave — season ${nw.season}`)
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
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(p.item.name)
    .setURL(p.url)
    .addFields({ name: 'Cheapest sellers', value: fmt(p.sell), inline: true }, { name: 'Top buyers', value: fmt(p.buy), inline: true })
    .setFooter({ text: 'warframe.market · online and in-game traders only' });
  const first = p.sell[0];
  if (first) {
    embed.setDescription(
      `Whisper: \`/w ${first.user.ingameName} Hi! I want to buy: "${p.item.name}" for ${first.platinum} platinum. (warframe.market)\``,
    );
  }
  return embed;
}

export function dropsEmbed(query: string, groups: DropGroup[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(COLORS.success).setTitle(`Drop locations: ${query}`);
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
  return embed.setFooter({ text: 'Drop tables via warframestat.us' });
}
