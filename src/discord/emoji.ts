import type { APIMessageComponentEmoji } from 'discord.js';

/**
 * The Warframe icons Ordis writes with. Each logical name lists the custom emojis that can show it (the clan server's own, which staff
 * uploaded, and Ordis's application emojis, `wf_*`, which it uploads itself from the wiki: src/discord/app-emojis.ts) and the Unicode
 * emoji used when none of them exists, so a renamed or deleted emoji only makes a message plainer, never broken.
 *
 * The registry is filled at ClientReady and every half hour from the guild's and the application's emoji lists (`loadEmojis`), so code
 * only ever asks for a logical name: `e('arbitration')` in text, `emojiFor('arbitration')` for a button or select option.
 */
export const EMOJI = {
  // Activities
  alert: { names: ['IconQuest'], fallback: '⚠️' },
  arbitration: { names: ['Arbitration'], fallback: '⚖️' },
  sortie: { names: ['Sortie'], fallback: '⚔️' },
  archon: { names: ['taured'], fallback: '🗡️' },
  fissure: { names: ['VoidTraces'], fallback: '🌀' },
  lith: { names: ['T1Fissure'], fallback: '🟤' },
  meso: { names: ['T2Fissure'], fallback: '⚪' },
  neo: { names: ['T3Fissure'], fallback: '🟡' },
  axi: { names: ['T4Fissure'], fallback: '🟠' },
  requiem: { names: ['wf_requiem'], fallback: '🔴' },
  omnia: { names: [], fallback: '🌐' },
  storm: { names: ['wf_railjack'], fallback: '⛈️' },
  steelPath: { names: ['wf_steel_essence'], fallback: '🔥' },
  invasion: { names: ['wf_invasion'], fallback: '🎯' },
  event: { names: ['IconQuest'], fallback: '🎉' },
  nightwave: { names: ['wf_nightwave'], fallback: '🌙' },
  weekly: { names: ['IconWeekly'], fallback: '🗓️' },
  bounty: { names: ['wf_bounty'], fallback: '📜' },
  cycle: { names: [], fallback: '🌗' },
  lotus: { names: ['wf_lotus'], fallback: '🪷' },
  // Traders
  baro: { names: ['wf_baro'], fallback: '🛒' },
  darvo: { names: ['wf_darvo'], fallback: '🏷️' },
  teshin: { names: ['wf_teshin'], fallback: '🧭' },
  varzia: { names: ['wf_varzia'], fallback: '🏺' },
  // Currencies and resources
  platinum: { names: ['platinum'], fallback: '💎' },
  credits: { names: ['credits'], fallback: '💰' },
  ducats: { names: ['OrokinDucats'], fallback: '🪙' },
  kuva: { names: ['kuva'], fallback: '🩸' },
  endo: { names: ['endo'], fallback: '🔷' },
  vitus: { names: ['VitusEssence'], fallback: '🟢' },
  voidTraces: { names: ['VoidTraces'], fallback: '✨' },
  coupon: { names: ['IconCoupon'], fallback: '🎟️' },
  clanXp: { names: ['ClanXP'], fallback: '🏅' },
  forma: { names: ['wf_forma'], fallback: '📐' },
  catalyst: { names: ['wf_catalyst'], fallback: '🔵' },
  reactor: { names: ['wf_reactor'], fallback: '🟡' },
  exilus: { names: ['wf_exilus'], fallback: '🔶' },
  nitain: { names: ['wf_nitain'], fallback: '🧪' },
  aya: { names: ['wf_aya'], fallback: '💠' },
  regalAya: { names: ['wf_regal_aya'], fallback: '💠' },
  // Archon shards
  shardCrimson: { names: ['taured'], fallback: '🔴' },
  shardAzure: { names: ['taublue'], fallback: '🔵' },
  shardAmber: { names: ['tauamber'], fallback: '🟠' },
  shardViolet: { names: ['taupurple'], fallback: '🟣' },
  shardTopaz: { names: ['tautopaz'], fallback: '🟡' },
  shardEmerald: { names: ['tauemerald'], fallback: '🟢' },
  // Arbitration tiers (the Arbitration Goons' S…F); the stand-in is the letter itself, so a list stays readable without them.
  tierS: { names: ['wf_tier_s'], fallback: '`S`' },
  tierA: { names: ['wf_tier_a'], fallback: '`A`' },
  tierB: { names: ['wf_tier_b'], fallback: '`B`' },
  tierC: { names: ['wf_tier_c'], fallback: '`C`' },
  tierD: { names: ['wf_tier_d'], fallback: '`D`' },
  tierF: { names: ['wf_tier_f'], fallback: '`F`' },
  // Rarity
  common: { names: ['IconCommon'], fallback: '🟫' },
  uncommon: { names: ['IconUncommon'], fallback: '⬜' },
  rare: { names: ['IconRare'], fallback: '🟨' },
  legendary: { names: ['IconLegendary'], fallback: '🟪' },
  // Factions
  grineer: { names: ['wf_grineer'], fallback: '🔴' },
  corpus: { names: ['wf_corpus'], fallback: '🔵' },
  infested: { names: ['wf_infested'], fallback: '🟢' },
  orokin: { names: ['wf_orokin'], fallback: '🟡' },
  sentient: { names: ['wf_sentient'], fallback: '🟠' },
  narmer: { names: ['wf_narmer'], fallback: '👁️' },
  murmur: { names: ['wf_murmur'], fallback: '🟣' },
  scaldra: { names: ['wf_scaldra'], fallback: '🟤' },
  techrot: { names: ['wf_techrot'], fallback: '🦠' },
  anarchs: { names: ['wf_anarchs'], fallback: '⚫' },
  // General
  warframe: { names: ['wf'], fallback: '🔹' },
  ayatan: { names: ['anasa'], fallback: '🏺' },
  energy: { names: ['IconEnergy'], fallback: '⚡' },
  health: { names: ['IconHealth'], fallback: '❤️' },
  first: { names: ['IconPaginationFirst'], fallback: '⏮️' },
  previous: { names: ['IconPaginationPrevious'], fallback: '◀️' },
  next: { names: ['IconPaginationNext'], fallback: '▶️' },
  last: { names: ['IconPaginationLast'], fallback: '⏭️' },
} as const satisfies Record<string, { names: readonly string[]; fallback: string }>;

