import { toMs } from '../time.js';
import { FISSURE_TIERS, type Fissure, type WorldState } from './worldstate.js';

/** Missions that crack a relic quickly: the fissure board marks them, the `/now` card and the "crack now" DMs list only these. */
export const FAST = /^(capture|extermination|sabotage|rescue|spy)$/i;

/** A fissure that closes sooner than this is not worth walking to. */
const MIN_LEFT_MS = 5 * 60_000;
const MAX_QUICK = 8;

/**
 * The quick fissures worth opening now (pure): per relic tier the one that stays open longest, normal ones before the Steel Path.
 * No Void Storms (Railjack), nothing that closes within `minLeftMs`.
 */
export function quickFissures(ws: Pick<WorldState, 'fissures'> | null, now: number, opts: { minLeftMs?: number; limit?: number } = {}): Fissure[] {
  const minLeft = opts.minLeftMs ?? MIN_LEFT_MS;
  const open = (ws?.fissures ?? []).filter((f) => !f.isStorm && FAST.test(f.missionType) && toMs(f.expiry) - now >= minLeft);
  const tiers: string[] = [...FISSURE_TIERS];
  const order = (tier: string) => (tiers.includes(tier) ? tiers.indexOf(tier) : tiers.length);
  const best = new Map<string, Fissure>();
  for (const f of open) {
    const key = `${f.isHard ? 1 : 0}:${f.tier}`;
    const held = best.get(key);
    if (!held || toMs(f.expiry) > toMs(held.expiry)) best.set(key, f);
  }
  return [...best.values()].sort((a, b) => Number(a.isHard) - Number(b.isHard) || order(a.tier) - order(b.tier)).slice(0, opts.limit ?? MAX_QUICK);
}
