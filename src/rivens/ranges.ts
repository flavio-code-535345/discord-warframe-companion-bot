/**
 * The riven attribute ranges, from the wiki's "Riven Mods" page (Attribute Value Formula + Base Values). A rolled value is random between
 * 90% and 110% of  base x disposition x layout weight, where the weight depends on the number of bonuses and curses (see rolls.ts) and
 * the base depends on the stat and on the kind of weapon. The bases below are the centre of the wiki's "+3 -1" bonus ranges divided by
 * 1.2 x 0.9375 (checked against the other layouts: they agree to 0.01%). The wiki's constant for the disposition is 1.2.
 */

export type Category = 'rifle' | 'shotgun' | 'pistol' | 'archgun' | 'melee';
/** Order tried when the weapon's kind is not known: the common kinds first. */
export const CATEGORIES: Category[] = ['rifle', 'pistol', 'shotgun', 'archgun', 'melee'];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The wiki's disposition constant: the multiplier a riven rolled today uses. */
export const DEFAULT_MULTIPLIER = 1.2;

/** Base values by kind of weapon, under the wiki's attribute names. */
const RAW: Record<Category, Record<string, number>> = {
  rifle: {
    "Ammo Maximum": 49.95,
    "Elemental Damage": 90,
    "Critical Chance": 149.99,
    "Critical Damage": 120,
    "Damage": 165,
    "Rate of Fire": 60.03,
    "Projectile Speed": 90,
    "Physical Damage": 119.97,
    "Magazine Capacity": 50,
    "Multishot": 90,
    "Punch Through": 2.7,
    "Reload Speed": 50,
    "Status Chance": 90,
    "Status Duration": 99.99,
    "Recoil": 90,
    "Zoom": 59.99,
    "Ammo Efficiency": 45,
    "Combined Elemental Damage": 90,
    "Reload While Holstered": 90,
    "Status Damage": 90,
    "Weakpoint Damage": 225,
    "Weakpoint Critical Chance": 247.5,
  },
  shotgun: {
    "Ammo Maximum": 90,
    "Elemental Damage": 90,
    "Critical Chance": 90,
    "Critical Damage": 90,
    "Damage": 164.7,
    "Rate of Fire": 90,
    "Projectile Speed": 90,
    "Physical Damage": 119.97,
    "Magazine Capacity": 50,
    "Multishot": 119.7,
    "Punch Through": 2.7,
    "Reload Speed": 50,
    "Status Chance": 90,
    "Status Duration": 99.99,
    "Recoil": 90,
    "Zoom": 42,
    "Ammo Efficiency": 45,
    "Combined Elemental Damage": 90,
    "Reload While Holstered": 90,
    "Status Damage": 90,
    "Weakpoint Damage": 225,
    "Weakpoint Critical Chance": 247.5,
  },
  pistol: {
    "Ammo Maximum": 90,
    "Elemental Damage": 90,
    "Critical Chance": 149.99,
    "Critical Damage": 90,
    "Damage": 219.6,
    "Rate of Fire": 74.7,
    "Projectile Speed": 90,
    "Physical Damage": 119.97,
    "Magazine Capacity": 50,
    "Multishot": 119.7,
    "Punch Through": 2.7,
    "Reload Speed": 50,
    "Status Chance": 90,
    "Status Duration": 99.99,
    "Recoil": 90,
    "Zoom": 80.1,
    "Ammo Efficiency": 45,
    "Combined Elemental Damage": 90,
    "Reload While Holstered": 90,
    "Status Damage": 90,
    "Weakpoint Damage": 225,
    "Weakpoint Critical Chance": 247.5,
  },
  archgun: {
    "Ammo Maximum": 49.95,
    "Elemental Damage": 90,
    "Critical Chance": 149.99,
    "Critical Damage": 120,
    "Damage": 165,
    "Rate of Fire": 60.03,
    "Physical Damage": 119.97,
    "Magazine Capacity": 50,
    "Multishot": 90,
    "Punch Through": 2.7,
    "Reload Speed": 50,
    "Status Chance": 90,
    "Status Duration": 99.99,
    "Recoil": 90,
    "Zoom": 59.99,
    "Ammo Efficiency": 45,
    "Combined Elemental Damage": 90,
    "Status Damage": 90,
    "Weakpoint Damage": 225,
    "Weakpoint Critical Chance": 247.5,
  },
  melee: {
    "Additional Combo Count Chance": 58.77,
    "Chance to Gain Combo Count": 104.85,
    "Elemental Damage": 90,
    "Combo Duration": 8.1,
    "Critical Chance (x2 for Heavy Attacks)": 180,
    "Critical Chance for Slide Attack": 120,
    "Critical Damage": 90,
    "Melee Damage": 164.7,
    "Finisher Damage": 119.7,
    "Attack Speed": 54.9,
    "Initial Combo": 24.5,
    "Physical Damage": 120,
    "Heavy Attack Efficiency": 73.44,
    "Range": 1.94,
    "Status Chance": 90,
    "Status Duration": 99.99,
    "Combined Elemental Damage": 90,
    "Heavy Attack Wind Up Speed": 119.7,
    "Melee Damage on Heavy Attack": 119.7,
    "Parry Angle": 81,
    "Slam Attack Damage": 119.7,
    "Status Damage": 90,
  },
};

