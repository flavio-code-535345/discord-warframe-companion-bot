import { type Refinement, type RelicBook, relicValue } from '../warframe/relics.js';
import type { Fissure } from '../warframe/worldstate.js';
import type { OwnedRelic } from './api.js';

/**
 * "Crack now" (pure): which of a member's relics are worth opening in the quick fissures that are open. A relic is worth opening when
 * a run alone at the refinement owned is expected to pay `minPlat` or more (WFInfo's prices weighted by the drop chances, as in the
 * relic planner). Only normal fissures count: the Steel Path is not open to everyone. An Omnia fissure takes any relic.
 */

/** What a relic must be expected to pay a run before Ordis calls it worth opening, unless the member says otherwise. */
export const DEFAULT_CRACK_PLAT = 10;
/** The quiet times a member can choose between two "crack now" DMs, in hours, and the one used when they choose none. */
export const CRACK_QUIET_HOURS = [3, 6, 12, 24, 48] as const;
export const DEFAULT_CRACK_QUIET_HOURS = 12;

const TIERS = ['Lith', 'Meso', 'Neo', 'Axi'] as const;

export interface CrackRelic {
  /** "Axi A1". */
  name: string;
  refinement: Refinement;
  count: number;
  /** Expected plat from opening one alone at that refinement. */
  solo: number;
}

export interface CrackTier {
  tier: string;
  /** The quick fissure to open them in: the tier's own, else an Omnia one. */
  fissure: Fissure;
  /** The owned relics of this tier worth opening, the most valuable first. */
  relics: CrackRelic[];
  /** Every copy of them. */
  copies: number;
  /** Expected plat from opening all of them alone. */
  value: number;
}

/** `quick`: the quick fissures open now (warframe/fissures.ts). The tier that pays the most comes first. */
export function crackPlan(owned: readonly OwnedRelic[], book: RelicBook, quick: readonly Fissure[], minPlat = DEFAULT_CRACK_PLAT): CrackTier[] {
  const open = quick.filter((f) => !f.isHard && !f.isStorm);
  const omnia = open.find((f) => f.tier === 'Omnia') ?? null;
  const out: CrackTier[] = [];
  for (const tier of TIERS) {
    const fissure = open.find((f) => f.tier === tier) ?? omnia;
    if (!fissure) continue;
    const relics: CrackRelic[] = [];
    for (const o of owned) {
      if (o.tier !== tier || !(o.count > 0)) continue;
      const relic = book.relics.get(`${o.tier} ${o.code}`.toLowerCase());
      if (!relic) continue;
      const solo = relicValue(relic, o.refinement).solo;
      if (solo >= minPlat) relics.push({ name: relic.name, refinement: o.refinement, count: o.count, solo });
    }
    if (!relics.length) continue;
    relics.sort((a, b) => b.solo - a.solo || a.name.localeCompare(b.name, undefined, { numeric: true }));
    out.push({ tier, fissure, relics, copies: relics.reduce((sum, r) => sum + r.count, 0), value: relics.reduce((sum, r) => sum + r.solo * r.count, 0) });
  }
  return out.sort((a, b) => b.value - a.value);
}
