import { EmbedBuilder } from 'discord.js';
import { own } from '../own.js';
import { type FoundRivens, type RivenFilter, describeFilter } from '../rivens/find.js';
import type { Letter } from '../rivens/grade.js';
import { MIN_LISTINGS } from '../rivens/grade.js';
import { auctionUrl } from '../rivens/market.js';
import type { ScanResult } from '../rivens/scan.js';
import type { GradeReport, RivenStatus, TopReport } from '../rivens/service.js';
import { formatStatValue } from '../rivens/stats.js';
import type { RivenListing, SellerStatus } from '../rivens/types.js';
import { type EmojiName, e } from './emoji.js';
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
  // A stat that was worked out from a smudged line (not read) carries a "?".
  const mark = (slug: string) => (rd.guessed.includes(name(slug)) ? '?' : '');
  const stats = [...rd.positives.map((p) => `+${name(p.slug)}${val(p.value)}${mark(p.slug)}`), ...(rd.negative ? [`−${name(rd.negative.slug)}${val(rd.negative.value)}${mark(rd.negative.slug)}`] : [])].join(' · ');
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

/** Where the seller is: in the game (can trade at once), on the website, or away. */
const SELLER_DOT: Record<SellerStatus, string> = { ingame: '🟢', online: '🟡', offline: '⚫' };
export const SELLER_KEY = '🟢 in game · 🟡 online · ⚫ offline';
const POLARITY: Record<string, EmojiName> = { madurai: 'madurai', vazarin: 'vazarin', naramon: 'naramon' };

/**
 * One riven for sale in two lines: the seller's status, the price (a link to the listing, where the seller's name and a ready whisper
 * are), mastery, re-rolls, polarity and the riven's name; then its stats as the game writes them, the curse last. `units` is how the
 * market writes each stat (attribute slug → percent, multiply, seconds).
 */
export function listingLines(l: RivenListing, names: Record<string, string>, units: Record<string, string> = {}): string {
  const name = (slug: string) => names[slug] ?? slug.replace(/_/g, ' ');
  const polarity = own(POLARITY, l.polarity);
  const head = [
    `${l.seller ? SELLER_DOT[l.seller] : '⚪'} **[${plat(l.price)}](${auctionUrl(l.id)})**`,
    l.mastery !== undefined ? `MR ${l.mastery}` : null,
    l.rerolls === 0 ? 'unrolled' : `${l.rerolls} re-roll${l.rerolls === 1 ? '' : 's'}`,
    polarity ? e(polarity) : null,
    l.name ? `*${l.name.charAt(0).toUpperCase()}${l.name.slice(1)}*` : null,
    l.platform ? l.platform.toUpperCase() : null,
  ].filter(Boolean);
  const stat = (s: RivenListing['stats'][number]) => `${s.positive ? '' : '🔻 '}${formatStatValue(s.slug, s.value, own(units, s.slug))} ${name(s.slug)}`.trim();
  const stats = [...l.stats.filter((s) => s.positive), ...l.stats.filter((s) => !s.positive)].map(stat).join(' · ');
  return `${head.join(' · ')}\n${stats}`;
}

/** Shown per answer; ten keep the embed short and are what someone shopping looks at. */
export const FIND_SHOWN = 10;

/** /riven find: the cheapest rivens for sale that match, cheapest first. */
export function rivenFindEmbed(filter: RivenFilter, found: FoundRivens, names: Record<string, string>, units: Record<string, string>, opts: { inGame?: boolean } = {}): EmbedBuilder {
  const list = opts.inGame ? found.listings.filter((l) => l.seller === 'ingame') : found.listings;
  const what = `${e('riven')} ${describeFilter(filter, names)}${opts.inGame ? ', seller in game now' : ''}`;
  const embed = new EmbedBuilder().setColor(list.length ? COLORS.brand : COLORS.muted).setTitle(`🎲 ${filter.weapon.name} rivens for sale`);
  if (!list.length) {
    return embed
      .setDescription(`${what}\n\nNobody is selling one like that right now. \`/riven watch\` sends you a DM as soon as one is listed.`)
      .setFooter({ text: `${FOOTER} · fixed prices only` });
  }
  const count = found.complete ? `**${list.length}** for sale` : `**${list.length}+** for sale (warframe.market sends the cheapest 100)`;
  const shown = list.slice(0, FIND_SHOWN).map((l) => listingLines(l, names, units));
  const more = list.length > FIND_SHOWN ? `\n\n-# …and ${list.length - FIND_SHOWN} more, on warframe.market` : '';
  return embed
    .setDescription(`${what}\n${count}, cheapest first\n-# ${SELLER_KEY}\n\n${shown.join('\n\n')}${more}`.slice(0, 4096))
    .setFooter({ text: `${FOOTER} · fixed prices only` });
}
