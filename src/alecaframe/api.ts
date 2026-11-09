import { UserError } from '../services/clan.js';
import { ApiBlockedError, ApiBusyError, apiFetch } from '../warframe/fetch.js';
import type { Refinement } from '../warframe/relics.js';

/**
 * AlecaFrame's public stats API (stats.alecaframe.com: no key, one request per second per address, which the API client keeps). A member
 * links their own public-link token (AlecaFrame's Stats tab: Create Public Link, tick what to share, Generate token); Ordis then reads
 * their inventory history, their trades and, when the link shares them, their relics. Answers stay in memory for 10 minutes per token and
 * are never written to the database or the API cache, and the token is never logged (the client logs URLs without their query).
 */

const BASE = 'https://stats.alecaframe.com/api/stats/public';
const MEMO_MS = 10 * 60_000;
const MEMO_ENTRIES = 50;
/** AlecaFrame reports a bad token as a 500 with a problem+json `detail`: these statuses are answers to read, not failures to retry. */
const ANSWER = [400, 401, 404, 500] as const;

/** What a public link shares (AlecaFrame's PublicLinkParts flags). */
export const SHARES = { trades: 1, platinum: 2, ducats: 4, endo: 8, credits: 16, account: 32, aya: 64, relics: 128, vitus: 256 } as const;
export type Share = keyof typeof SHARES;

export const shares = (parts: number, what: Share): boolean => (parts & SHARES[what]) !== 0;
export const sharedList = (parts: number): Share[] => (Object.keys(SHARES) as Share[]).filter((k) => shares(parts, k));

export interface StatPoint {
  at: number;
  plat: number;
  credits: number;
  endo: number;
  ducats: number;
  aya: number;
  vitus: number | null;
  relicsOpened: number;
  trades: number;
  mr: number;
  /** Percent of the game's items mastered or owned, as AlecaFrame counts it. */
  completion: number;
}

export interface TradeItem {
  name: string;
  count: number;
  rank: number | null;
}

export type TradeKind = 'sale' | 'purchase' | 'trade';

export interface Trade {
  at: number;
  kind: TradeKind;
  /** The plat that changed hands, when AlecaFrame knows it. */
  plat: number | null;
  gave: TradeItem[];
  got: TradeItem[];
}

export interface AlecaStats {
  username: string | null;
  updatedAt: number | null;
  /** What the link shares (SHARES flags). */
  parts: number;
  /** Oldest first. */
  points: StatPoint[];
  /** Newest first. */
  trades: Trade[];
}

export type RelicTier = 'Lith' | 'Meso' | 'Neo' | 'Axi' | 'Requiem';

export interface OwnedRelic {
  tier: RelicTier;
  code: string;
  refinement: Refinement;
  count: number;
}

const TIERS: readonly RelicTier[] = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem'];
/** AlecaFrame's refinement byte: 0-3 the four refinements, 4-6 the same three refined ones again. */
const REFINEMENT_BYTE: readonly Refinement[] = ['Intact', 'Exceptional', 'Flawless', 'Radiant', 'Exceptional', 'Flawless', 'Radiant'];
const KINDS: readonly TradeKind[] = ['sale', 'purchase', 'trade'];

/** The token from what a member pasted: the token itself, or a link that carries it (`?token=` / `?publicToken=`). Null when neither. */
export function tokenFrom(input: string): string | null {
  const text = input.trim();
  const inLink = text.match(/[?&](?:public)?token=([^&#\s]+)/i);
  let token = text;
  if (inLink) {
    try {
      token = decodeURIComponent(inLink[1]!);
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9._~+/=-]{8,512}$/.test(token) ? token : null;
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};

function tradeItems(v: unknown): TradeItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x: Record<string, unknown>) => ({
      name: String(x?.displayName || x?.name || '').trim(),
      count: Math.max(1, int(x?.cnt)),
      rank: typeof x?.rank === 'number' && x.rank > 0 ? x.rank : null,
    }))
    // The plat itself is in the lists too; the trade's total says it once.
    .filter((x) => x.name && !/^platinum$/i.test(x.name));
}

/** AlecaFrame's PlayerStatsData as plain data (pure; anything missing becomes empty). */
export function parseStats(raw: unknown): AlecaStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  const points: StatPoint[] = [];
  for (const p of Array.isArray(r.generalDataPoints) ? (r.generalDataPoints as Record<string, unknown>[]) : []) {
    const at = time(p?.ts);
    if (at === null) continue;
    points.push({
      at,
      plat: int(p.plat),
      credits: int(p.credits),
      endo: int(p.endo),
      ducats: int(p.ducats),
      aya: int(p.aya),
      vitus: p.vitus === null || p.vitus === undefined ? null : int(p.vitus),
      relicsOpened: int(p.relicOpened),
      trades: int(p.trades),
      mr: int(p.mr),
      completion: int(p.percentageCompletion),
    });
  }
  const trades: Trade[] = [];
  for (const t of Array.isArray(r.trades) ? (r.trades as Record<string, unknown>[]) : []) {
    const at = time(t?.ts);
    if (at === null) continue;
    trades.push({
      at,
      kind: KINDS[int(t.type)] ?? 'trade',
      plat: typeof t.totalPlat === 'number' ? t.totalPlat : null,
      gave: tradeItems(t.tx),
      got: tradeItems(t.rx),
    });
  }
  return {
    username: typeof r.usernameWhenPublic === 'string' && r.usernameWhenPublic.trim() ? r.usernameWhenPublic.trim() : null,
    updatedAt: time(r.lastUpdate),
    parts: int(r.publicParts),
    points: points.sort((a, b) => a.at - b.at),
    trades: trades.sort((a, b) => b.at - a.at),
  };
}

