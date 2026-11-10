import type { APIMessageComponentEmoji } from 'discord.js';
import { own } from '../own.js';

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
  omnia: { names: ['wf_omnia'], fallback: '🌐' },
  storm: { names: ['wf_railjack'], fallback: '⛈️' },
  steelPath: { names: ['wf_steel_essence'], fallback: '🔥' },
  invasion: { names: ['wf_invasion'], fallback: '🎯' },
  event: { names: ['IconQuest'], fallback: '🎉' },
  nightwave: { names: ['wf_nightwave'], fallback: '🌙' },
  weekly: { names: ['IconWeekly'], fallback: '🗓️' },
  bounty: { names: ['wf_bounty'], fallback: '📜' },
  cycle: { names: ['wf_cycle'], fallback: '🌗' },
  lotus: { names: ['wf_lotus'], fallback: '🪷' },
  duviri: { names: ['wf_duviri'], fallback: '🔁' },
  relic: { names: ['wf_relic'], fallback: '🔮' },
  // Markers: a reward worth a detour, a quick fissure mission
  star: { names: ['wf_star'], fallback: '⭐' },
  bolt: { names: ['wf_bolt'], fallback: '⚡' },
  // States of the open worlds (Cetus and Earth: day and night, Orb Vallis: warm and cold, Cambion Drift: Fass and Vome)
  day: { names: ['wf_day'], fallback: '☀️' },
  night: { names: ['wf_night'], fallback: '🌙' },
  warm: { names: ['wf_warm'], fallback: '🔥' },
  cold: { names: ['wf_cold'], fallback: '❄️' },
  fass: { names: ['wf_fass'], fallback: '🟠' },
  vome: { names: ['wf_vome'], fallback: '🔵' },
  // Duviri's moods
  joy: { names: ['wf_joy'], fallback: '😄' },
  anger: { names: ['wf_anger'], fallback: '😠' },
  envy: { names: ['wf_envy'], fallback: '😒' },
  sorrow: { names: ['wf_sorrow'], fallback: '😢' },
  fear: { names: ['wf_fear'], fallback: '😨' },
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
  // Resources paid out by invasions and alerts. A reward line reads fine without an icon, so these have no Unicode stand-in.
  orokinCell: { names: ['wf_orokin_cell'], fallback: '' },
  neurodes: { names: ['wf_neurodes'], fallback: '' },
  neuralSensors: { names: ['wf_neural_sensors'], fallback: '' },
  gallium: { names: ['wf_gallium'], fallback: '' },
  morphics: { names: ['wf_morphics'], fallback: '' },
  tellurium: { names: ['wf_tellurium'], fallback: '' },
  argon: { names: ['wf_argon'], fallback: '' },
  controlModule: { names: ['wf_control_module'], fallback: '' },
  detonite: { names: ['wf_detonite'], fallback: '' },
  fieldron: { names: ['wf_fieldron'], fallback: '' },
  mutagen: { names: ['wf_mutagen'], fallback: '' },
  oxium: { names: ['wf_oxium'], fallback: '' },
  nanoSpores: { names: ['wf_nano_spores'], fallback: '' },
  plastids: { names: ['wf_plastids'], fallback: '' },
  polymer: { names: ['wf_polymer'], fallback: '' },
  rubedo: { names: ['wf_rubedo'], fallback: '' },
  alloyPlate: { names: ['wf_alloy_plate'], fallback: '' },
  ferrite: { names: ['wf_ferrite'], fallback: '' },
  salvage: { names: ['wf_salvage'], fallback: '' },
  circuits: { names: ['wf_circuits'], fallback: '' },
  cryotic: { names: ['wf_cryotic'], fallback: '' },
  hexenon: { names: ['wf_hexenon'], fallback: '' },
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
  // Rivens and mod polarities (a riven is Madurai, Vazarin or Naramon)
  riven: { names: ['wf_riven'], fallback: '🎲' },
  madurai: { names: ['wf_madurai'], fallback: '`V`' },
  vazarin: { names: ['wf_vazarin'], fallback: '`D`' },
  naramon: { names: ['wf_naramon'], fallback: '`—`' },
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

/**
 * The registry entry of a logical name. The names come from code, but some are worked out from outside data (a relic tier or a cycle
 * state in the world state), so a name the registry doesn't define is "no emoji", never an exception that takes a board down.
 */
const entry = (name: EmojiName): { names: readonly string[]; fallback: string } | undefined => own(EMOJI, String(name));

function custom(name: EmojiName): CustomEmoji | null {
  for (const n of entry(name)?.names ?? []) {
    const hit = known.get(n);
    if (hit) return hit;
  }
  return null;
}

/** The emoji as message text: the custom one when it exists, else its Unicode stand-in. */
export function e(name: EmojiName): string {
  const c = custom(name);
  return c ? `<${c.animated ? 'a' : ''}:${c.name}:${c.id}>` : (entry(name)?.fallback ?? '');
}

/** The emoji for a button or a select option. */
export function emojiFor(name: EmojiName): APIMessageComponentEmoji {
  const c = custom(name);
  return c ? { id: c.id, name: c.name, animated: c.animated } : { name: entry(name)?.fallback || '🔹' };
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

const CYCLE_EMOJI = new Map<string, EmojiName>([
  ['day', 'day'],
  ['night', 'night'],
  ['warm', 'warm'],
  ['cold', 'cold'],
  ['fass', 'fass'],
  ['vome', 'vome'],
  ['corpus', 'corpus'],
  ['grineer', 'grineer'],
  ['joy', 'joy'],
  ['anger', 'anger'],
  ['envy', 'envy'],
  ['sorrow', 'sorrow'],
  ['fear', 'fear'],
]);

/** The logical emoji name of a cycle state ("Day", "Fass", "Joy"), or undefined for a state with none. */
export const cycleEmojiName = (s: string | null | undefined): EmojiName | undefined => CYCLE_EMOJI.get(String(s ?? '').toLowerCase());

/** The emoji of a cycle state, or an empty string. */
export function cycleEmoji(s: string | null | undefined): string {
  const name = cycleEmojiName(s);
  return name ? e(name) : '';
}

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
  const name = own(TIERS, String(tier ?? '').toLowerCase());
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
  const key = Object.keys(SHARDS).find((k) => String(colour ?? '').toLowerCase().includes(k));
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
  [/orokin cell/i, 'orokinCell'],
  [/neural sensors?/i, 'neuralSensors'],
  [/neurodes?/i, 'neurodes'],
  [/gallium/i, 'gallium'],
  [/morphics?/i, 'morphics'],
  [/tellurium/i, 'tellurium'],
  [/argon crystals?/i, 'argon'],
  [/control modules?/i, 'controlModule'],
  [/detonite/i, 'detonite'],
  [/fieldron/i, 'fieldron'],
  [/mutagen mass/i, 'mutagen'],
  [/oxium/i, 'oxium'],
  [/nano spores?/i, 'nanoSpores'],
  [/plastids?/i, 'plastids'],
  [/polymer bundles?/i, 'polymer'],
  [/rubedo/i, 'rubedo'],
  [/alloy plates?/i, 'alloyPlate'],
  [/ferrite/i, 'ferrite'],
  [/salvage/i, 'salvage'],
  [/\bcircuits\b/i, 'circuits'],
  [/cryotic/i, 'cryotic'],
  [/hexenon/i, 'hexenon'],
];

export function rewardEmoji(reward: string | null | undefined): string {
  const hit = REWARDS.find(([re]) => re.test(reward ?? ''));
  return hit ? e(hit[1]) : '';
}
