const HOUR_MS = 3_600_000;

export type LimitResult = { ok: true } | { ok: false; reason: 'user' | 'daily'; retryAfterMs: number };

/**
 * In-memory rate limits for AI questions: a sliding hourly window per user plus a global daily cap
 * (UTC day). Resets on restart, which is fine: the limits exist to bound API spend, not to be exact.
 */
export class AskLimiter {
  private readonly perUser = new Map<string, number[]>();
  private day = '';
  private dayCount = 0;

  constructor(
    private readonly userPerHour: number,
    private readonly dailyTotal: number,
  ) {}

  /** Checks and, when allowed, records one question. */
  take(userId: string, now = Date.now()): LimitResult {
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.dailyTotal) {
      const midnight = Date.parse(`${today}T00:00:00Z`) + 24 * HOUR_MS;
      return { ok: false, reason: 'daily', retryAfterMs: midnight - now };
    }
    const recent = (this.perUser.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.userPerHour) {
      return { ok: false, reason: 'user', retryAfterMs: HOUR_MS - (now - recent[0]!) };
    }
    recent.push(now);
    this.perUser.set(userId, recent);
    this.dayCount++;
    return { ok: true };
  }
}
