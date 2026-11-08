import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { toMs } from '../time.js';
import { type ApiClient, api } from './fetch.js';
import { type WorldState, activeArbitration } from './worldstate.js';

/**
 * The Arbitration schedule, hours and days ahead. The game picks each hour's Arbitration from a seeded rotation, which the browse.wf
 * project (calamity-inc, MIT licence) publishes as https://browse.wf/arbys.txt: one line per hour, `unixSeconds,NodeId`, years
 * ahead. The tiers (S best … F worst, how good the node is to farm) are the Arbitration Goons' list (arbi.guide) from the same
 * project; a node that list doesn't rank is F. Names, mission types and factions come from warframe-worldstate-data's solNodes.json,
 * a file in node_modules, so drawing the schedule makes no request.
 *
 * Both files are fetched through the shared ApiClient as background work, cached as `stable` data (revalidated with ETag twice a
 * day, about 1 MB once, then a 304), and served stale when browse.wf can't be reached. The world state's own `arbitration` entry
 * is the check: when it names another node than the schedule (the rotation was reseeded once before), `scheduleTrusted` is false
 * and the schedule is not shown until a new download agrees.
 */

export const SCHEDULE_URL = 'https://browse.wf/arbys.txt';
export const TIERS_URL = 'https://raw.githubusercontent.com/calamity-inc/browse.wf/senpai/supplemental-data/arbyTiers.js';
const REFRESH_MS = 12 * 3_600_000;
const HOUR_MS = 3_600_000;

export type ArbyTier = 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
export const TIERS: readonly ArbyTier[] = ['S', 'A', 'B', 'C', 'D', 'F'];
/** True when `tier` is `min` or better (S is best). */
export const atLeast = (tier: ArbyTier, min: ArbyTier): boolean => TIERS.indexOf(tier) <= TIERS.indexOf(min);

export interface NodeInfo {
  /** "Casta (Ceres)" */
  node: string;
  /** "Casta" */
  name: string;
  /** "Ceres" */
  planet: string;
  /** "Defense"; a dark sector's "Dark Sector Defection" is just "Defection". */
  mission: string;
  /** "Grineer", "The Murmur", "Crossfire" */
  faction: string;
}

export interface ArbitrationSlot extends NodeInfo {
  nodeKey: string;
  start: number;
  end: number;
  tier: ArbyTier;
}

type SolNodes = Record<string, { value?: string; enemy?: string; type?: string }>;
let solNodes: SolNodes | null = null;

/** The node table, read once from the package's own data file (the package's default export loads every locale, ~28 MB). */
function nodes(): SolNodes {
  if (!solNodes) {
    try {
      const entry = createRequire(import.meta.url).resolve('warframe-worldstate-data');
      solNodes = JSON.parse(readFileSync(join(dirname(entry), 'data', 'solNodes.json'), 'utf8')) as SolNodes;
    } catch (err) {
      console.warn('[arbitration] could not read the node table:', (err as Error).message);
      solNodes = {};
    }
  }
  return solNodes;
}

export function nodeInfo(key: string, table: SolNodes = nodes()): NodeInfo {
  const n = table[key];
  const node = n?.value ?? key;
  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(node);
  return {
    node,
    name: m?.[1] ?? node,
    planet: m?.[2] ?? '',
    mission: (n?.type ?? 'Unknown').replace(/^Dark Sector\s+/i, ''),
    faction: n?.enemy ?? '',
  };
}

