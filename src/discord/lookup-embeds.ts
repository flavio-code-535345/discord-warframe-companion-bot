import { EmbedBuilder } from 'discord.js';
import {
  FRAME_CATEGORIES,
  type LookupResult,
  type RelicInfo,
  WEAPON_CATEGORIES,
  type WfItem,
  itemImage,
  topDrops,
  wikiUrl,
} from '../warframe/items.js';
import type { DropLocation } from '../warframe/drops.js';
import type { WikiResult } from '../warframe/wiki.js';
import { COLORS, clampLines } from './embeds.js';

const POLARITY: Record<string, string> = {
  madurai: 'Madurai (V)', vazarin: 'Vazarin (D)', naramon: 'Naramon (—)', zenurik: 'Zenurik (=)',
  unairu: 'Unairu', penjaga: 'Penjaga', umbra: 'Umbra', aura: 'Aura', any: 'Any',
};
const pol = (p: unknown) => (typeof p === 'string' ? (POLARITY[p] ?? p) : '—');
const pct = (x: unknown) => (typeof x === 'number' ? `${Math.round(x * 1000) / 10}%` : '—');
const num = (x: unknown, digits = 2) => (typeof x === 'number' ? String(Math.round(x * 10 ** digits) / 10 ** digits) : '—');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Riven disposition as the in-game 1-5 pips. */
const dots = (d: unknown) => (typeof d === 'number' && d > 0 ? '●'.repeat(d) + '○'.repeat(Math.max(5 - d, 0)) : '—');
/** Discord field values must be non-empty and at most 1024 characters. */
const field = (s: string | undefined | null) => (s && s.trim() ? s.slice(0, 1024) : '—');

function baseEmbed(item: WfItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(item.name)
    .setURL(wikiUrl(item))
    .setDescription(item.description ? item.description.slice(0, 600) : null)
    .setThumbnail(itemImage(item.imageName));
  const tags = [item.type ?? item.category, typeof item.masteryReq === 'number' && item.masteryReq > 0 ? `MR ${item.masteryReq}` : null, item.vaulted ? '🔒 Vaulted' : null, item.tradable ? '💰 Tradable' : null];
  return embed.setFooter({ text: `${tags.filter(Boolean).join(' · ')} · data: warframestat.us` });
}

function frameEmbed(item: WfItem): EmbedBuilder {
  const abilities = (item.abilities ?? []) as { name: string; description?: string }[];
  const embed = baseEmbed(item).addFields(
    { name: 'Health', value: num(item.health, 0), inline: true },
    { name: 'Shield', value: num(item.shield, 0), inline: true },
    { name: 'Armor', value: num(item.armor, 0), inline: true },
    { name: 'Energy', value: num(item.power, 0), inline: true },
    { name: 'Sprint', value: num(item.sprintSpeed), inline: true },
    { name: 'Aura', value: pol(item.aura), inline: true },
  );
  const polarities = (item.polarities ?? []) as string[];
  if (polarities.length) embed.addFields({ name: 'Polarities', value: polarities.map(pol).join(', ') });
  if (item.passiveDescription) embed.addFields({ name: 'Passive', value: field(String(item.passiveDescription)) });
  if (abilities.length) {
    embed.addFields({
      name: 'Abilities',
      value: field(abilities.map((a, i) => `**${i + 1}. ${a.name}**${a.description ? ` — ${a.description.split('\n')[0]!.slice(0, 140)}` : ''}`).join('\n')),
    });
  }
  return embed;
}