export type EmojiName = keyof typeof EMOJI;

export interface CustomEmoji {
  id: string;
  name: string;
  animated: boolean;
}

let known = new Map<string, CustomEmoji>();

/** Replaces the registry with the custom emojis Ordis can use now. Names are matched exactly, as Discord stores them. */
export function loadEmojis(emojis: Iterable<{ id: string; name: string | null; animated?: boolean | null }>): number {
  const next = new Map<string, CustomEmoji>();
  for (const e of emojis) if (e.name) next.set(e.name, { id: e.id, name: e.name, animated: Boolean(e.animated) });
  known = next;
  return next.size;
}

function custom(name: EmojiName): CustomEmoji | null {
  for (const n of EMOJI[name].names) {
    const hit = known.get(n);
    if (hit) return hit;
  }
  return null;
}

/** The emoji as message text: the custom one when it exists, else its Unicode stand-in. */
export function e(name: EmojiName): string {
  const c = custom(name);
  return c ? `<${c.animated ? 'a' : ''}:${c.name}:${c.id}>` : EMOJI[name].fallback;
}

/** The emoji for a button or a select option. */
export function emojiFor(name: EmojiName): APIMessageComponentEmoji {
  const c = custom(name);
  return c ? { id: c.id, name: c.name, animated: c.animated } : { name: EMOJI[name].fallback };
}

/** Whether a custom emoji is in use for this name (the admin panel lists what is missing). */
export const hasCustom = (name: EmojiName): boolean => custom(name) !== null;

