import { EmbedBuilder } from 'discord.js';
import type { Letter } from '../rivens/grade.js';
import { MIN_LISTINGS } from '../rivens/grade.js';
import type { ScanResult } from '../rivens/scan.js';
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
    ? `Compared with the ${b.high} of the weapon's ${b.total} priciest listings from ${plat(b.threshold)} up (too few reach ${plat(minPrice)})`
    : `Compared with the ${b.high} listings at ${plat(minPrice)} or more among the weapon's ${b.total} priciest`;
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
    const value = s.percentile === null ? '' : ` · your roll beats ${pct(s.percentile)} of the rolls on the priciest listings`;
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
    const what = `${c.sameNegative ? ' and this curse' : ''}`;
    if (c.source === 'top') {
      embed.addFields({
        name: `Priciest listings with these bonuses${what}`,
        value: `${c.count} found, ${plat(c.min)} to ${plat(c.max)}. I could not ask warframe.market for the cheaper ones, so cheaper rivens like this may exist.`,
        inline: true,
      });
    } else if (c.complete) {
      embed.addFields({
        name: `For sale with these bonuses${what}`,
        value: c.count === 1 ? `1 listing at **${plat(c.min)}**` : `${c.count} listings, ${plat(c.min)} to ${plat(c.max)}, median **${plat(c.median)}**${c.count < 3 ? ' (very few: take with a grain of salt)' : ''}`,
        inline: true,
      });
    } else {
      embed.addFields({
        name: `For sale with these bonuses${what}`,
        value: `${c.count}+ listings. Cheapest **${plat(c.min)}**${c.tenth !== null ? `, 10th cheapest ${plat(c.tenth)}` : ''}`,
        inline: true,
      });
    }
  } else {
    embed.addFields({
      name: 'For sale with these bonuses',
      value: g.marketChecked ? 'nobody is selling this combination right now' : "none among the weapon's priciest listings (I could not check the rest)",
      inline: true,
    });
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

/** What OCR read from a screenshot, shown above the grade so the person can check it. */
export function rivenReadEmbed(r: ScanResult): EmbedBuilder {
  const name = (slug: string) => r.names[slug] ?? slug;
  const rd = r.reading;
  const val = (v: number | null | undefined) => (v === null || v === undefined ? '' : ` ${v}`);
  const lines = [
    `**Weapon:** ${rd.weapon?.name ?? '*not found*'}`,
    ...rd.positives.map((p) => `+ ${name(p.slug)}${val(p.value)}`),
    ...(rd.negative ? [`− ${name(rd.negative.slug)}${val(rd.negative.value)} (curse)`] : []),
  ];
  const embed = new EmbedBuilder().setColor(r.problem ? 0xe74c3c : COLORS.brand).setTitle('📷 What I read').setDescription(lines.join('\n'));
  const notes: string[] = [];
  if (r.problem) notes.push(r.problem);
  if (rd.unsureSign.length) notes.push(`I couldn't see the + or − in front of ${rd.unsureSign.join(', ')}, so I guessed. If one is really the curse, use \`/riven grade\`.`);
  if (rd.unknown.length) notes.push(`I couldn't match: ${rd.unknown.map((u) => `"${u}"`).join(', ')}`);
  if (notes.length) embed.addFields({ name: 'Heads up', value: notes.join('\n').slice(0, 1000) });
  return embed.setFooter({ text: `Read by OCR in ${(r.ms / 1000).toFixed(1)} s. Something wrong? Type it with /riven grade.` });
}

/**
 * The short answer for a scanned riven: the weapon, the letter, the stats as read and what it sells for. No explanations; a failed
 * read is one line. Used by the riven channel and /riven scan (/riven grade keeps the detailed card).
 */
export function rivenCompactEmbed(r: ScanResult): EmbedBuilder {
  const s = scanSummary(r);
  const embed = new EmbedBuilder();
  if (s.weapon) embed.setTitle(`🎲 ${s.weapon}`);
  if (s.error) return embed.setColor(0xe74c3c).setDescription(`❌ ${s.error}`);
  return embed.setColor(s.letter ? LETTER_COLOR[s.letter] : COLORS.brand).setDescription(s.letter ? `# ${s.letter}\n${s.stats}${s.price ? `\n💰 ${s.price}` : ''}` : `${s.stats}\nNot enough listings to grade.`);
}

export interface ScanSummary {
  weapon: string | null;
  /** "+Critical Chance 168.7 · +Multishot 90 · −Zoom 45" */
  stats: string;
  letter: Letter | null;
  /** What it sells for ("40p–200p, median 80p", "from 150p", "none for sale"), when known. */
  price: string | null;
  /** One short sentence when nothing could be graded because the picture was not readable. */
  error: string | null;
}

/** The short facts of a scan, for the compact embed and the admin page. */
export function scanSummary(r: ScanResult): ScanSummary {
  const name = (slug: string) => r.names[slug] ?? slug;
  const rd = r.reading;
  const val = (v: number | null | undefined) => (v === null || v === undefined ? '' : ` ${v}`);
  const stats = [...rd.positives.map((p) => `+${name(p.slug)}${val(p.value)}`), ...(rd.negative ? [`−${name(rd.negative.slug)}${val(rd.negative.value)}`] : [])].join(' · ');
  const out = (error: string | null, letter: Letter | null = null, price: string | null = null): ScanSummary => ({ weapon: rd.weapon?.name ?? null, stats, letter, price, error });
  if (!rd.weapon) return out("Couldn't find the weapon name. Crop the picture to the riven card.");
  if (rd.unknown.length) return out("Couldn't read every stat line (is the mouse over the card?). Try another screenshot.");
  if (rd.positives.length < 2) return out("Couldn't read the stats. Crop the picture to the riven card.");
  if (!r.report) return out("Couldn't grade this one.");
  const g = r.report.grade;
  if (!g) return out(null);
  const c = g.comparable;
  const price = c
    ? c.source === 'top' || !c.complete
      ? `from ${plat(c.min)}`
      : c.count === 1
        ? plat(c.min)
        : `${plat(c.min)}–${plat(c.max)}, median ${plat(c.median)}`
    : g.marketChecked
      ? 'none for sale'
      : null;
  return out(null, g.letter, price);
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
