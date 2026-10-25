// The parser's models use decorators that need the Reflect metadata polyfill loaded first.
import 'reflect-metadata';
import WorldStateParser from 'warframe-worldstate-parser';
import { toMs } from '../time.js';
import { UserError } from '../services/clan.js';
import { apiFetch } from './fetch.js';

/** Official, cross-platform worldstate feed published by Digital Extremes. */
const DE_URL = 'https://api.warframe.com/cdn/worldState.php';
let feedUrl = DE_URL;
let enabled = true;

/** Called once at startup from the config: where to read the feed and whether to read it at all. */
export function configureWorldState(opts: { url?: string | undefined; enabled: boolean }): void {
  feedUrl = opts.url ?? DE_URL;
  enabled = opts.enabled;
}

export const worldStateEnabled = (): boolean => enabled;
const CACHE_TTL_MS = 55_000;
/** After a failed fetch the feed is left alone this long, so a block (HTTP 403) isn't made worse by hammering it. */
const FAILURE_COOLDOWN_MS = 5 * 60_000;

export type WorldState = Awaited<ReturnType<typeof WorldStateParser.build>>;
export type Fissure = WorldState['fissures'][number];

const quietLogger = { debug: () => {} };

let cached: { at: number; ws: WorldState } | null = null;
let inflight: Promise<WorldState> | null = null;
let failedAt = 0;
let lastError: Error | null = null;

async function fetchWorldState(): Promise<WorldState> {
  const res = await apiFetch(feedUrl);
  if (!res.ok) throw new Error(`Worldstate request failed: HTTP ${res.status}`);
  return WorldStateParser.build(await res.text(), { locale: 'en', logger: quietLogger });
}

/** Returns the parsed worldstate, cached briefly and de-duplicated across concurrent callers. */
export async function getWorldState(): Promise<WorldState> {
  if (!enabled) throw new UserError('Live Warframe world data is switched off right now (WORLDSTATE_ENABLED=false), so there are no fissures, alerts or cycles to show.');
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.ws;
  // While the feed is failing, serve the last good copy (stale beats nothing) or repeat the last error without a request.
  if (Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
    if (cached) return cached.ws;
    throw lastError ?? new Error('Worldstate is unavailable');
  }
  inflight ??= fetchWorldState()
    .then((ws) => {
      cached = { at: Date.now(), ws };
      failedAt = 0;
      return ws;
    })
    .catch((err: unknown) => {
      failedAt = Date.now();
      lastError = err instanceof Error ? err : new Error(String(err));
      if (cached) {
        console.warn(`[worldstate] fetch failed (${lastError.message}); serving the data from ${Math.round((Date.now() - cached.at) / 60_000)} min ago`);
        return cached.ws;
      }
      throw lastError;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const FISSURE_TIERS = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'] as const;

/** Invasion/alert rewards worth a clan's attention. */
export const NOTABLE_REWARD = /orokin (catalyst|reactor)|forma|exilus|wraith|vandal|umbra|aura/i;

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
  // Event rewards list most items twice: once counted, once plain. Keep the counted form.
  const counted = new Set((r.countedItems ?? []).map((c) => c.type.toLowerCase()));
  const parts = [
    ...(r.countedItems ?? []).map((c) => `${c.count}x ${c.type}`),
    ...(r.items ?? []).filter((i) => !counted.has(i.toLowerCase())),
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

const ARCHIMEDEA_NAMES: Record<string, string> = { CT_LAB: 'Deep Archimedea', CT_HEX: 'Temporal Archimedea' };
/** The parser spaces out camel-cased internal names ("C T_ L A B", "M P V Protea Prime Single Pack"). */
const despace = (s: string) => s.replace(/\s+/g, '');
export const archimedeaName = (type: string) => ARCHIMEDEA_NAMES[despace(type)] ?? type;
export const resurgenceItemName = (item: string) => item.replace(/^M P V /, '');

/**
 * Total standing for a bounty, or null when the stages aren't in standing units: Entrati jobs report
 * single-digit stage values that don't match in-game standing, so they're left out rather than shown wrong.
 */
export function bountyStanding(stages: number[] | undefined): number | null {
  const total = (stages ?? []).reduce((a, b) => a + b, 0);
  return total >= 100 ? total : null;
}
