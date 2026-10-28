// warframe.market sits behind Cloudflare, which answers Node's default User-Agent with a 403 challenge page.
const USER_AGENT = 'cephalon-ordis/1.0 (Discord bot for the Warframe clan The Rats Den 69)';

/**
 * The one place every third-party Warframe API call goes through (warframestat.us, warframe.market, the wiki, and the
 * warframestat.us world state). It gives every command the same rules:
 *
 *  - Rate limiting: a minimum gap between requests to the same host, and a global requests-per-minute cap. Background work
 *    (the wiki crawler) may only use half of that cap, so it can never starve a member's command.
 *  - 429: the host is left alone for the `Retry-After` time (default 30 s), no retry.
 *  - 403 (an IP block or access restriction): the host is left alone for the configured cooldown, no retry.
 *  - Temporary failures (5xx, timeouts, network errors): a few retries with exponential backoff and jitter.
 *  - `apiGet`/`apiJson` add a response cache (memory in front of the bot's SQLite database) with per-kind lifetimes,
 *    conditional requests (ETag / Last-Modified), one shared request for identical concurrent calls, and stale data
 *    (clearly flagged) when the API is unreachable, blocked or limited.
 *
 * Nothing here rotates addresses or retries a blocked request. Requests are logged without headers or credentials.
 */

export type CacheKind = 'live' | 'price' | 'stable';

export interface ApiLimits {
  /** Minimum time between two requests to the same host. */
  minIntervalMs: number;
  /** Requests per minute across all hosts. */
  perMinute: number;
  /** How long a host is left alone after a 403. */
  cooldownMs: number;
  maxRetries: number;
  /** Cache lifetimes. `live` is chosen by the caller (the world state poll interval). */
  priceTtlMs: number;
  stableTtlMs: number;
}

export const DEFAULT_LIMITS: ApiLimits = {
  minIntervalMs: 500,
  perMinute: 60,
  cooldownMs: 30 * 60_000,
  maxRetries: 2,
  priceTtlMs: 120_000,
  stableTtlMs: 24 * 3_600_000,
};

/** How old cached data may be when it is served because the API cannot be used. */
const MAX_STALE_MS: Record<CacheKind, number> = { live: 6 * 3_600_000, price: 3_600_000, stable: 30 * 24 * 3_600_000 };
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_QUEUE_WAIT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 15 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const MEMORY_ENTRIES = 300;
const MAX_STORED_BYTES = 1_500_000;
const PRUNE_AFTER_MS = 30 * 24 * 3_600_000;

/** The host is off limits for now (cooldown after a 403, or a 429's Retry-After). No request was made. */
export class ApiBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly until: number,
    readonly reason: string,
  ) {
    super(`${host} is not being called until ${new Date(until).toISOString().slice(11, 16)} UTC (${reason})`);
    this.name = 'ApiBlockedError';
  }
}

/** Too many requests are queued right now; try again in a moment. */
export class ApiBusyError extends Error {
  constructor() {
    super('Too many requests to the Warframe APIs right now; try again in a moment.');
    this.name = 'ApiBusyError';
  }
}

export class ApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly host: string,
  ) {
    super(`${host} answered HTTP ${status}`);
    this.name = 'ApiHttpError';
  }
}

export interface CacheEntry {
  body: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
}

/** The slice of the database this needs (the Store implements it). */
export interface ApiCacheStore {
  getApiCache(key: string): CacheEntry | null;
  putApiCache(key: string, entry: CacheEntry): void;
  pruneApiCache(before: number): void;
}

export interface ApiResult {
  body: string;
  status: number;
  fetchedAt: number;
  /** Served from the cache because the API could not be used: the data may be outdated. */
  stale: boolean;
  source: 'cache' | 'network' | 'revalidated' | 'stale';
}

export interface ApiStats {
  requests: number;
  cacheHits: number;
  deduped: number;
  revalidated: number;
  staleServed: number;
  rateLimited: number;
  blocked: number;
  retries: number;
  failures: number;
}

export interface ApiDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: (line: string) => void;
  warn: (line: string) => void;
}

const realDeps: ApiDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
  log: (l) => console.log(l),
  warn: (l) => console.warn(l),
};

