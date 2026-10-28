import { randomCode } from './captcha.js';

export const MAX_ATTEMPTS = 3;
export const COOLDOWN_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;

interface State {
  code: string;
  expires: number;
  attempts: number;
  cooldownUntil: number;
}

export type StartResult = { ok: true; code: string; attemptsLeft: number } | { ok: false; cooldownMs: number };
export type CheckResult =
  | { result: 'ok' }
  | { result: 'wrong'; attemptsLeft: number }
  | { result: 'locked'; cooldownMs: number }
  | { result: 'expired' };

/**
 * Per-member captcha state. Wrong answers count across new pictures, so asking for a fresh image doesn't reset
 * the limit; after MAX_ATTEMPTS the member waits COOLDOWN_MS. In memory: a restart just means a new captcha.
 */
export class VerificationAttempts {
  private readonly state = new Map<string, State>();

  constructor(private readonly rng: () => number = Math.random) {}

  start(userId: string, now = Date.now()): StartResult {
    // Expired challenges with no wrong answers on them are forgotten, so the map doesn't grow with every account that ever pressed Verify
    // (wrong answers still count across new pictures, so those are kept).
    for (const [id, s] of this.state) if (id !== userId && s.cooldownUntil <= now && s.expires < now && s.attempts === 0) this.state.delete(id);
    const prev = this.state.get(userId);
    if (prev && prev.cooldownUntil > now) return { ok: false, cooldownMs: prev.cooldownUntil - now };
    const attempts = prev && prev.cooldownUntil === 0 ? prev.attempts : 0;
    const code = randomCode(this.rng);
    this.state.set(userId, { code, expires: now + CHALLENGE_TTL_MS, attempts, cooldownUntil: 0 });
    return { ok: true, code, attemptsLeft: MAX_ATTEMPTS - attempts };
  }

  check(userId: string, answer: string, now = Date.now()): CheckResult {
    const s = this.state.get(userId);
    if (!s) return { result: 'expired' };
    if (s.cooldownUntil > now) return { result: 'locked', cooldownMs: s.cooldownUntil - now };
    if (s.expires < now) return { result: 'expired' };
    // Case and spaces don't matter.
    if (answer.toUpperCase().replace(/\s+/g, '') === s.code) {
      this.state.delete(userId);
      return { result: 'ok' };
    }
    s.attempts++;
    if (s.attempts >= MAX_ATTEMPTS) {
      s.cooldownUntil = now + COOLDOWN_MS;
      s.attempts = 0;
      return { result: 'locked', cooldownMs: COOLDOWN_MS };
    }
    return { result: 'wrong', attemptsLeft: MAX_ATTEMPTS - s.attempts };
  }
}