/**
 * A stat reduced to a key both vocabularies share: the wiki's names ("Rate of Fire", "Elemental Damage"), the market's ("Fire Rate /
 * Attack Speed", "Heat", "Weapon Recoil") and its slugs ("fire_rate_attack_speed"). Null for stats that are not known.
 */
export function statKey(name: string): string | null {
  const n = norm(name.replace(/[_/]/g, ' '));
  if (!n) return null;
  // Faction damage ("Damage vs Grineer", "Damage to Grineer", "x1.55 Damage to Grineer") is a multiplier, not a percentage.
  if (/faction|^damage (vs|to) |(vs|to) (grineer|corpus|infested|corrupted)/.test(n)) return 'faction';
  if (/^critical chance (on|for) slide/.test(n)) return 'crit_slide';
  if (/^critical chance/.test(n)) return 'crit_chance';
  if (n === 'critical damage') return 'crit_damage';
  if (/^weak ?point critical chance$/.test(n)) return 'weakpoint_crit';
  if (/^weak ?point damage$/.test(n)) return 'weakpoint';
  if (/^melee damage on heavy attack$/.test(n)) return 'heavy_damage';
  if (/^combined elemental( damage)?$|^(viral|corrosive|blast|radiation|magnetic|gas)( damage)?$/.test(n)) return 'combined';
  if (/^elemental damage$|^(heat|cold|electricity|electric|toxin)( damage)?$/.test(n)) return 'elemental';
  if (/^physical damage$|^(impact|puncture|slash)( damage)?$/.test(n)) return 'physical';
  if (/^(base )?damage( melee damage)?$|^melee damage$/.test(n)) return 'damage';
  if (/fire rate|attack speed|rate of fire/.test(n)) return 'rate';
  if (/^(weapon )?recoil$/.test(n)) return 'recoil';
  if (/^(additional combo count chance|chance for additional combo count)$/.test(n)) return 'extra_combo';
  if (n === 'chance to gain combo count') return 'gain_combo';
  const same = ['multishot', 'status chance', 'status duration', 'status damage', 'reload speed', 'reload while holstered', 'magazine capacity', 'ammo maximum', 'ammo efficiency', 'projectile speed', 'punch through', 'zoom', 'range', 'combo duration', 'initial combo', 'finisher damage', 'heavy attack efficiency', 'heavy attack wind up speed', 'slam attack damage', 'parry angle'];
  return same.includes(n) ? n.replace(/ /g, '_') : null;
}

const BASE: Record<Category, Map<string, number>> = Object.fromEntries(
  (Object.keys(RAW) as Category[]).map((cat) => [cat, new Map(Object.entries(RAW[cat]).flatMap(([name, v]) => { const k = statKey(name); return k ? [[k, v] as [string, number]] : []; }))]),
) as Record<Category, Map<string, number>>;

/** How much a faction multiplier moves away from x1 (x1.51 or x0.74): the same for every kind of weapon. */
export const FACTION_BASE = 0.45;

/** The base value of a stat for a kind of weapon, or null when that kind of weapon does not have the stat. */
export const baseOf = (category: Category, slugOrName: string): number | null => {
  const key = statKey(slugOrName);
  if (key === 'faction') return FACTION_BASE;
  return key ? (BASE[category].get(key) ?? null) : null;
};

/** The kind of weapon from whatever the market calls it ("rifle", "Primary", "kitgun", "zaw"...); null when unknown. */
export function categoryOf(type: string | null | undefined): Category | null {
  const t = (type ?? '').toLowerCase();
  if (!t) return null;
  if (/arch/.test(t)) return 'archgun';
  if (/shotgun/.test(t)) return 'shotgun';
  if (/pistol|secondary|kitgun/.test(t)) return 'pistol';
  if (/melee|zaw|glaive|sword|whip|staff|polearm|hammer|blade|dagger|nikana|scythe|claw|fist|nunchaku|rapier|tonfa|machete|heavy/.test(t)) return 'melee';
  if (/rifle|primary|bow|sniper|launcher|speargun/.test(t)) return 'rifle';
  return null;
}

/** Every stat name of every kind of weapon must be known (checked by the tests). */
export const rawNames = (): { category: Category; name: string }[] => (Object.keys(RAW) as Category[]).flatMap((category) => Object.keys(RAW[category]).map((name) => ({ category, name })));