function weaponEmbed(item: WfItem): EmbedBuilder {
  const damage = Object.entries((item.damage ?? {}) as Record<string, number>)
    .filter(([k, v]) => v > 0 && k !== 'total')
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${cap(k)} ${num(v, 1)}`);
  const embed = baseEmbed(item).addFields(
    { name: 'Total damage', value: num(item.totalDamage, 1), inline: true },
    { name: 'Critical', value: `${pct(item.criticalChance)} · ${num(item.criticalMultiplier, 1)}x`, inline: true },
    { name: 'Status', value: pct(item.procChance), inline: true },
    { name: 'Fire rate', value: num(item.fireRate), inline: true },
    { name: 'Riven disposition', value: dots(item.disposition), inline: true },
    { name: 'Trigger', value: field(item.trigger as string | undefined), inline: true },
  );
  if (typeof item.magazineSize === 'number') {
    embed.addFields({ name: 'Magazine · reload', value: `${item.magazineSize} · ${num(item.reloadTime)}s`, inline: true });
  }
  if (damage.length) embed.addFields({ name: 'Damage', value: field(damage.join(' · ')) });
  const attacks = (item.attacks ?? []) as { name: string }[];
  if (attacks.length > 1) embed.addFields({ name: 'Attacks', value: field(attacks.map((a) => a.name).join(', ')) });
  return embed;
}

function modEmbed(item: WfItem, drops?: DropLocation[]): EmbedBuilder {
  const levels = (item.levelStats ?? []) as { stats: string[] }[];
  const embed = baseEmbed(item);
  const facts = [
    item.compatName ? `**For:** ${item.compatName}` : null,
    item.rarity ? `**Rarity:** ${item.rarity}` : null,
    item.polarity ? `**Polarity:** ${pol(item.polarity)}` : null,
    typeof item.baseDrain === 'number' ? `**Drain:** ${item.baseDrain}` : null,
    typeof item.fusionLimit === 'number' ? `**Max rank:** ${item.fusionLimit}` : null,
  ].filter(Boolean);
  if (facts.length) embed.addFields({ name: 'Details', value: facts.join(' · ') });
  const max = levels.at(-1)?.stats;
  if (max?.length) embed.addFields({ name: `At max rank`, value: field(max.join('\n')) });
  return withDrops(embed, item, drops);
}

/** Drop sources: prefers the full drop-table search (`drops`), falling back to the item record's own list. */
function withDrops(embed: EmbedBuilder, item: WfItem, drops?: DropLocation[]): EmbedBuilder {
  const sources = drops?.length
    ? drops.slice(0, 6).map((d) => ({ location: d.place, chance: d.chance }))
    : topDrops(item, 6);
  if (sources.length) {
    embed.addFields({
      name: 'Best drop sources',
      value: field(sources.map((d) => `${d.location}${typeof d.chance === 'number' ? ` — **${d.chance}%**` : ''}`).join('\n')),
    });
  }
  return embed;
}

export function relicEmbed(relic: RelicInfo): EmbedBuilder {
  const icon: Record<string, string> = { Common: '🟤', Uncommon: '⚪', Rare: '🟡' };
  const lines = relic.rewards.map(
    (r) => `${icon[r.rarity] ?? '•'} ${r.item} — ${r.intact}%${r.radiant !== null ? ` → ${r.radiant}% radiant` : ''}`,
  );
  const locations = relic.locations.slice(0, 6).map((l) => `${l.location}${typeof l.chance === 'number' ? ` — ${l.chance}%` : ''}`);
  const embed = new EmbedBuilder()
    .setColor(COLORS.void)
    .setTitle(relic.name)
    .setURL(`https://wiki.warframe.com/w/${encodeURIComponent(relic.name.replace(/ /g, '_'))}`)
    .setThumbnail(itemImage(relic.imageName))
    .setDescription(clampLines(lines, 2000))
    .addFields({
      name: 'Where to get it',
      value: relic.vaulted
        ? '🔒 Vaulted: not in the drop tables. Trade for it or wait for a Prime Resurgence (`/wf resurgence`).'
        : locations.length
          ? field(locations.join('\n'))
          : `Drops from regular missions; try \`/drops ${relic.name}\`.`,
    });
  if (relic.marketSlug) embed.addFields({ name: 'Market', value: `[warframe.market](https://warframe.market/items/${relic.marketSlug}) · \`/price ${relic.name}\`` });
  return embed.setFooter({ text: 'Chances: intact → radiant · data: warframestat.us' });
}

/** True when the item's embed shows drop sources, so callers know to fetch the full drop table. */
export function showsDrops(result: LookupResult): boolean {
  return result.kind === 'item' && !FRAME_CATEGORIES.has(result.item.category) && !WEAPON_CATEGORIES.has(result.item.category);
}

export function lookupEmbed(result: LookupResult, drops?: DropLocation[]): EmbedBuilder {
  if (result.kind === 'relic') return relicEmbed(result.relic);
  const item = result.item;
  if (FRAME_CATEGORIES.has(item.category)) return frameEmbed(item);
  if (WEAPON_CATEGORIES.has(item.category)) return weaponEmbed(item);
  if (item.category === 'Mods' || item.category === 'Arcanes') return modEmbed(item, drops);
  return withDrops(baseEmbed(item), item, drops);
}

export function wikiEmbed(query: string, results: WikiResult[]): EmbedBuilder {
  const [top, ...rest] = results;
  if (!top) return new EmbedBuilder().setColor(COLORS.warn).setTitle('Wiki').setDescription(`Nothing on the wiki matches "${query}".`);
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(top.title)
    .setURL(top.url)
    .setDescription(top.extract.length > 1500 ? `${top.extract.slice(0, 1500)}…` : top.extract)
    .setFooter({ text: 'wiki.warframe.com' });
  if (rest.length) embed.addFields({ name: 'Also see', value: rest.map((r) => `[${r.title}](${r.url})`).join(' · ') });
  return embed;
}
