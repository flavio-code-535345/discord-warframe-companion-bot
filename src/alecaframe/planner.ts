import { type BookReward, REFINEMENTS, type Refinement, type RelicBook, TRACES, relicValue } from '../warframe/relics.js';
import type { OwnedRelic } from './api.js';

/**
 * A member's relics valued (pure): what each is worth to open at the refinement they own (WFInfo's prices weighted by the drop chances),
 * which ones gain the most from being refined to Radiant, and totals. Requiem relics (Kuva Lich and Sister mods, not in the price table)
 * and relics the table doesn't know yet count as unknown.
 */

export interface PlannedRelic {
  /** "Axi A1". */
  name: string;
  tier: string;
  refinement: Refinement;
  count: number;
  vaulted: boolean;
  /** Expected plat from opening one alone at the refinement owned. */
  solo: number;
  /** Expected plat per player when four open it at Radiant together. */
  radshare: number;
  /** Expected ducats from opening one alone at the refinement owned. */
  ducats: number;
  best: BookReward | null;
}

export interface RefineTip {
  relic: PlannedRelic;
  /** Expected plat a solo run gains when this relic is refined to Radiant first. */
  gain: number;
  /** Void Traces that takes per relic. */
  traces: number;
}

export interface RelicPlan {
  /** The owned relics worth the most to open, best first. */
  open: PlannedRelic[];
  /** Relics below Radiant that gain at least 1p a run from refining, most plat per trace first. */
  refine: RefineTip[];
  totals: {
    /** Relics owned, every copy counted. */
    relics: number;
    /** Different relics (a refinement counts as its own). */
    kinds: number;
    /** Expected plat from opening every known one alone at its refinement. */
    value: number;
    /** Copies of vaulted relics. */
    vaulted: number;
    /** Copies the price table doesn't know (Requiem and brand-new relics). */
    unknown: number;
  };
}

const order = (a: PlannedRelic, b: PlannedRelic) => a.name.localeCompare(b.name) || REFINEMENTS.indexOf(a.refinement) - REFINEMENTS.indexOf(b.refinement);

export function planRelics(owned: readonly OwnedRelic[], book: RelicBook, limit = 8): RelicPlan {
  const planned: PlannedRelic[] = [];
  const tips: RefineTip[] = [];
  const totals = { relics: 0, kinds: 0, value: 0, vaulted: 0, unknown: 0 };
  for (const o of owned) {
    totals.relics += o.count;
    totals.kinds += 1;
    const relic = book.relics.get(`${o.tier} ${o.code}`.toLowerCase());
    if (!relic) {
      totals.unknown += o.count;
      continue;
    }
    if (relic.vaulted) totals.vaulted += o.count;
    const now = relicValue(relic, o.refinement);
    const radiant = o.refinement === 'Radiant' ? now : relicValue(relic, 'Radiant');
    totals.value += now.solo * o.count;
    const entry: PlannedRelic = { name: relic.name, tier: relic.tier, refinement: o.refinement, count: o.count, vaulted: relic.vaulted, solo: now.solo, radshare: radiant.radshare, ducats: now.ducats, best: now.best };
    planned.push(entry);
    if (o.refinement !== 'Radiant') tips.push({ relic: entry, gain: radiant.solo - now.solo, traces: TRACES.Radiant - TRACES[o.refinement] });
  }
  return {
    open: planned.sort((a, b) => b.solo - a.solo || order(a, b)).slice(0, limit),
    refine: tips
      .filter((t) => t.gain >= 1)
      .sort((a, b) => b.gain / b.traces - a.gain / a.traces || b.gain - a.gain || order(a.relic, b.relic))
      .slice(0, limit),
    totals,
  };
}
