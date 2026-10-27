import { toMs } from '../time.js';
import type { WorldState } from './worldstate.js';

/**
 * Open-world day/night cycles repeat on fixed schedules, so a cached world state never has to be wrong about them: when the
 * expiry it recorded has passed, the current phase is rolled forward locally instead of waiting for the next poll (or showing a
 * phase that ended minutes ago while the API is unreachable). Only the cycles with well-known fixed lengths are projected
 * (Cetus, Orb Vallis, Earth, Cambion Drift, which follows Cetus, and Zariman, which alternates Grineer and Corpus every 150 minutes); Duviri comes from the feed as it is.
 */

const MIN = 60_000;
/** Phase lengths: Cetus 100 min day + 50 min night; Orb Vallis 6 min 40 s warm + 20 min cold; Earth 4 h day + 4 h night. */
export const CETUS = { day: 100 * MIN, night: 50 * MIN };
export const VALLIS = { warm: 400_000, cold: 20 * MIN };
export const EARTH = { day: 240 * MIN, night: 240 * MIN };
export const ZARIMAN = { corpus: 150 * MIN, grineer: 150 * MIN };
/** Beyond this the recorded state is too old to trust a roll-forward. */
const MAX_PROJECT_MS = 7 * 24 * 3_600_000;

/** Rolls a two-phase cycle forward to `now`. `first` is the phase the cycle was in (true = the first of the pair). */
export function rollTwoPhase(first: boolean, expiry: number, firstLen: number, secondLen: number, now: number): { first: boolean; expiry: number; projected: boolean } {
  if (!Number.isFinite(expiry) || expiry > now || now - expiry > MAX_PROJECT_MS) return { first, expiry, projected: false };
  let cur = first;
  let exp = expiry;
  while (exp <= now) {
    cur = !cur;
    exp += cur ? firstLen : secondLen;
  }
  return { first: cur, expiry: exp, projected: true };
}

export interface ProjectedCycles {
  cetus: { isDay: boolean; expiry: number; projected: boolean };
  vallis: { isWarm: boolean; expiry: number; projected: boolean };
  earth: { isDay: boolean; expiry: number; projected: boolean };
  cambion: { state: string; expiry: number; projected: boolean };
  zariman: { state: 'corpus' | 'grineer'; expiry: number; projected: boolean };
}

export function projectCycles(ws: Pick<WorldState, 'cetusCycle' | 'vallisCycle' | 'earthCycle' | 'cambionCycle' | 'zarimanCycle'>, now = Date.now()): ProjectedCycles {
  const c = rollTwoPhase(ws.cetusCycle.isDay, toMs(ws.cetusCycle.expiry), CETUS.day, CETUS.night, now);
  const v = rollTwoPhase(ws.vallisCycle.isWarm, toMs(ws.vallisCycle.expiry), VALLIS.warm, VALLIS.cold, now);
  const e = rollTwoPhase(ws.earthCycle.isDay, toMs(ws.earthCycle.expiry), EARTH.day, EARTH.night, now);
  // A world state without Zariman data (an older answer, or a test fixture) is left alone rather than breaking the other cycles.
  const zc = (ws.zarimanCycle ?? { state: 'grineer', expiry: Number.NaN }) as { state?: string; isCorpus?: boolean; expiry: unknown };
  const zCorpus = String(zc.state).toLowerCase() === 'corpus' || zc.isCorpus === true;
  const z = rollTwoPhase(zCorpus, toMs(zc.expiry as never), ZARIMAN.corpus, ZARIMAN.grineer, now);
  // Cambion Drift is Fass while it is day on Cetus and Vome at night, ending together with it.
  const cambion = c.projected
    ? { state: c.first ? 'fass' : 'vome', expiry: c.expiry, projected: true }
    : { state: String(ws.cambionCycle.state), expiry: toMs(ws.cambionCycle.expiry), projected: false };
  return {
    cetus: { isDay: c.first, expiry: c.expiry, projected: c.projected },
    vallis: { isWarm: v.first, expiry: v.expiry, projected: v.projected },
    earth: { isDay: e.first, expiry: e.expiry, projected: e.projected },
    cambion,
    zariman: { state: z.first ? 'corpus' : 'grineer', expiry: z.expiry, projected: z.projected },
  };
}
