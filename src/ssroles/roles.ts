/** Pure rules for screenshot roles: what a profile card proves, and which server roles that earns. */

export interface CardReading {
  is_profile_card: boolean;
  in_game_name: string | null;
  mastery_rank_title: string | null;
  mastery_rank_number: number | null;
  mastery_points: string | null;
  next_rank: string | null;
  points_to_next_rank: string | null;
  clan_name: string | null;
  clan_tag: string | null;
  clan_tier_rank: string | null;
  accolades: string[];
  /** Only filled in when a reference card was supplied. */
  emblem_matches_reference: boolean | null;
  clan_text_matches_reference: boolean | null;
  looks_edited_or_fake: boolean;
  notes: string;
}

/** Lowercase letters and digits only, so "Rat's Den 69", "rats den 69" and "🐀 Rats-Den-69" compare equal. */
export const norm = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** MR 0-30 are plain numbers; Legendary N is MR 30 + N. Returns null when the card gives nothing usable. */
export function masteryRank(r: Pick<CardReading, 'mastery_rank_title' | 'mastery_rank_number'>): number | null {
  const title = r.mastery_rank_title?.trim().toLowerCase() ?? '';
  const legendary = /legendary\s*(\d{1,2})/.exec(title);
  if (legendary) return 30 + Number(legendary[1]);
  const plain = /^(?:mr|mastery rank)?\s*(\d{1,2})$/.exec(title);
  if (plain) return Number(plain[1]);
  const n = r.mastery_rank_number;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 60 ? n : null;
}

export interface ClanCheck {
  ok: boolean;
  /** Why it failed, in words a member can act on. */
  problems: string[];
}

/**
 * Whether the card proves clan membership: the name must match, and with a stored reference the clan text must match
 * and the emblem must not differ. An emblem of null means it could not be compared (the fallback reader), which passes.
 */
export function checkClan(r: CardReading, clanName: string, hasReference: boolean): ClanCheck {
  const problems: string[] = [];
  if (!r.is_profile_card) problems.push("This doesn't look like a Warframe profile card.");
  if (r.looks_edited_or_fake) problems.push('The screenshot looks edited.');
  if (!r.clan_name) problems.push("I couldn't find a clan on the card.");
  else if (norm(r.clan_name) !== norm(clanName)) problems.push(`The card says the clan is "${r.clan_name}", not ${clanName}.`);
  if (hasReference) {
    if (r.clan_text_matches_reference !== true) problems.push("The clan name and number don't match our clan.");
    if (r.emblem_matches_reference === false) problems.push("The clan emblem doesn't match ours.");
  }
  return { ok: problems.length === 0, problems };
}

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  managed: boolean;
  /** Administrator, Manage Roles/Server/Channels/Messages, kick, ban or timeout: never handed out by a screenshot. */
  dangerous: boolean;
}

// MR 1-30, and LR 1-6 (also written Legendary 1-6) for the Legendary ranks above MR 30.
const MASTERY_ROLE = /^(mr|masteryrank|mastery)\d{1,2}$|^(lr|legendaryrank|legendary)\d{1,2}$/;
export const isMasteryRoleName = (name: string): boolean => MASTERY_ROLE.test(norm(name));

/** Every normalized role name a verified card earns. */
export function earnedNames(r: CardReading, mr: number | null, clanName: string): Set<string> {
  const names = new Set<string>(['clan', norm(clanName)]);
  if (mr !== null) {
    names.add(`mr${mr}`);
    names.add(`masteryrank${mr}`);
    names.add(`mastery${mr}`);
    if (mr > 30) {
      names.add(`legendary${mr - 30}`);
      names.add(`lr${mr - 30}`);
      names.add(`legendaryrank${mr - 30}`);
    }
  }
  for (const a of r.accolades) if (norm(a)) names.add(norm(a));
  return names;
}

export interface RolePlan {
  add: RoleInfo[];
  /** Older mastery-rank roles the member holds that this card replaces. */
  remove: RoleInfo[];
  skipped: { name: string; reason: string }[];
}

/**
 * Matches the card against the server's roles by name. Only existing roles are used. A role is skipped when it is
 * managed, dangerous or above Ordis. Mastery roles are one-at-a-time: the earned one is added and others are removed.
 */
