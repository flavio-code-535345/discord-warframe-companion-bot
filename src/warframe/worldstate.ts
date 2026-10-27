// Only the parser's types are used: the world state comes already parsed from warframestat.us, as JSON.
import type WorldStateParser from 'warframe-worldstate-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { toMs } from '../time.js';
import { UserError } from '../services/clan.js';
import { ApiBlockedError, api, apiFetch } from './fetch.js';

/**
 * The community warframestat.us API, which serves the parsed world state as JSON per platform. The bot never calls Digital
 * Extremes' own api.warframe.com: that is against their terms, and an IP that gets blocked there can't log in to the game either.
 */
const STATS_BASE = 'https://api.warframestat.us';
/** warframe.market platform names (the bot's WARFRAME_PLATFORM) to warframestat.us ones. */
const PLATFORM_PATH: Record<string, string> = { pc: 'pc', ps4: 'ps4', xbox: 'xb1', switch: 'swi' };
export const feedUrlFor = (platform = 'pc'): string => `${STATS_BASE}/${PLATFORM_PATH[platform] ?? 'pc'}`;
/** After a temporary failure the feed is left alone this long; a 403 or 429 pauses it for the cooldown / Retry-After the API client decided (see fetch.ts). */
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const META_KEY = 'worldstate_last_call';
const VALIDATORS_KEY = 'worldstate_validators';

export type WorldState = Awaited<ReturnType<typeof WorldStateParser.build>>;
export type Fissure = WorldState['fissures'][number];

interface LastCall {
  at: number;
  ok: boolean;
  /** "HTTP 200", or the error message. */
  detail: string;
  /** Not before this time is the feed called again (set after a failure). */
  retryAt?: number;
  /** Which feed the call went to, so a record of another source (an older version used DE's) is not held against this one. */
  url?: string;
}

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

let feedUrl = feedUrlFor();
let enabled = true;
let ttlMs = 600_000;
let meta: MetaStore | null = null;
let cacheFile: string | null = null;
let lastCall: LastCall | null = null;

/**
 * Called once at startup from the config. The feed is called at most once per `intervalSeconds` (and the last call and
 * its raw answer survive restarts, so deploys don't cause extra calls).
 */
export function configureWorldState(opts: { url?: string | undefined; platform?: string; enabled: boolean; intervalSeconds?: number; store?: MetaStore; cacheFile?: string }): void {
  const next = opts.url || feedUrlFor(opts.platform);
  // Another source (or platform) means the data held in memory is not its answer.
  if (next !== feedUrl) cached = null;
  feedUrl = next;
  enabled = opts.enabled;
  ttlMs = (opts.intervalSeconds ?? 600) * 1000;
  meta = opts.store ?? null;
  cacheFile = opts.cacheFile ?? null;
  try {
    lastCall = meta ? (JSON.parse(meta.getMeta(META_KEY) ?? 'null') as LastCall | null) : null;
  } catch {
    lastCall = null;
  }
  if (lastCall && lastCall.url !== feedUrl) {
    lastCall = null;
    cached = null;
  }
}

export const worldStateEnabled = (): boolean => enabled;

/** When the data being served was fetched, and whether it is outdated because the last call failed. */
export function worldStateFreshness(now = Date.now()): { at: number | null; stale: boolean } {
  const at = cached?.at ?? (lastCall?.ok ? lastCall.at : null);
  return { at, stale: Boolean(lastCall && !lastCall.ok && at !== null && now - at > ttlMs) };
}

