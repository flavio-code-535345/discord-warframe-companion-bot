// The parser's models use decorators that need the Reflect metadata polyfill loaded first.
import 'reflect-metadata';
import WorldStateParser from 'warframe-worldstate-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { toMs } from '../time.js';
import { UserError } from '../services/clan.js';
import { apiFetch } from './fetch.js';

/** Official, cross-platform worldstate feed published by Digital Extremes. */
const DE_URL = 'https://api.warframe.com/cdn/worldState.php';
/** After a failed call (e.g. HTTP 403) the feed is left alone at least this long, so a block isn't made worse by retrying. */
const FAILURE_COOLDOWN_MS = 30 * 60_000;
const META_KEY = 'worldstate_last_call';

export type WorldState = Awaited<ReturnType<typeof WorldStateParser.build>>;
export type Fissure = WorldState['fissures'][number];

interface LastCall {
  at: number;
  ok: boolean;
  /** "HTTP 200", or the error message. */
  detail: string;
}

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

let feedUrl = DE_URL;
let enabled = true;
let ttlMs = 600_000;
let meta: MetaStore | null = null;
let cacheFile: string | null = null;
let lastCall: LastCall | null = null;

/**
 * Called once at startup from the config. The feed is called at most once per `intervalSeconds` (and the last call and
 * its raw answer survive restarts, so deploys don't cause extra calls).
 */
export function configureWorldState(opts: { url?: string | undefined; enabled: boolean; intervalSeconds?: number; store?: MetaStore; cacheFile?: string }): void {
  feedUrl = opts.url ?? DE_URL;
  enabled = opts.enabled;
  ttlMs = (opts.intervalSeconds ?? 600) * 1000;
  meta = opts.store ?? null;
  cacheFile = opts.cacheFile ?? null;
  try {
    lastCall = meta ? (JSON.parse(meta.getMeta(META_KEY) ?? 'null') as LastCall | null) : null;
  } catch {
    lastCall = null;
  }
}

export const worldStateEnabled = (): boolean => enabled;

/** What the status page shows about the Warframe API: whether it is on, when it was last called and what came back. */
export function worldStateInfo(): { enabled: boolean; intervalSeconds: number; lastCallAt: number | null; lastOk: boolean | null; lastDetail: string | null } {
  return { enabled, intervalSeconds: Math.round(ttlMs / 1000), lastCallAt: lastCall?.at ?? null, lastOk: lastCall?.ok ?? null, lastDetail: lastCall?.detail ?? null };
}

const quietLogger = { debug: () => {} };

let cached: { at: number; ws: WorldState } | null = null;
let inflight: Promise<WorldState> | null = null;

const parse = (text: string) => WorldStateParser.build(text, { locale: 'en', logger: quietLogger });

function record(call: LastCall): void {
  lastCall = call;
  try {
    meta?.setMeta(META_KEY, JSON.stringify(call));
  } catch {
    // The record is only for display and restart pacing.
  }
}

async function fetchWorldState(): Promise<WorldState> {
  try {
    const res = await apiFetch(feedUrl);
    if (!res.ok) throw new Error(`Worldstate request failed: HTTP ${res.status}`);
    const text = await res.text();
    const ws = await parse(text);
    record({ at: Date.now(), ok: true, detail: `HTTP ${res.status}` });
    if (cacheFile) await writeFile(cacheFile, text).catch(() => {});
    return ws;
  } catch (err) {
    record({ at: Date.now(), ok: false, detail: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Returns the parsed worldstate: at most one call to the feed per interval, shared by every caller and surviving restarts. */
export async function getWorldState(): Promise<WorldState> {
  if (!enabled) throw new UserError('Live Warframe world data is switched off right now (WORLDSTATE_ENABLED=false), so there are no fissures, alerts or cycles to show.');
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return cached.ws;
  // Too soon for another call: serve what we have (after a restart, the saved answer), or repeat the last failure.
  const wait = lastCall ? (lastCall.ok ? ttlMs : Math.max(FAILURE_COOLDOWN_MS, ttlMs)) : 0;
  if (lastCall && now - lastCall.at < wait) {
    if (cached) return cached.ws;
    if (lastCall.ok && cacheFile) {
      const saved = await readFile(cacheFile, 'utf8').then(parse, () => null);
      if (saved) {
        cached = { at: lastCall.at, ws: saved };
        return saved;
      }
    } else if (!lastCall.ok) throw new Error(lastCall.detail);
  }
  inflight ??= fetchWorldState()
    .then((ws) => {
      cached = { at: Date.now(), ws };
      return ws;
    })
    .catch((err: unknown) => {
      if (cached) {
        console.warn(`[worldstate] call failed (${(err as Error).message}); serving the data from ${Math.round((Date.now() - cached.at) / 60_000)} min ago`);
        return cached.ws;
      }
      throw err;
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
