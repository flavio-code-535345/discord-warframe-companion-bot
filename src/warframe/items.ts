import { apiJson } from './fetch.js';

// Item database served by the community warframestat.us API (generated from DE's public export).
const BASE = 'https://api.warframestat.us';
const REFINEMENTS = ['Intact', 'Exceptional', 'Flawless', 'Radiant'] as const;
/** Cosmetic categories rank below gameplay items when a search is ambiguous. */
const COSMETIC = new Set(['Skins', 'Glyphs', 'Sigils', 'Misc', 'Fish']);

export const FRAME_CATEGORIES = new Set(['Warframes', 'Archwing', 'Necramechs']);
export const WEAPON_CATEGORIES = new Set(['Primary', 'Secondary', 'Melee', 'Arch-Gun', 'Arch-Melee']);

/** Loosely typed: the export has dozens of category-specific fields; renderers read them defensively. */
export interface WfItem {
  name: string;
  uniqueName: string;
  category: string;
  type?: string;
  description?: string;
  imageName?: string;
  wikiaUrl?: string;
  tradable?: boolean;
  vaulted?: boolean;
  masteryReq?: number;
  [key: string]: unknown;
}

export interface RelicReward {
  item: string;
  rarity: string;
  intact: number;
  radiant: number | null;
  marketSlug: string | null;
}

export interface RelicInfo {
  name: string;
  vaulted: boolean;
  rewards: RelicReward[];
  locations: { location: string; rarity?: string; chance?: number }[];
  marketSlug: string | null;
  imageName?: string;
}

export type LookupResult = { kind: 'relic'; relic: RelicInfo } | { kind: 'item'; item: WfItem };

async function search(query: string, fields?: string): Promise<WfItem[]> {
  const url = `${BASE}/items/search/${encodeURIComponent(query)}${fields ? `?only=${fields}` : ''}`;
  // Item stats rarely change: cached for the stable lifetime (memory + database), shared by every asker.
  const { data } = await apiJson<WfItem[]>(url, { kind: 'stable' });
  return data ?? [];
}

/** "Neo N16 Radiant" / "Neo N16 Relic" / "neo n16" → "Neo N16"; null when the name isn't a relic name. */
export function relicBaseName(name: string): string | null {
  const m = name.trim().match(/^(lith|meso|neo|axi|requiem)\s+([a-z]\d+)(?:\s+(?:intact|exceptional|flawless|radiant|relic))?$/i);
  return m ? `${m[1]!.charAt(0).toUpperCase()}${m[1]!.slice(1).toLowerCase()} ${m[2]!.toUpperCase()}` : null;
}

/** Ranks candidates: exact name, then prefix, then substring; gameplay items before cosmetics; shorter names first. */
export function rankItems<T extends { name: string; category: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const score = (i: T) => {
    const n = i.name.toLowerCase();
    const match = n === q ? 0 : n.startsWith(q) ? 1 : n.split(/\s+/).some((w) => w.startsWith(q)) ? 2 : 3;
    // The cosmetic penalty outweighs one match tier, so "Kuva Bramma" beats "Bramma Skin" for "bramma".
    return match * 10 + (COSMETIC.has(i.category) ? 15 : 0);
  };
  return [...items].sort((a, b) => score(a) - score(b) || a.name.length - b.name.length);
}