/** The tier list: a JS file of `NodeId: "S",` lines. */
export function parseTiers(js: string): Map<string, ArbyTier> {
  const tiers = new Map<string, ArbyTier>();
  for (const m of js.matchAll(/(\w+)\s*:\s*["']([SABCDF])["']/g)) tiers.set(m[1]!, m[2] as ArbyTier);
  return tiers;
}

/** The hourly rotation, kept compact (44,000 hours to 2029 in a few hundred KB): start times in seconds and an index into the node ids. */
export class ArbitrationSchedule {
  private constructor(
    private readonly starts: Uint32Array,
    private readonly nodeIndex: Uint16Array,
    private readonly keys: string[],
  ) {}

  static parse(text: string): ArbitrationSchedule {
    const keys: string[] = [];
    const ids = new Map<string, number>();
    const rows: [number, number][] = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(\d{9,11})\s*,\s*(\w+)\s*$/.exec(line);
      if (!m) continue;
      let id = ids.get(m[2]!);
      if (id === undefined) {
        id = keys.push(m[2]!) - 1;
        ids.set(m[2]!, id);
      }
      rows.push([Number(m[1]), id]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    return new ArbitrationSchedule(Uint32Array.from(rows, (r) => r[0]), Uint16Array.from(rows, (r) => r[1]), keys);
  }

  get size(): number {
    return this.starts.length;
  }

  /** When the last known hour starts (ms), so a schedule running out can be noticed long before it does. */
  get lastStart(): number {
    return this.size ? this.starts[this.size - 1]! * 1000 : 0;
  }

  /** The index of the hour running at `ms`, or -1 before the first one. */
  private indexAt(ms: number): number {
    const s = Math.floor(ms / 1000);
    let lo = 0;
    let hi = this.size - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid]! <= s) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  /** Every slot that overlaps [from, to): the one running at `from` first. */
  slots(from: number, to: number, tiers: Map<string, ArbyTier>, table?: SolNodes): ArbitrationSlot[] {
    const out: ArbitrationSlot[] = [];
    for (let i = Math.max(0, this.indexAt(from)); i < this.size; i++) {
      const start = this.starts[i]! * 1000;
      if (start >= to) break;
      // A gap in the file (it has none, but a truncated download might) never stretches one slot over hours.
      const end = Math.min(i + 1 < this.size ? this.starts[i + 1]! * 1000 : start + HOUR_MS, start + HOUR_MS);
      if (end <= from) continue;
      const nodeKey = this.keys[this.nodeIndex[i]!]!;
      out.push({ nodeKey, start, end, tier: tiers.get(nodeKey) ?? 'F', ...nodeInfo(nodeKey, table) });
    }
    return out;
  }
}

export interface ArbitrationData {
  schedule: ArbitrationSchedule;
  tiers: Map<string, ArbyTier>;
  /** The schedule was served from the cache because browse.wf couldn't be reached. */
  stale: boolean;
  fetchedAt: number;
}

let parsed: { body: string; schedule: ArbitrationSchedule } | null = null;
let parsedTiers: { body: string; tiers: Map<string, ArbyTier> } | null = null;

/** The schedule and tiers (cached; a request only every 12 hours, and a 304 when nothing changed). Null when neither was ever read. */
export async function loadArbitrations(client: Pick<ApiClient, 'get'> = api): Promise<ArbitrationData | null> {
  const [sched, tiers] = await Promise.all([
    client.get(SCHEDULE_URL, { kind: 'stable', ttlMs: REFRESH_MS, background: true }).catch((err: unknown) => {
      console.warn('[arbitration] could not read the schedule:', (err as Error).message);
      return null;
    }),
    client.get(TIERS_URL, { kind: 'stable', ttlMs: REFRESH_MS, background: true }).catch((err: unknown) => {
      console.warn('[arbitration] could not read the tier list:', (err as Error).message);
      return null;
    }),
  ]);
  if (sched && sched.status === 200 && sched.body !== parsed?.body) {
    const schedule = ArbitrationSchedule.parse(sched.body);
    // A page that is not the schedule (a proxy error with HTTP 200) must not replace a good one.
    if (schedule.size > 1000) parsed = { body: sched.body, schedule };
  }
  if (tiers && tiers.status === 200 && tiers.body !== parsedTiers?.body) {
    const map = parseTiers(tiers.body);
    // An error page has no `Node: "S"` lines at all; the real list ranks about 40 nodes.
    if (map.size >= 3) parsedTiers = { body: tiers.body, tiers: map };
  }
  if (!parsed) return null;
  last = { schedule: parsed.schedule, tiers: parsedTiers?.tiers ?? new Map(), stale: Boolean(sched?.stale) || !sched, fetchedAt: sched?.fetchedAt ?? 0 };
  return last;
}

let last: ArbitrationData | null = null;

/** What the last `loadArbitrations` gave, without a request (a button has three seconds to answer). */
export const lastArbitrations = (): ArbitrationData | null => last;

/** Test hook. */
export const resetArbitrations = () => {
  parsed = parsedTiers = last = null;
};

export interface ArbitrationView {
  /** The one running now, from the schedule (or the world state when the schedule has nothing for this hour). */
  current: ArbitrationSlot | null;
  /** Every slot from the next hour to `hours` ahead. */
  upcoming: ArbitrationSlot[];
  /** The slots of `bestTier` or better from the next hour to `bestDays` ahead (the week's best). */
  best: ArbitrationSlot[];
  /** False when the live world state named another node than the schedule: then only `current` (from the world state) is shown. */
  scheduleTrusted: boolean;
  stale: boolean;
}

export interface ViewOptions {
  hours?: number;
  bestDays?: number;
  bestTier?: ArbyTier;
}

/** What the board, the trackers and the status page show: now, the hours ahead, and the best of the week. */
export function arbitrationView(data: ArbitrationData | null, ws: WorldState | null, now: number, opts: ViewOptions = {}): ArbitrationView {
  const hours = opts.hours ?? 48;
  const live = ws ? activeArbitration(ws, now) : null;
  const slots = data ? data.schedule.slots(now, now + hours * HOUR_MS, data.tiers) : [];
  const scheduled = slots[0] && slots[0].start <= now ? slots[0] : null;
  const liveKey = live ? ((live as { nodeKey?: string }).nodeKey ?? null) : null;
  const liveSlot = (): ArbitrationSlot | null => {
    if (!live) return null;
    const key = liveKey ?? '';
    const info = key ? nodeInfo(key) : null;
    return {
      nodeKey: key,
      start: toMs(live.activation),
      end: toMs(live.expiry),
      tier: (key && data?.tiers.get(key)) || 'F',
      node: info?.node ?? live.node,
      name: info?.name ?? live.node,
      planet: info?.planet ?? '',
      mission: live.type ?? info?.mission ?? 'Unknown',
      faction: live.enemy ?? info?.faction ?? '',
    };
  };
  // The live entry names the node by key (`nodeKey`) or by its name; either has to match the schedule's hour.
  const agrees = !live || !scheduled || liveKey === scheduled.nodeKey || live.node === scheduled.node;
  if (!agrees) return { current: liveSlot(), upcoming: [], best: [], scheduleTrusted: false, stale: Boolean(data?.stale) };
  const min = opts.bestTier ?? 'A';
  const best = data ? data.schedule.slots(now, now + (opts.bestDays ?? 7) * 24 * HOUR_MS, data.tiers).filter((s) => s.start > now && atLeast(s.tier, min)) : [];
  return {
    current: scheduled ?? liveSlot(),
    upcoming: slots.filter((s) => s.start > now),
    best,
    scheduleTrusted: Boolean(data),
    stale: Boolean(data?.stale),
  };
}

/** The slot running at `now` from the schedule alone (trackers and pings; the board cross-checks with the world state). */
export function slotAt(data: ArbitrationData | null, now: number): ArbitrationSlot | null {
  const first = data?.schedule.slots(now, now + 1, data.tiers)[0];
  return first && first.start <= now ? first : null;
}