export function planRoles(roles: RoleInfo[], earned: Set<string>, held: Set<string>, botPosition: number): RolePlan {
  const plan: RolePlan = { add: [], remove: [], skipped: [] };
  const earnedMastery = roles.filter((r) => isMasteryRoleName(r.name) && earned.has(norm(r.name)));
  for (const role of roles) {
    const key = norm(role.name);
    if (isMasteryRoleName(role.name) && !earned.has(key)) {
      if (held.has(role.id) && earnedMastery.length && role.position < botPosition && !role.managed) plan.remove.push(role);
      continue;
    }
    if (!earned.has(key) || key === 'everyone') continue;
    if (role.managed) plan.skipped.push({ name: role.name, reason: 'managed by an integration' });
    else if (role.dangerous) plan.skipped.push({ name: role.name, reason: 'has moderator permissions' });
    else if (role.position >= botPosition) plan.skipped.push({ name: role.name, reason: 'above Ordis in the role list' });
    else if (!held.has(role.id)) plan.add.push(role);
  }
  return plan;
}

// --- clan rank (the title next to a member's name in the in-game clan roster) ---

/** Clan ranks from lowest to highest. The title in the roster is "Rat Squire", "Rat Knight" and so on. */
export const CLAN_RANKS = ['squire', 'knight', 'baron', 'count', 'lord', 'king', 'emperor'] as const;
export type ClanRank = (typeof CLAN_RANKS)[number];

/**
 * Ranks a screenshot can earn. Baron and above are handed out by leadership (Baron needs MR 30 and 1000+ hours, which a
 * screenshot can't show), so they never come from a picture.
 */
export const SELF_SERVE_RANKS: readonly ClanRank[] = ['squire', 'knight'];

/** The mastery rank a clan rank asks for, where the clan has a rule (Rat Knight: MR 16+). */
export const RANK_MIN_MASTERY: Partial<Record<ClanRank, number>> = { knight: 16 };

export const clanRankRoleName = (rank: ClanRank): string => `Rat ${rank[0]!.toUpperCase()}${rank.slice(1)}`;

/** The mastery rank a role name stands for ("MR 33" = 33, "LR 3" = 33), or null. */
export function masteryOfRoleName(name: string): number | null {
  const m = /^(mr|masteryrank|mastery)(\d{1,2})$|^(lr|legendaryrank|legendary)(\d{1,2})$/.exec(norm(name));
  if (!m) return null;
  return m[2] ? Number(m[2]) : 30 + Number(m[4]);
}

export interface ClanRankPlan {
  add: RoleInfo | null;
  /** Lower self-serve clan roles replaced by the new one. */
  remove: RoleInfo[];
  problems: string[];
}

/**
 * Which clan-rank role a roster screenshot earns. Only SELF_SERVE_RANKS are handed out; Rat Knight also needs an MR 16+
 * mastery role (which comes from a verified profile card). Other clan-rank roles the member holds are never touched.
 */
export function planClanRank(roles: RoleInfo[], rank: ClanRank, held: Set<string>, botPosition: number): ClanRankPlan {
  const plan: ClanRankPlan = { add: null, remove: [], problems: [] };
  if (!SELF_SERVE_RANKS.includes(rank)) {
    plan.problems.push(`${clanRankRoleName(rank)} is given out by clan leadership, not from a screenshot.`);
    return plan;
  }
  const need = RANK_MIN_MASTERY[rank];
  if (need !== undefined) {
    const mastery = Math.max(0, ...roles.filter((r) => held.has(r.id)).map((r) => masteryOfRoleName(r.name) ?? 0));
    if (mastery < need) plan.problems.push(`${clanRankRoleName(rank)} needs Mastery Rank ${need}+. Post your profile card first so I can give you your MR role, then post this again.`);
  }
  const target = roles.find((r) => norm(r.name) === norm(clanRankRoleName(rank)));
  if (!target) plan.problems.push(`There is no "${clanRankRoleName(rank)}" role on this server.`);
  else if (target.managed || target.dangerous || target.position >= botPosition) plan.problems.push(`I can't hand out ${target.name} (managed, above me or has moderator powers).`);
  if (plan.problems.length) return plan;
  if (target && !held.has(target.id)) plan.add = target;
  const lower = SELF_SERVE_RANKS.slice(0, SELF_SERVE_RANKS.indexOf(rank));
  plan.remove = roles.filter((r) => held.has(r.id) && lower.some((l) => norm(r.name) === norm(clanRankRoleName(l))) && r.position < botPosition && !r.managed);
  return plan;
}