/** The picture of the custom emoji (a board's thumbnail), or null when only the Unicode stand-in exists. */
export function emojiUrl(name: EmojiName, size = 96): string | null {
  const c = custom(name);
  return c ? `https://cdn.discordapp.com/emojis/${c.id}.${c.animated ? 'gif' : 'png'}?size=${size}` : null;
}

/** Every logical name with what shows it now. */
export function emojiReport(): { name: EmojiName; custom: string | null; fallback: string }[] {
  return (Object.keys(EMOJI) as EmojiName[]).map((name) => ({ name, custom: custom(name)?.name ?? null, fallback: EMOJI[name].fallback }));
}

const FACTIONS: [RegExp, EmojiName][] = [
  [/grineer/i, 'grineer'],
  [/corpus/i, 'corpus'],
  [/infest/i, 'infested'],
  [/orokin|corrupted/i, 'orokin'],
  [/sentient/i, 'sentient'],
  [/narmer/i, 'narmer'],
  [/murmur/i, 'murmur'],
  [/scaldra/i, 'scaldra'],
  [/techrot/i, 'techrot'],
  [/anarch/i, 'anarchs'],
];

/** The emoji of a faction as the world state names it ("Grineer", "Corrupted", "The Murmur", "Crossfire" has none). */
export function factionEmoji(faction: string | null | undefined): string {
  const hit = FACTIONS.find(([re]) => re.test(faction ?? ''));
  return hit ? e(hit[1]) : '';
}

/**
 * A faction in a dense list: its icon when the custom one exists, else its name ("Crossfire" and unknown factions by name too). A
 * coloured circle alone would say nothing, so the Unicode stand-ins are not used here.
 */
export function factionTag(faction: string | null | undefined): string {
  const hit = FACTIONS.find(([re]) => re.test(faction ?? ''));
  return hit && hasCustom(hit[1]) ? e(hit[1]) : (faction ?? '');
}

const TIERS: Record<string, EmojiName> = { lith: 'lith', meso: 'meso', neo: 'neo', axi: 'axi', requiem: 'requiem', omnia: 'omnia' };

/** The emoji of a relic tier ("Lith" … "Omnia"). */
export function tierEmoji(tier: string | null | undefined): string {
  const name = TIERS[(tier ?? '').toLowerCase()];
  return name ? e(name) : e('fissure');
}

const SHARDS: Record<string, EmojiName> = {
  crimson: 'shardCrimson',
  azure: 'shardAzure',
  amber: 'shardAmber',
  violet: 'shardViolet',
  topaz: 'shardTopaz',
  emerald: 'shardEmerald',
};

/** The emoji of an archon shard by its colour, or of the Archon Hunt itself. */
export function shardEmoji(colour: string | null | undefined): string {
  const key = Object.keys(SHARDS).find((k) => (colour ?? '').toLowerCase().includes(k));
  return e(key ? SHARDS[key]! : 'archon');
}

/** Emojis for the rewards Ordis recognises in a reward text ("Forma Blueprint", "3x Orokin Catalyst", "200,000 Kuva"). */
const REWARDS: [RegExp, EmojiName][] = [
  [/forma/i, 'forma'],
  [/catalyst/i, 'catalyst'],
  [/reactor/i, 'reactor'],
  [/exilus/i, 'exilus'],
  [/nitain/i, 'nitain'],
  [/regal aya/i, 'regalAya'],
  [/\baya\b/i, 'aya'],
  [/kuva/i, 'kuva'],
  [/endo/i, 'endo'],
  [/credits?\b/i, 'credits'],
  [/platinum/i, 'platinum'],
  [/ducats?/i, 'ducats'],
  [/vitus/i, 'vitus'],
  [/void traces?/i, 'voidTraces'],
  [/steel essence/i, 'steelPath'],
  [/riven/i, 'legendary'],
];

export function rewardEmoji(reward: string | null | undefined): string {
  const hit = REWARDS.find(([re]) => re.test(reward ?? ''));
  return hit ? e(hit[1]) : '';
}
