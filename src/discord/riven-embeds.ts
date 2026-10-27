import { EmbedBuilder } from 'discord.js';
import type { Letter } from '../rivens/grade.js';
import { MIN_LISTINGS } from '../rivens/grade.js';
import type { GradeReport, RivenStatus, TopReport } from '../rivens/service.js';
import { COLORS } from './embeds.js';

const LETTER_COLOR: Record<Letter, number> = { S: 0xf1c40f, A: 0x2ecc71, B: 0x3498db, C: 0xe67e22, D: 0xe74c3c };
const LETTER_TEXT: Record<Letter, string> = {
  S: 'the combination the expensive rivens have',
  A: 'stats the expensive rivens use',
  B: 'a decent mix',
  C: 'mostly stats the expensive rivens skip',
  D: 'none of the stats the expensive rivens use',
};

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const plat = (n: number): string => `${n.toLocaleString('en-US')}p`;
const ago = (at: number | null): string => {
  if (at === null) return 'unknown';
  const m = Math.max(1, Math.round((Date.now() - at) / 60_000));
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

function bracketNote(b: { high: number; total: number; threshold: number; adaptive: boolean }, minPrice: number): string {
  return b.adaptive
    ? `Compared with the ${b.high} priciest of ${b.total} listings (${plat(b.threshold)} and up; too few reach ${plat(minPrice)})`
    : `Compared with the ${b.high} listings at ${plat(minPrice)} or more, out of ${b.total}`;
}

const FOOTER = 'Asking prices on warframe.market, not sales';

export function rivenGradeEmbed(r: GradeReport): EmbedBuilder {
  const name = (slug: string) => r.names[slug] ?? slug;
  const embed = new EmbedBuilder().setTitle(`🎲 Riven: ${r.weapon.name}`);
  if (!r.grade) {
    return embed
      .setColor(COLORS.brand)
      .setDescription(`I can't grade this one: warframe.market lists only **${r.listings}** rivens for ${r.weapon.name} (I need at least ${MIN_LISTINGS} to compare with). Try \`/riven top\` on a more popular weapon.`)
      .setFooter({ text: `${FOOTER} · read ${ago(r.fetchedAt)}` });
  }
  const g = r.grade;
  const lines = g.stats.map((s) => {
    const how = s.rank === null ? 'not in any of the expensive ones' : `in ${pct(s.share)} of the expensive ones (#${s.rank} most common)`;
    const value = s.percentile === null ? '' : ` · your roll beats ${pct(s.percentile)} of listed rolls`;
    return `**${name(s.slug)}**: ${how}${value}`;
  });
  if (g.negative) {
    lines.push(
      g.negative.share > 0
        ? `Curse **${name(g.negative.slug)}**: on ${pct(g.negative.share)} of the expensive ones${g.negative.rank ? ` (#${g.negative.rank})` : ''}`
        : `Curse **${name(g.negative.slug)}**: none of the expensive ones have it`,
    );
  }
  embed
    .setColor(LETTER_COLOR[g.letter])
    .setDescription(`## Grade ${g.letter}: ${LETTER_TEXT[g.letter]}\n${lines.join('\n')}`)
    .addFields({
      name: 'Expensive rivens with exactly these bonuses',
      value: g.exact ? `${g.exact} of ${g.bracket.high}` : `none of the ${g.bracket.high}`,
      inline: true,
    });
  if (g.comparable) {
    const c = g.comparable;
    embed.addFields({
      name: `Listed with these bonuses${c.sameNegative ? ' and this curse' : ''}`,
      value: c.count === 1 ? `1 listing at ${plat(c.min)}` : `${c.count} listings, ${plat(c.min)} to ${plat(c.max)}, median **${plat(c.median)}**${c.count < 3 ? ' (very few: take with a grain of salt)' : ''}`,
      inline: true,
    });
  } else {
    embed.addFields({ name: 'Listed with these bonuses', value: 'nobody is selling this combination right now', inline: true });
  }
  return embed.setFooter({ text: `${bracketNote(g.bracket, r.minPrice)} · ${FOOTER} · read ${ago(r.fetchedAt)}${r.stale ? ' (warframe.market could not be reached, so this is older)' : ''}` });
}

export function rivenTopEmbed(r: TopReport): EmbedBuilder {
  const name = (slug: string) => r.names[slug] ?? slug;
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle(`🎲 What sells: ${r.weapon.name}`);
  if (!r.top) {
    return embed
      .setDescription(`Not enough data: warframe.market lists only **${r.listings}** rivens for ${r.weapon.name} (I need at least ${MIN_LISTINGS}).`)
      .setFooter({ text: `${FOOTER} · read ${ago(r.fetchedAt)}` });
  }
  const t = r.top;
  embed.setDescription(bracketNote(t.bracket, r.minPrice));
  embed.addFields({ name: 'Bonus stats the expensive rivens have', value: t.stats.map((s) => `${pct(s.share)} ${name(s.slug)}`).join('\n') || '-', inline: true });
  if (t.negatives.length) embed.addFields({ name: 'Their curses', value: t.negatives.map((s) => `${pct(s.share)} ${name(s.slug)}`).join('\n'), inline: true });
  embed.addFields({
    name: 'Most common combinations',
    value: t.combos.map((c) => `${c.slugs.map(name).join(' + ')}: ${c.count}× (median ${plat(c.median)})`).join('\n').slice(0, 1000) || '-',
  });
  return embed.setFooter({ text: `${FOOTER} · read ${ago(r.fetchedAt)}${r.stale ? ' (older: warframe.market could not be reached)' : ''}` });
}

export function rivenStatusEmbed(s: RivenStatus): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🎲 Riven analyzer')
    .addFields(
      { name: 'Slow background read', value: s.enabled ? `on: one weapon every ${s.intervalSeconds} s, each again after ${s.refreshDays} days${s.pausedMs > 0 ? `\n⏸️ paused for about ${Math.ceil(s.pausedMs / 60_000)} min (warframe.market asked us to back off)` : ''}` : 'off (listings are read only when someone asks)' },
      { name: 'Weapons read', value: `${s.weaponsRead}${s.weaponsKnown ? ` of ${s.weaponsKnown}` : ''} · ${s.listings.toLocaleString('en-US')} listings stored`, inline: true },
      { name: 'Last read', value: ago(s.lastReadAt), inline: true },
      { name: 'High-value line', value: plat(s.highPrice), inline: true },
    );
  if (s.failing.length) embed.addFields({ name: 'Recent problems', value: s.failing.map((f) => `${f.weapon}: ${f.error}`).join('\n').slice(0, 1000) });
  return embed;
}
