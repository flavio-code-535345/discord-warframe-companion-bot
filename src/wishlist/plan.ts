import type { OwnedRelic } from '../alecaframe/api.js';
import { toMs } from '../time.js';
import { type BookSet, REFINEMENTS, type Rarity, type RelicBook } from '../warframe/relics.js';
import { type WorldState, resurgenceItemName } from '../warframe/worldstate.js';

/**
 * The prime wishlist's reckoning (pure): for a set a member is collecting, which parts are still missing, what they trade for, which
 * relics hold each of them (the ones that still drop first) and which of those relics the member owns; and whether Varzia sells the
 * set right now. Everything comes from the relic book (WFInfo's tables), the member's AlecaFrame relics and the world state.
 */

/** How many sets one member may collect at a time. */
export const MAX_WISHES = 20;

export interface WishRelic {
  /** "Axi S3". */
  name: string;
  tier: string;
  rarity: Rarity;
  vaulted: boolean;
  /** The copies the member owns, by refinement; empty when none, or when their relics are not known. */
  owned: { refinement: string; count: number }[];
}

export interface WishPart {
  name: string;
  /** How many of it the set needs. */
  count: number;
  /** What one trades for, null when the list has no price. */
  plat: number | null;
  ducats: number;
  have: boolean;
  /** A part that is a whole set of its own (Bronco Prime for Akbronco Prime): no relic holds it under this name. */
  ownSet: boolean;
  relics: WishRelic[];
}

export interface WishPlan {
  set: BookSet;
  parts: WishPart[];
  missing: WishPart[];
  /** What the missing parts that have a price trade for together (a part needed twice counts twice). */
  missingPlat: number;
  /** How many of the missing parts have no price. */
  unpriced: number;
  /** Copies of relics the member owns that hold a missing part; null when their relics are not known. */
  ownedRelics: number | null;
}

const lower = (s: string) => s.trim().toLowerCase();
const refinementOrder = (r: string) => {
  const at = (REFINEMENTS as readonly string[]).indexOf(r);
  return at < 0 ? REFINEMENTS.length : at;
};

/** Whether a set can be collected from relics at all (some relic holds one of its parts). */
export const inRelics = (set: BookSet): boolean => set.parts.some((p) => p.relics.length > 0);

/** `have`: the names of the parts the member already has. `owned`: their relics, or null when they are not known. */
export function wishPlan(book: RelicBook, set: BookSet, have: readonly string[], owned: readonly OwnedRelic[] | null): WishPlan {
  const has = new Set(have.map(lower));
  const mine = new Map<string, { refinement: string; count: number }[]>();
  for (const o of owned ?? []) {
    const key = lower(`${o.tier} ${o.code}`);
    const list = mine.get(key) ?? [];
    list.push({ refinement: o.refinement, count: o.count });
    mine.set(key, list);
  }
  // The most refined copies first: they are the ones to open for a rare part.
  for (const list of mine.values()) list.sort((a, b) => refinementOrder(b.refinement) - refinementOrder(a.refinement));

  const parts: WishPart[] = set.parts.map((p) => {
    const sub = p.relics.length === 0 && lower(p.name) !== lower(set.name) ? (book.sets.get(lower(p.name)) ?? null) : null;
    return {
      name: p.name,
      count: p.count,
      // A weapon that is a part is priced as that weapon's set, not as its blueprint.
      plat: sub ? sub.plat : p.plat,
      ducats: p.ducats,
      have: has.has(lower(p.name)),
      ownSet: sub !== null,
      relics: p.relics.map((h) => ({ name: h.relic.name, tier: h.relic.tier, rarity: h.rarity, vaulted: h.relic.vaulted, owned: mine.get(lower(h.relic.name)) ?? [] })),
    };
  });
  const missing = parts.filter((p) => !p.have);
  const holding = new Set(missing.flatMap((p) => p.relics.map((r) => lower(r.name))));
  let ownedRelics: number | null = null;
  if (owned) {
    ownedRelics = 0;
    for (const [name, list] of mine) if (holding.has(name)) ownedRelics += list.reduce((sum, x) => sum + x.count, 0);
  }
  return {
    set,
    parts,
    missing,
    missingPlat: missing.reduce((sum, p) => sum + (p.plat ?? 0) * p.count, 0),
    unpriced: missing.filter((p) => p.plat === null).length,
    ownedRelics,
  };
}

export interface VarziaOffer {
  /** What she sells of it, as players know the items: the set itself, a pack with it, the relics of its resurgence. */
  items: string[];
  /** When her stock changes. */
  until: number;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What Varzia sells of a prime set right now (pure), or null. Three things count: the set under its own name ("Strun Prime"), a pack
 * that names it ("Saryn Prime Single Pack", "Nidus Saryn Prime Dual Pack") and the relics of the resurgence it belongs to, which the
 * feed names after its Warframes ("Lith relic · Nidus Saryn A"). Sigils, statues and skins that carry the name do not.
 */
export function varziaOffer(setName: string, ws: Pick<WorldState, 'vaultTrader'> | null, now: number): VarziaOffer | null {
  const trader = ws?.vaultTrader;
  if (!trader?.inventory?.length || !(toMs(trader.expiry) > now)) return null;
  const full = lower(setName);
  const base = full.replace(/\s+prime$/, '');
  if (!base) return null;
  const word = new RegExp(`(^|[^a-z0-9])${escapeRegex(base)}([^a-z0-9]|$)`);
  const items: string[] = [];
  for (const entry of trader.inventory) {
    const name = resurgenceItemName(String(entry?.item ?? '')).trim();
    const text = name.toLowerCase();
    const relic = /^(?:lith|meso|neo|axi) relic · (.+) [a-z]$/.exec(text);
    const pack = /^(.+) prime (?:single|dual) pack$/.exec(text);
    if (text === full || (relic && word.test(relic[1]!)) || (pack && word.test(pack[1]!))) {
      if (!items.includes(name)) items.push(name);
    }
  }
  return items.length ? { items, until: toMs(trader.expiry) } : null;
}