/** A sentence for answers when the live data may be outdated (the API is unavailable), else null. */
export function worldStateStaleNote(now = Date.now()): string | null {
  const f = worldStateFreshness(now);
  if (!f.stale || f.at === null) return null;
  const mins = Math.max(1, Math.round((now - f.at) / 60_000));
  return `Live data may be outdated: last updated ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`} ago, the world state source (warframestat.us) is not answering right now.`;
}

/** The API client's view of the feed's host, for the status displays. */
export const feedHostBlockedMs = (): number => api.blockedFor(new URL(feedUrl).host);

/** What the status page shows about the Warframe API: whether it is on, when it was last called and what came back. */
export function worldStateInfo(): { enabled: boolean; intervalSeconds: number; lastCallAt: number | null; lastOk: boolean | null; lastDetail: string | null } {
  return { enabled, intervalSeconds: Math.round(ttlMs / 1000), lastCallAt: lastCall?.at ?? null, lastOk: lastCall?.ok ?? null, lastDetail: lastCall?.detail ?? null };
}

let cached: { at: number; ws: WorldState } | null = null;
let inflight: Promise<WorldState> | null = null;

/** The warframestat.us answer is the parsed world state as JSON; dates are ISO strings (every reader goes through `toMs`). */
function parse(text: string): WorldState {
  let data: Record<string, unknown> | null;
  try {
    data = JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || !data.cetusCycle || !Array.isArray(data.fissures)) {
    throw new Error('The world state source did not answer with the expected JSON (WORLDSTATE_URL must point at a warframestat.us-compatible server).');
  }
  return data as unknown as WorldState;
}

const parseOrNull = (text: string): WorldState | null => {
  try {
    return parse(text);
  } catch {
    return null;
  }
};

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
    // Ask only for what changed when the server gave validators last time (an unchanged feed answers 304 without a body).
    let validators: { etag?: string; lastModified?: string; url?: string } = {};
    try {
      validators = JSON.parse(meta?.getMeta(VALIDATORS_KEY) ?? '{}') as typeof validators;
    } catch {
      validators = {};
    }
    const usable = validators.url === feedUrl && (validators.etag || validators.lastModified);
    const saved = cacheFile && usable ? await readFile(cacheFile, 'utf8').catch(() => null) : null;
    const conditional: Record<string, string> = saved ? (validators.etag ? { 'If-None-Match': validators.etag } : { 'If-Modified-Since': validators.lastModified! }) : {};
    const res = await apiFetch(feedUrl, conditional);
    if (res.status === 304 && saved) {
      const ws = parse(saved);
      record({ at: Date.now(), ok: true, detail: 'HTTP 304 (unchanged)', url: feedUrl });
      return ws;
    }
    if (!res.ok) throw new Error(`Worldstate request failed: HTTP ${res.status}`);
    const text = await res.text();
    const ws = parse(text);
    record({ at: Date.now(), ok: true, detail: `HTTP ${res.status}`, url: feedUrl });
    try {
      meta?.setMeta(VALIDATORS_KEY, JSON.stringify({ etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined, url: feedUrl }));
    } catch {
      // Validators only save bandwidth.
    }
    if (cacheFile) await writeFile(cacheFile, text).catch(() => {});
    return ws;
  } catch (err) {
    const now = Date.now();
    // A 403 or 429 already put the host on hold in the API client; remember when it may be called again.
    record({ at: now, ok: false, detail: err instanceof Error ? err.message : String(err), retryAt: err instanceof ApiBlockedError ? err.until : now + FAILURE_COOLDOWN_MS, url: feedUrl });
    throw err;
  }
}

/** Returns the parsed worldstate: at most one call to the feed per interval, shared by every caller and surviving restarts. */
export async function getWorldState(): Promise<WorldState> {
  if (!enabled) throw new UserError('Live Warframe world data is switched off right now (WORLDSTATE_ENABLED=false), so there are no fissures, alerts or cycles to show.');
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return cached.ws;
  // Too soon for another call: serve what we have (after a restart, the saved answer), or repeat the last failure.
  const wait = lastCall ? (lastCall.ok ? ttlMs : Math.max((lastCall.retryAt ?? lastCall.at + FAILURE_COOLDOWN_MS) - lastCall.at, 0)) : 0;
  if (lastCall && now - lastCall.at < wait) {
    if (cached) return cached.ws;
    if (lastCall.ok && cacheFile) {
      const saved = await readFile(cacheFile, 'utf8').then(parseOrNull, () => null);
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
