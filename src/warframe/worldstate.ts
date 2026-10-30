// Only the parser's types are used: the world state comes already parsed from warframestat.us, as JSON.
import type WorldStateParser from 'warframe-worldstate-parser';
import { readFile, writeFile } from 'node:fs/promises';
import { type TimeInput, toMs } from '../time.js';
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

/** warframestat.us sites that are web pages, not the data API (a pasted link to the docs or the hub is not a world state endpoint). */
const PAGE_HOSTS = new Set(['docs.warframestat.us', 'hub.warframestat.us', 'warframestat.us', 'www.warframestat.us']);

/** The configured URL when it can be a data endpoint; null for empty or a known web page (then the public API is used). */
export function usableFeedUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    if (PAGE_HOSTS.has(new URL(url).host.toLowerCase())) {
      console.warn(`[worldstate] WORLDSTATE_URL ${url} is a web page, not the data API: using ${STATS_BASE} instead. Clear the setting.`);
      return null;
    }
  } catch {
    return null;
  }
  return url;
}
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
let smartPoll = false;
let maxPollMs = 30 * 60_000;
let meta: MetaStore | null = null;
let cacheFile: string | null = null;
let lastCall: LastCall | null = null;

/**
 * Called once at startup from the config. The feed is called at most once per `intervalSeconds` (and the last call and
 * its raw answer survive restarts, so deploys don't cause extra calls).
 */