/**
 * The relic inventory (pure): the API answers a JSON string of base64 holding a little-endian Uint32 count, then 9 bytes per relic (tier
 * byte, refinement byte, a 3-character code such as "A1" or "B21", Uint32 count). The same relic and refinement listed twice is merged.
 */
export function parseRelicInventory(body: string): OwnedRelic[] {
  let text = body.trim();
  if (text.startsWith('"')) text = String(JSON.parse(text));
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length < 4) return [];
  const declared = bytes.readUInt32LE(0);
  const merged = new Map<string, OwnedRelic>();
  for (let i = 0, o = 4; i < declared && o + 9 <= bytes.length; i++, o += 9) {
    const tier = TIERS[bytes[o]!];
    const refinement = REFINEMENT_BYTE[bytes[o + 1]!];
    const code = bytes.subarray(o + 2, o + 5).toString('latin1').replace(/[\0\s]+/g, '').toUpperCase();
    const count = bytes.readUInt32LE(o + 5);
    // Codes are "A1", "B21", or the Requiem relics' "I" to "IV".
    if (!tier || !refinement || !/^[A-Z0-9]{1,3}$/.test(code) || !count) continue;
    const key = `${tier} ${code} ${refinement}`;
    const known = merged.get(key);
    if (known) known.count += count;
    else merged.set(key, { tier, code, refinement, count });
  }
  return [...merged.values()];
}

/** What AlecaFrame's error answer means, for the member. */
function problemText(status: number, body: string): string {
  let detail = '';
  try {
    const p = JSON.parse(body) as { detail?: unknown; title?: unknown };
    detail = typeof p.detail === 'string' ? p.detail : '';
  } catch {
    // Not problem+json.
  }
  if (/invalid token/i.test(detail)) {
    return 'AlecaFrame says this token is not valid (it may have been revoked or be over a year old). In AlecaFrame open **Stats → Create Public Link**, tick what to share, press **Generate token**, and link the new one.';
  }
  if (detail) return `AlecaFrame couldn't answer: ${detail.slice(0, 200)}`;
  return status === 404 ? 'AlecaFrame has no stats for this token.' : `AlecaFrame couldn't answer right now (HTTP ${status}). Try again later.`;
}

const memo = new Map<string, { at: number; body: string }>();

async function call(path: string, param: string, token: string): Promise<string> {
  const key = `${path}|${token}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.body;
  let res: Response;
  try {
    res = await apiFetch(`${BASE}${path}?${param}=${encodeURIComponent(token)}`, { Accept: 'application/json' }, { answer: ANSWER });
  } catch (err) {
    if (err instanceof ApiBusyError) throw new UserError('AlecaFrame is answering other requests right now. Try again in a few seconds.');
    if (err instanceof ApiBlockedError) throw new UserError(`AlecaFrame asked Ordis to wait. Try again <t:${Math.ceil(err.until / 1000)}:R>.`);
    throw new UserError("AlecaFrame couldn't be reached right now. Try again later.");
  }
  const body = await res.text();
  if (!res.ok) throw new UserError(problemText(res.status, body));
  if (memo.size >= MEMO_ENTRIES) memo.delete(memo.keys().next().value!);
  memo.set(key, { at: Date.now(), body });
  return body;
}

/** A member's stats: inventory history, trades and what the link shares. Throws a UserError the member can act on. */
export async function fetchStats(token: string): Promise<AlecaStats> {
  const body = await call('', 'token', token);
  try {
    return parseStats(JSON.parse(body));
  } catch {
    throw new UserError("AlecaFrame's answer could not be read. Try again later.");
  }
}

/** A member's relics (the link must share them). */
export async function fetchRelics(token: string): Promise<OwnedRelic[]> {
  const body = await call('/getRelicInventory', 'publicToken', token);
  try {
    return parseRelicInventory(body);
  } catch {
    throw new UserError("AlecaFrame's relic list could not be read. Try again later.");
  }
}

/** Forgets what was read with a token (after unlinking, and in tests). */
export function forgetToken(token?: string): void {
  if (!token) return memo.clear();
  for (const key of [...memo.keys()]) if (key.endsWith(`|${token}`)) memo.delete(key);
}
