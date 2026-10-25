/** Pure leveling rules: the XP curve, how much a message is worth, and which "Level N+" role a level earns. */

export const MESSAGE_COOLDOWN_MS = 60_000;
export const VOICE_XP_PER_MINUTE = 10;
export const MAX_LEVEL = 200;

/** XP needed to go from `level` to `level + 1` (the MEE6/Arcane curve). */
export const xpForNextLevel = (level: number): number => 5 * level * level + 50 * level + 100;

/** Total XP at which `level` is reached. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < Math.min(level, MAX_LEVEL); l++) total += xpForNextLevel(l);
  return total;
}

export interface LevelProgress {
  level: number;
  /** XP earned inside the current level. */
  into: number;
  /** XP the current level takes in all. */
  needed: number;
}

export function progressOf(xp: number): LevelProgress {
  let level = 0;
  let left = Math.max(0, Math.floor(xp));
  while (level < MAX_LEVEL && left >= xpForNextLevel(level)) {
    left -= xpForNextLevel(level);
    level++;
  }
  return { level, into: left, needed: xpForNextLevel(level) };
}

export const levelOf = (xp: number): number => progressOf(xp).level;

/** 15-25 XP per message; `random` is injectable for tests. */
export const rollMessageXp = (random: () => number = Math.random): number => 15 + Math.floor(random() * 11);

export const mayEarnMessageXp = (lastXpAt: number, now: number): boolean => now - lastXpAt >= MESSAGE_COOLDOWN_MS;

/** "Level 10+" and "Level 10" both count; returns the tier number or null. */
export function levelTier(roleName: string): number | null {
  const m = /^\s*level\s*(\d{1,3})\s*\+?\s*$/i.exec(roleName);
  return m ? Number(m[1]) : null;
}

export interface LevelRole {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

export interface LevelRolePlan {
  add: LevelRole | null;
  remove: LevelRole[];
}

/**
 * Members hold exactly one tier role: the highest "Level N+" at or below their level. Lower tiers they hold are removed
 * (also tiers above their level, after an XP reset). Roles Ordis can't manage are left alone.
 */
export function planLevelRoles(roles: LevelRole[], level: number, held: Set<string>, botPosition: number): LevelRolePlan {
  const tiers = roles
    .map((role) => ({ role, tier: levelTier(role.name) }))
    .filter((t): t is { role: LevelRole; tier: number } => t.tier !== null && !t.role.managed && t.role.position < botPosition);
  const target = tiers.filter((t) => t.tier <= level).sort((a, b) => b.tier - a.tier)[0]?.role ?? null;
  return {
    add: target && !held.has(target.id) ? target : null,
    remove: tiers.filter((t) => t.role.id !== target?.id && held.has(t.role.id)).map((t) => t.role),
  };
}

/** A text progress bar like ▰▰▰▱▱▱▱▱▱▱. */
export function progressBar(fraction: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
