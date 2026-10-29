const UNIT_MS: Record<string, number> = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 };

/** The latest moment a Date can represent; anything beyond it makes toISOString() throw. */
const MAX_DATE_MS = 8.64e15;

/**
 * Parses an event start time. Accepts relative offsets ("2h", "1d 4h30m", "in 45m"),
 * Unix timestamps in seconds, and ISO-8601 dates. A date/time without a zone ("2026-11-02 20:00")
 * is read as UTC so the result does not depend on the server's timezone.
 */
export function parseWhen(input: string, now = Date.now()): number | null {
  const s = input.trim().toLowerCase().replace(/^in\s+/, '');
  if (!s) return null;

  if (/^(\d+\s*[wdhm]\s*)+$/.test(s)) {
    let total = 0;
    for (const [, n, unit] of s.matchAll(/(\d+)\s*([wdhm])/g)) total += Number(n) * UNIT_MS[unit!]!;
    return total > 0 && now + total <= MAX_DATE_MS ? now + total : null;
  }

  if (/^\d{9,11}$/.test(s)) return Number(s) * 1000;

  const local = s.match(/^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}:\d{2})$/);
  const iso = local ? `${local[1]}T${local[2]!.padStart(5, '0')}:00Z` : input.trim();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The longest an event may run; anything longer is a typo (or not an event). */
export const MAX_EVENT_LENGTH_MS = 30 * 86_400_000;

/**
 * Parses an event end time. A plain length ("2h", "90m", "1d 2h") counts from the event's START, because "ends in 2h" is
 * ambiguous and nobody means two hours from now for an event that starts next week; anything else is read like a start time
 * ("2026-11-02 22:00" UTC, ISO-8601, a Unix timestamp). Null when it cannot be read.
 */
export function parseEnd(input: string, startsAt: number, now = Date.now()): number | null {
  const s = input.trim().toLowerCase().replace(/^in\s+/, '');
  if (!s) return null;
  if (/^(\d+\s*[wdhm]\s*)+$/.test(s)) {
    let total = 0;
    for (const [, n, unit] of s.matchAll(/(\d+)\s*([wdhm])/g)) total += Number(n) * UNIT_MS[unit!]!;
    return total > 0 && startsAt + total <= MAX_DATE_MS ? startsAt + total : null;
  }
  return parseWhen(input, now);
}

/** "10m", "1h30m", "2d", "1w", "30s" → milliseconds; null when it isn't a duration. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!/^(\d+\s*[wdhms]\s*)+$/.test(s)) return null;
  const units: Record<string, number> = { ...UNIT_MS, s: 1000 };
  let total = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)\s*([wdhms])/g)) total += Number(n) * units[unit!]!;
  return total > 0 ? total : null;
}

/** Compact human duration like "3d 4h", "2h 5m" or "45m". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / UNIT_MS.d!);
  const h = Math.floor((ms % UNIT_MS.d!) / UNIT_MS.h!);
  const m = Math.floor((ms % UNIT_MS.h!) / UNIT_MS.m!);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(m, 1)}m`;
}

/** Worldstate models type most timestamps as optional, so every helper tolerates missing values. */
export type TimeInput = Date | string | number | null | undefined;

/** Epoch milliseconds, or NaN when missing/invalid (NaN fails every comparison, so missing data reads as "not live"). */
export function toMs(date: TimeInput): number {
  return date === null || date === undefined ? Number.NaN : new Date(date).getTime();
}

/** "in 2h 5m" / "5m ago" relative to now. */
export function relative(date: TimeInput, now = Date.now()): string {
  const diff = toMs(date) - now;
  if (Number.isNaN(diff)) return 'unknown';
  return diff >= 0 ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}

/** Discord timestamp markup, rendered in each reader's own timezone. */
export function discordTime(date: TimeInput, style: 'R' | 'F' | 'f' | 't' | 'D' = 'R'): string {
  const ms = toMs(date);
  return Number.isNaN(ms) ? 'unknown' : `<t:${Math.floor(ms / 1000)}:${style}>`;
}