/** An answer we are not going to read: frees its connection instead of leaving the body to the garbage collector. */
const discard = (res: Response): void => void res.body?.cancel().catch(() => {});

/** What JSON from these APIs starts with (an object, a list, or a bare value); a page of HTML or plain text does not. */
const JSON_START = /^\s*(?:[{["]|-?\d|true\b|false\b|null\b)/;

/** Retry-After as milliseconds (it is either seconds or an HTTP date), or null. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const shortUrl = (u: URL) => `${u.host}${u.pathname}${u.search ? '?…' : ''}`.slice(0, 90);

export class ApiClient {
  limits: ApiLimits = { ...DEFAULT_LIMITS };
  readonly stats: ApiStats = { requests: 0, cacheHits: 0, deduped: 0, revalidated: 0, staleServed: 0, rateLimited: 0, blocked: 0, retries: 0, failures: 0 };
  private readonly blockedUntil = new Map<string, { until: number; reason: string }>();
  private readonly nextSlot = new Map<string, number>();
  private window: number[] = [];
  private readonly memory = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<ApiResult>>();
  private store: ApiCacheStore | null = null;
  private lastPrune = 0;
  private readonly deps: ApiDeps;

  constructor(deps: Partial<ApiDeps> = {}) {
    this.deps = { ...realDeps, ...deps };
  }

  configure(opts: { limits?: Partial<ApiLimits>; store?: ApiCacheStore | null }): void {
    if (opts.limits) this.limits = { ...this.limits, ...opts.limits };
    if (opts.store !== undefined) this.store = opts.store;
  }

  /** Hosts currently left alone, for the panel. */
  cooldowns(): { host: string; until: number; reason: string }[] {
    const now = this.deps.now();
    return [...this.blockedUntil.entries()].filter(([, b]) => b.until > now).map(([host, b]) => ({ host, ...b }));
  }

  /** Time left on a host's cooldown (0 when it can be called). */
  blockedFor(host: string): number {
    return Math.max(0, (this.blockedUntil.get(host)?.until ?? 0) - this.deps.now());
  }

  // --- rate limiting ---

  /** Waits for this request's turn: the host's minimum gap, then room in the global per-minute window. */
  private async takeSlot(host: string, background: boolean): Promise<void> {
    const { now } = this.deps;
    const t = now();
    const cap = background ? Math.max(1, Math.floor(this.limits.perMinute / 2)) : this.limits.perMinute;
    this.window = this.window.filter((at) => at > t - 60_000);
    let start = Math.max(t, this.nextSlot.get(host) ?? 0);
    // The window is a list of reserved start times; if it is full, this request starts when the oldest one leaves it.
    const recent = this.window.filter((at) => at > start - 60_000);
    if (recent.length >= cap) start = Math.max(start, recent[recent.length - cap]! + 60_000);
    if (start - t > MAX_QUEUE_WAIT_MS) throw new ApiBusyError();
    this.nextSlot.set(host, start + this.limits.minIntervalMs);
    this.window.push(start);
    this.window.sort((a, b) => a - b);
    if (start > t) await this.deps.sleep(start - t);
  }

  private backoff(attempt: number): number {
    return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt) * (0.5 + this.deps.random() * 0.5);
  }

  private block(host: string, ms: number, reason: string): ApiBlockedError {
    const until = this.deps.now() + ms;
    this.blockedUntil.set(host, { until, reason });
    return new ApiBlockedError(host, until, reason);
  }

  /** One rate-limited request with retries. Returns any response that is not a rate limit, block or server failure (404 and 304 included). */
  async send(url: string, headers: Record<string, string> = {}, opts: { background?: boolean; scope?: string } = {}): Promise<Response> {
    const u = new URL(url);
    // A scope gives one feature its own gap and its own cooldown on the host, so a 403 or 429 on an experimental endpoint can't take
    // the host's other calls (prices) down with it. The global per-minute window is shared either way.
    const host = opts.scope ? `${u.host}#${opts.scope}` : u.host;
    for (let attempt = 0; ; attempt++) {
      const wait = this.blockedFor(host);
      if (wait > 0) {
        this.stats.blocked++;
        const b = this.blockedUntil.get(host)!;
        throw new ApiBlockedError(host, b.until, b.reason);
      }
      await this.takeSlot(host, Boolean(opts.background));
      const t0 = this.deps.now();
      this.stats.requests++;
      let res: Response;
      try {
        res = await this.deps.fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.deps.warn(`[api] GET ${shortUrl(u)} failed: ${why}${attempt < this.limits.maxRetries ? ' (retrying)' : ''}`);
        if (attempt < this.limits.maxRetries) {
          this.stats.retries++;
          await this.deps.sleep(this.backoff(attempt));
          continue;
        }
        this.stats.failures++;
        throw err;
      }
      this.deps.log(`[api] GET ${shortUrl(u)} -> HTTP ${res.status} (${this.deps.now() - t0} ms)`);
      if (res.status === 429) {
        discard(res);
        this.stats.rateLimited++;
        const ms = Math.min(MAX_RETRY_AFTER_MS, parseRetryAfter(res.headers.get('retry-after'), this.deps.now()) ?? DEFAULT_RETRY_AFTER_MS);
        const err = this.block(host, ms, 'rate limited (429)');
        this.deps.warn(`[api] ${host} rate limited us (429): leaving it alone for ${Math.round(ms / 1000)} s`);
        throw err;
      }
      if (res.status === 403) {
        discard(res);
        const err = this.block(host, this.limits.cooldownMs, 'access forbidden (403)');
        this.deps.warn(`[api] ${host} answered 403 (blocked?): no more requests to it for ${Math.round(this.limits.cooldownMs / 60_000)} min`);
        throw err;
      }
      if (res.status >= 500 || res.status === 408) {
        discard(res);
        if (attempt < this.limits.maxRetries) {
          this.stats.retries++;
          await this.deps.sleep(this.backoff(attempt));
          continue;
        }
        this.stats.failures++;
        throw new ApiHttpError(res.status, host);
      }
      return res;
    }
  }

  // --- cached GET ---

  private ttlFor(kind: CacheKind, ttlMs?: number): number {
    return ttlMs ?? (kind === 'price' ? this.limits.priceTtlMs : kind === 'stable' ? this.limits.stableTtlMs : 600_000);
  }

  private readEntry(key: string): CacheEntry | null {
    const mem = this.memory.get(key);
    if (mem) return mem;
    const stored = this.store?.getApiCache(key) ?? null;
    if (stored) this.remember(key, stored);
    return stored;
  }

  private remember(key: string, entry: CacheEntry): void {
    if (this.memory.size >= MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
    this.memory.set(key, entry);
  }

  private writeEntry(key: string, entry: CacheEntry): void {
    this.remember(key, entry);
    if (!this.store || entry.body.length > MAX_STORED_BYTES) return;
    try {
      this.store.putApiCache(key, entry);
      const now = this.deps.now();
      if (now - this.lastPrune > 3_600_000) {
        this.lastPrune = now;
        this.store.pruneApiCache(now - PRUNE_AFTER_MS);
      }
    } catch (err) {
      this.deps.warn(`[api] could not save a response to the cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A cached GET. Fresh data is returned without a request; identical calls in flight share one request; an expired entry is
   * re-checked with If-None-Match / If-Modified-Since when the server gave one; and when the API cannot be used (blocked,
   * limited, down) an expired entry is returned with `stale: true` instead of an error, within the kind's maximum age.
   */
  get(url: string, opts: { kind: CacheKind; ttlMs?: number; headers?: Record<string, string>; background?: boolean; scope?: string; json?: boolean }): Promise<ApiResult> {
    const headers = opts.headers ?? {};
    const key = `${url}|${Object.entries(headers).sort().map(([k, v]) => `${k}=${v}`).join('&')}`;
    const now = this.deps.now();
    const entry = this.readEntry(key);
    const ttl = this.ttlFor(opts.kind, opts.ttlMs);
    if (entry && now - entry.fetchedAt < ttl) {
      this.stats.cacheHits++;
      this.deps.log(`[api] cache hit ${shortUrl(new URL(url))} (${Math.round((now - entry.fetchedAt) / 1000)} s old)`);
      return Promise.resolve({ body: entry.body, status: entry.status, fetchedAt: entry.fetchedAt, stale: false, source: 'cache' });
    }
    const running = this.inflight.get(key);
    if (running) {
      this.stats.deduped++;
      return running;
    }
    const p = this.refresh(url, key, headers, entry, opts.kind, { background: opts.background, scope: opts.scope }, Boolean(opts.json)).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh(url: string, key: string, headers: Record<string, string>, entry: CacheEntry | null, kind: CacheKind, sendOpts: { background?: boolean | undefined; scope?: string | undefined }, jsonOnly: boolean): Promise<ApiResult> {
    const conditional: Record<string, string> = {};
    if (entry?.etag) conditional['If-None-Match'] = entry.etag;
    else if (entry?.lastModified) conditional['If-Modified-Since'] = entry.lastModified;
    try {
      const res = await this.send(url, { ...headers, ...conditional }, sendOpts);
      const now = this.deps.now();
      if (res.status === 304 && entry) {
        const fresh = { ...entry, fetchedAt: now };
        this.writeEntry(key, fresh);
        this.stats.revalidated++;
        return { body: fresh.body, status: fresh.status, fetchedAt: now, stale: false, source: 'revalidated' };
      }
      const body = await res.text();
      // A maintenance or proxy page answered with 200 is not data: saved, it would be served (and fail to parse) for the whole lifetime of the kind.
      // It counts as a failure instead, so the previous answer is used while it is still young enough, and the next call asks again.
      if (res.ok && jsonOnly && !JSON_START.test(body)) throw new Error(`${new URL(url).host} answered HTTP ${res.status} with something that is not JSON`);
      // Only successful answers are saved: a 404 or any other error page is never reused as if it were data.
      if (res.ok) this.writeEntry(key, { body, status: res.status, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), fetchedAt: now });
      return { body, status: res.status, fetchedAt: now, stale: false, source: 'network' };
    } catch (err) {
      if (entry && this.deps.now() - entry.fetchedAt <= MAX_STALE_MS[kind]) {
        this.stats.staleServed++;
        this.deps.warn(`[api] serving ${shortUrl(new URL(url))} from ${Math.round((this.deps.now() - entry.fetchedAt) / 60_000)} min ago: ${err instanceof Error ? err.message : String(err)}`);
        return { body: entry.body, status: entry.status, fetchedAt: entry.fetchedAt, stale: true, source: 'stale' };
      }
      throw err;
    }
  }

  /** Test hook: forget everything held in memory and any cooldown. */
  reset(): void {
    this.memory.clear();
    this.inflight.clear();
    this.blockedUntil.clear();
    this.nextSlot.clear();
    this.window = [];
    for (const k of Object.keys(this.stats) as (keyof ApiStats)[]) this.stats[k] = 0;
  }
}

/** The bot's shared client. */
export const api = new ApiClient();

export function configureApi(opts: { limits?: Partial<ApiLimits>; store?: ApiCacheStore | null }): void {
  api.configure(opts);
}

/** A rate-limited fetch (no caching) for callers that handle their own: world state, the wiki crawler. */
export function apiFetch(url: string, headers: Record<string, string> = {}, opts: { background?: boolean; scope?: string } = {}): Promise<Response> {
  return api.send(url, headers, opts);
}

export interface JsonResult<T> {
  data: T;
  /** The data came from the cache because the API could not be used, so it may be outdated. */
  stale: boolean;
  /** How old it is, in milliseconds. */
  ageMs: number;
  status: number;
}

/** A cached GET parsed as JSON. A 404 returns `status: 404` with `data` null; any other non-OK answer throws, and so does a 200 that is not JSON (it is never cached). */
export async function apiJson<T>(url: string, opts: { kind: CacheKind; ttlMs?: number; headers?: Record<string, string>; background?: boolean; scope?: string }): Promise<JsonResult<T | null>> {
  const r = await api.get(url, { ...opts, json: true });
  if (r.status === 404) return { data: null, stale: r.stale, ageMs: Date.now() - r.fetchedAt, status: 404 };
  if (r.status < 200 || r.status >= 300) throw new ApiHttpError(r.status, new URL(url).host);
  return { data: JSON.parse(r.body) as T, stale: r.stale, ageMs: Math.max(0, Date.now() - r.fetchedAt), status: r.status };
}