export function configureWorldState(opts: { url?: string | undefined; platform?: string; enabled: boolean; intervalSeconds?: number; smartPoll?: boolean; maxPollMinutes?: number; store?: MetaStore; cacheFile?: string }): void {
  const next = usableFeedUrl(opts.url) ?? feedUrlFor(opts.platform);
  // Another source (or platform) means the data held in memory is not its answer.
  if (next !== feedUrl) cached = null;
  feedUrl = next;
  enabled = opts.enabled;
  ttlMs = (opts.intervalSeconds ?? 600) * 1000;
  smartPoll = opts.smartPoll ?? false;
  maxPollMs = Math.max(ttlMs, (opts.maxPollMinutes ?? 30) * 60_000);
  if (cached) cached.due = dueFor(cached.ws, cached.at);
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
  const span = (mins: number) => (mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`);
  if (f.stale && f.at !== null) {
    return `Live data may be outdated: last updated ${span(Math.max(1, Math.round((now - f.at) / 60_000)))} ago, the world state source (warframestat.us) is not answering right now.`;
  }
  if (cached && cached.lag > SOURCE_LAG_MS) {
    return `The world state source (warframestat.us) was serving data ${span(Math.round(cached.lag / 60_000))} old when last checked, so the newest changes (new fissures, alerts, Duviri rotation) may be missing.`;
  }
  return null;
}

/** What the status page shows about the Warframe API: whether it is on, when it was last called and what came back. */
export function worldStateInfo(): { enabled: boolean; intervalSeconds: number; lastCallAt: number | null; lastOk: boolean | null; lastDetail: string | null; smart: boolean; maxMinutes: number; nextCallAt: number | null; sourceLagMs: number | null } {
  return {
    enabled,
    intervalSeconds: Math.round(ttlMs / 1000),
    lastCallAt: lastCall?.at ?? null,
    lastOk: lastCall?.ok ?? null,
    lastDetail: lastCall?.detail ?? null,
    smart: smartPoll,
    maxMinutes: Math.round(maxPollMs / 60_000),
    nextCallAt: lastCall?.ok ? (cached?.due ?? lastCall.at + ttlMs) : (lastCall?.retryAt ?? null),
    sourceLagMs: cached?.lag ?? null,
  };
}

let cached: { at: number; ws: WorldState; /** When the next call is due. */ due: number; /** How old the source's own data was when it was fetched (ms). */ lag: number } | null = null;
let inflight: Promise<WorldState> | null = null;

/** A short, secret-free description of an unexpected answer, for the error message and the status page. */
export function describeAnswer(text: string): string {
  let at = feedUrl;
  try {
    const u = new URL(feedUrl);
    at = `${u.host}${u.pathname}`;
  } catch {
    // Keep the raw text.
  }
  try {
    const data = JSON.parse(text) as unknown;
    if (data && typeof data === 'object') return `${at} answered JSON with ${Array.isArray(data) ? `a list of ${data.length}` : `the keys ${Object.keys(data).slice(0, 8).join(', ') || '(none)'}`}`;
    return `${at} answered JSON that is not an object`;
  } catch {
    return `${at} answered something that is not JSON: "${text.replace(/\s+/g, ' ').trim().slice(0, 80)}"`;
  }
}

/** The warframestat.us answer is the parsed world state as JSON; dates are ISO strings (every reader goes through `toMs`). */
function parse(text: string): WorldState {
  let data: Record<string, unknown> | null;
  try {
    data = JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object' || !data.cetusCycle || !Array.isArray(data.fissures)) {
    throw new Error(`Unexpected world state answer: ${describeAnswer(text)}. It must be the warframestat.us JSON (WORLDSTATE_URL has to point at a compatible server).`);
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

/** Rollovers that change what members see besides the fissures: the times the world state is worth refreshing for. Missing or odd values are skipped. */
function rolloverTimes(ws: WorldState, now: number): number[] {
  const w = ws as unknown as Record<string, unknown>;
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : v && typeof v === 'object' ? [v as Record<string, unknown>] : []);
  const out: number[] = [];
  for (const key of ['alerts', 'sortie', 'archonHunt', 'events', 'dailyDeals', 'zarimanCycle', 'duviriCycle', 'steelPath', 'syndicateMissions']) {
    for (const item of list(w[key])) out.push(toMs(item.expiry as never));
  }
  // Baro: when he arrives while he is away, when he leaves while he is here.
  for (const t of list(w.voidTrader)) out.push(toMs((toMs(t.activation as never) > now ? t.activation : t.expiry) as never));
  return out.filter((t) => Number.isFinite(t) && t > now);
}

/**
 * How long until the world state is worth fetching again, when smart polling is on: the soonest rollover (alerts, sortie, the
 * archon hunt, events, Baro, daily deals, Zariman and Duviri, Steel Path rotation, bounties) plus a short grace, but never sooner
 * than the normal poll interval and never later than the cap. Fissures are left out on purpose: there are dozens and one is
 * always about to end, which would mean polling at the minimum all the time; they are refreshed by the cap, and ones that have ended
 * are simply filtered out of what is shown in the meantime.
 */
export function nextRefreshDelay(ws: WorldState, now: number, opts: { minMs: number; maxMs: number; graceMs?: number }): number {
  const soonest = Math.min(Infinity, ...rolloverTimes(ws, now));
  const wanted = Number.isFinite(soonest) ? soonest - now + (opts.graceMs ?? 20_000) : opts.maxMs;
  return Math.min(opts.maxMs, Math.max(opts.minMs, wanted));
}

/** The source's data (its own `timestamp`) being this much older than the moment it was fetched means the source itself is lagging. */
export const SOURCE_LAG_MS = 20 * 60_000;

/** How old the source's data was when it was fetched at `at`; 0 when it has no timestamp. */
function lagOf(ws: WorldState, at: number): number {
  const ts = toMs((ws as unknown as { timestamp?: string }).timestamp as never);
  return Number.isFinite(ts) ? Math.max(0, at - ts) : 0;
}

/** When the answer fetched at `at` should be refreshed. */
const dueFor = (ws: WorldState, at: number): number => at + (smartPoll ? nextRefreshDelay(ws, at, { minMs: ttlMs, maxMs: maxPollMs }) : ttlMs);

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
  if (cached && now < cached.due) return cached.ws;
  // After a restart: the last answer was saved to disk, so it is served for as long as it is not due for a refresh.
  if (!cached && lastCall?.ok && cacheFile) {
    const saved = await readFile(cacheFile, 'utf8').then(parseOrNull, () => null);
    if (saved) {
      cached = { at: lastCall.at, ws: saved, due: dueFor(saved, lastCall.at), lag: lagOf(saved, lastCall.at) };
      if (now < cached.due) return saved;
    }
  }
  // Too soon after a failure: serve what we have, or repeat the failure.
  if (lastCall && !lastCall.ok && now < (lastCall.retryAt ?? lastCall.at + FAILURE_COOLDOWN_MS)) {
    if (cached) return cached.ws;
    throw new Error(lastCall.detail);
  }
  inflight ??= fetchWorldState()
    .then((ws) => {
      const at = Date.now();
      cached = { at, ws, due: dueFor(ws, at), lag: lagOf(ws, at) };
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

/**
 * What an alert is called. Event alerts (a recurring event's mission nodes) come with the feed's placeholder title "Event Alert Title",
 * which says nothing, so those are named by their mission type instead.
 */
export function alertName(a: { mission: { description?: string | null; type?: string | null } }): string {
  const title = a.mission.description?.trim();
  if (title && !/^event alert title$/i.test(title)) return title;
  return a.mission.type ? `Event mission (${a.mission.type})` : 'Event mission';
}

export interface AlertGroup {
  name: string;
  count: number;
  /** One place for a single alert; "Type at Node" for each of a folded group. */
  where: string[];
  reward: string;
  /** The soonest end of the group. */
  endsAt: TimeInput;
}

/**
 * Alerts for display. An event's endless resource missions all carry the same reward, so they are folded into one group;
 * real alerts stay one each.
 */
export function foldAlerts(alerts: WorldState['alerts']): AlertGroup[] {
  const groups: AlertGroup[] = [];
  const events = new Map<string, WorldState['alerts']>();
  for (const a of alerts ?? []) {
    const reward = rewardText(a.mission.reward);
    if (alertName(a).startsWith('Event mission')) events.set(reward, [...(events.get(reward) ?? []), a]);
    else groups.push({ name: alertName(a), count: 1, where: [a.mission.node], reward, endsAt: a.expiry });
  }
  for (const [reward, list] of events) {
    const first = list.reduce((soonest, a) => (toMs(a.expiry) < toMs(soonest.expiry) ? a : soonest));
    groups.push(
      list.length === 1
        ? { name: alertName(first), count: 1, where: [first.mission.node], reward, endsAt: first.expiry }
        : { name: `${list.length} event missions`, count: list.length, where: list.map((a) => `${a.mission.type ?? 'Mission'} at ${a.mission.node}`), reward, endsAt: first.expiry },
    );
  }
  return groups;
}

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

/** The `arbitration` entry of the warframestat.us world state (the parser's types do not know this field). */
export interface Arbitration {
  node?: string;
  type?: string;
  enemy?: string;
  archwing?: boolean;
  sharkwing?: boolean;
  expired?: boolean;
  activation?: Parameters<typeof toMs>[0];
  expiry?: Parameters<typeof toMs>[0];
}

/**
 * The arbitration that is running now, or null. When none runs the feed sends a placeholder (activation 1970, expired, node SolNode000),
 * so that, one that has ended and one that has not started are all null.
 */
export function activeArbitration(ws: WorldState, now = Date.now()): (Arbitration & { node: string; activation: NonNullable<Arbitration['activation']>; expiry: NonNullable<Arbitration['expiry']> }) | null {
  const a = (ws as { arbitration?: Arbitration }).arbitration;
  if (!a || a.expired || !a.node || a.node === 'SolNode000' || !a.activation || !a.expiry) return null;
  if (toMs(a.activation) <= 0 || toMs(a.activation) > now || toMs(a.expiry) <= now) return null;
  return a as ReturnType<typeof activeArbitration>;
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