/** Names for autocomplete, with relic refinements collapsed into "<Tier> <Code> Relic". */
export async function suggestItems(query: string, limit = 25): Promise<string[]> {
  if (query.trim().length < 2) return [];
  const items = await search(query.trim(), 'name,category,uniqueName');
  const names: string[] = [];
  for (const item of rankItems(items, query)) {
    const name = item.category === 'Relics' ? `${relicBaseName(item.name) ?? item.name} Relic` : item.name;
    if (!names.includes(name)) names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function buildRelic(variants: WfItem[], base: string): RelicInfo {
  const byRefinement = new Map(variants.map((v) => [v.name.slice(base.length + 1), v]));
  const intact = byRefinement.get('Intact') ?? variants[0]!;
  const radiant = byRefinement.get('Radiant');
  type RawReward = { chance: number; rarity: string; item: { name: string; warframeMarket?: { urlName?: string } } };
  const radiantChance = new Map(((radiant?.rewards ?? []) as RawReward[]).map((r) => [r.item.name, r.chance]));
  const rarityOrder: Record<string, number> = { Common: 0, Uncommon: 1, Rare: 2 };
  // The export's rarity labels are unreliable; intact chances are fixed (25.33 / 11 / 2), so derive it from those.
  const rarityOf = (intactChance: number) => (intactChance >= 20 ? 'Common' : intactChance >= 5 ? 'Uncommon' : 'Rare');
  const rewards = ((intact.rewards ?? []) as RawReward[])
    .map((r) => ({
      item: r.item.name,
      rarity: rarityOf(r.chance),
      intact: r.chance,
      radiant: radiantChance.get(r.item.name) ?? null,
      marketSlug: r.item.warframeMarket?.urlName ?? null,
    }))
    .sort((a, b) => (rarityOrder[a.rarity] ?? 9) - (rarityOrder[b.rarity] ?? 9) || a.item.localeCompare(b.item));
  const locations = variants.flatMap((v) => (v.locations ?? []) as RelicInfo['locations']);
  return {
    name: `${base} Relic`,
    vaulted: Boolean(intact.vaulted),
    rewards,
    locations: locations.filter((l, i) => locations.findIndex((x) => x.location === l.location) === i),
    marketSlug: (intact.marketInfo as { urlName?: string } | undefined)?.urlName ?? null,
    imageName: intact.imageName,
  };
}

/** Finds the best matching item, merging a relic's four refinements into one result. */
export async function lookupItem(query: string): Promise<LookupResult | null> {
  const relicBase = relicBaseName(query);
  if (relicBase) {
    const variants = (await search(relicBase)).filter(
      (i) => i.category === 'Relics' && REFINEMENTS.some((r) => i.name === `${relicBase} ${r}`),
    );
    if (variants.length) return { kind: 'relic', relic: buildRelic(variants, relicBase) };
  }
  const items = await search(query.trim());
  const best = rankItems(items, query)[0];
  if (!best) return null;
  if (best.category === 'Relics') {
    const base = relicBaseName(best.name);
    if (base) return lookupItem(base);
  }
  return { kind: 'item', item: best };
}

export function itemImage(imageName: string | undefined): string | null {
  return imageName ? `https://cdn.warframestat.us/img/${encodeURIComponent(imageName)}` : null;
}

export function wikiUrl(item: { name: string; wikiaUrl?: string }): string {
  return item.wikiaUrl?.startsWith('https://wiki.warframe.com/')
    ? item.wikiaUrl
    : `https://wiki.warframe.com/w/${encodeURIComponent(item.name.replace(/ /g, '_'))}`;
}

type Drop = { location: string; chance?: number; rarity?: string };

export function topDrops(item: WfItem, n = 5): Drop[] {
  const drops = ((item.drops ?? []) as Drop[]).slice().sort((a, b) => (b.chance ?? 0) - (a.chance ?? 0));
  return drops.slice(0, n);
}

const round = (x: unknown, digits = 2) => (typeof x === 'number' ? Math.round(x * 10 ** digits) / 10 ** digits : undefined);

/** Compact plain-JSON view of a lookup for AI and MCP clients. */
export function summarizeLookup(result: LookupResult): Record<string, unknown> {
  if (result.kind === 'relic') return { kind: 'relic', ...result.relic };
  const i = result.item;
  const base = {
    name: i.name,
    category: i.category,
    type: i.type,
    description: i.description,
    masteryRank: i.masteryReq,
    tradable: i.tradable,
    vaulted: i.vaulted,
    wiki: wikiUrl(i),
  };
  if (FRAME_CATEGORIES.has(i.category)) {
    return {
      ...base,
      health: i.health,
      shield: i.shield,
      armor: i.armor,
      energy: i.power,
      sprintSpeed: i.sprintSpeed,
      aura: i.aura,
      polarities: i.polarities,
      passive: i.passiveDescription,
      abilities: ((i.abilities ?? []) as { name: string; description?: string }[]).map((a) => ({ name: a.name, description: a.description })),
      components: ((i.components ?? []) as { name: string }[]).map((c) => c.name),
    };
  }
  if (WEAPON_CATEGORIES.has(i.category)) {
    const damage = Object.fromEntries(
      Object.entries((i.damage ?? {}) as Record<string, number>).filter(([k, v]) => v > 0 && k !== 'total'),
    );
    return {
      ...base,
      totalDamage: i.totalDamage,
      damage,
      criticalChance: round(Number(i.criticalChance) * 100, 1),
      criticalMultiplier: round(i.criticalMultiplier, 1),
      statusChance: round(Number(i.procChance) * 100, 1),
      fireRate: round(i.fireRate),
      magazineSize: i.magazineSize,
      reloadTime: round(i.reloadTime),
      rivenDisposition: i.disposition,
      trigger: i.trigger,
      attacks: ((i.attacks ?? []) as { name: string }[]).map((a) => a.name),
    };
  }
  if (i.category === 'Mods' || i.category === 'Arcanes') {
    const levels = (i.levelStats ?? []) as { stats: string[] }[];
    return {
      ...base,
      compatibleWith: i.compatName,
      polarity: i.polarity,
      rarity: i.rarity,
      baseDrain: i.baseDrain,
      maxRank: i.fusionLimit,
      effectAtMaxRank: levels.at(-1)?.stats,
      topDrops: topDrops(i),
    };
  }
  return { ...base, topDrops: topDrops(i) };
}
