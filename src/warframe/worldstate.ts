// The parser's models use decorators that need the Reflect metadata polyfill loaded first.
import 'reflect-metadata';
import WorldStateParser from 'warframe-worldstate-parser';
import { toMs } from '../time.js';
import { apiFetch } from './fetch.js';

/** Official, cross-platform worldstate feed published by Digital Extremes. */
const WORLDSTATE_URL = 'https://api.warframe.com/cdn/worldState.php';
const CACHE_TTL_MS = 55_000;

export type WorldState = Awaited<ReturnType<typeof WorldStateParser.build>>;
export type Fissure = WorldState['fissures'][number];

const quietLogger = { debug: () => {} };

let cached: { at: number; ws: WorldState } | null = null;
let inflight: Promise<WorldState> | null = null;

async function fetchWorldState(): Promise<WorldState> {
  const res = await apiFetch(WORLDSTATE_URL);
  if (!res.ok) throw new Error(`Worldstate request failed: HTTP ${res.status}`);
  return WorldStateParser.build(await res.text(), { locale: 'en', logger: quietLogger });
}

/** Returns the parsed worldstate, cached briefly and de-duplicated across concurrent callers. */
export async function getWorldState(): Promise<WorldState> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ws;
  inflight ??= fetchWorldState()
    .then((ws) => {
      cached = { at: Date.now(), ws };
      return ws;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const FISSURE_TIERS = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'] as const;

export interface FissureFilter {
  tier?: string;
  steelPath?: boolean;
  storm?: boolean;
}

export function filterFissures(fissures: Fissure[], f: FissureFilter, now = Date.now()): Fissure[] {
  return fissures
    .filter((x) => toMs(x.expiry) > now)
    .filter((x) => !f.tier || x.tier.toLowerCase() === f.tier.toLowerCase())
    .filter((x) => f.steelPath === undefined || x.isHard === f.steelPath)
    .filter((x) => f.storm === undefined || x.isStorm === f.storm)
    .sort((a, b) => Number(a.tierNum) - Number(b.tierNum) || toMs(a.expiry) - toMs(b.expiry));
}

interface RewardLike {
  countedItems?: { count: number; type: string }[];
  items?: string[];
  credits?: number;
}

/** "3x Fieldron, Orokin Catalyst Blueprint, 5,000 cr" */
export function rewardText(r: RewardLike | undefined | null): string {
  if (!r) return '—';
  const parts = [
    ...(r.countedItems ?? []).map((c) => `${c.count}x ${c.type}`),
    ...(r.items ?? []),
    ...(r.credits ? [`${r.credits.toLocaleString('en-US')} cr`] : []),
  ];
  return parts.join(', ') || '—';
}

/** True while Baro Ki'Teer is at a relay (the worldstate keeps an entry even while he is away). */
export function isBaroHere(ws: WorldState, now = Date.now()): boolean {
  const t = ws.voidTrader;
  if (!t) return false;
  return toMs(t.activation) <= now && now < toMs(t.expiry) && (t.inventory?.length ?? 0) > 0;
}
