import { wallClock, zonedEpoch } from '../time.js';

/**
 * Reads the `when` of /remindme. No network, no model: a small grammar.
 *
 * - a length of time, counted from now: "2h", "3 days", "1w 2d", "in 90 minutes", "1 hour 30 min", "2 weeks and 3 days"
 * - a date and/or time of day, read in the clan time zone: "2026-12-01 18:00", "2026-12-01", "24.12.2026 20:00", "tomorrow 9am",
 *   "today 18:30", "friday", "next monday 8pm", "21:00" (the next time the clock shows it)
 * - an ISO-8601 moment with its own zone: "2026-12-01T18:00:00Z", "2026-12-01T18:00+01:00"
 *
 * A date without a time of day means 09:00. Null when the text is not understood; the caller reports it.
 */

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DAY_MS = 86_400_000;
const DEFAULT_HOUR = 9;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const UNIT_WORD = '(?:weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)';
const DURATION_PART = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${UNIT_WORD})\\b`, 'g');
const DURATION_ALL = new RegExp(`^(?:\\d+(?:\\.\\d+)?\\s*${UNIT_WORD}(?:\\s*(?:,|and|&)?\\s*|$))+$`);
const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?';
const DATE_TIME = new RegExp(
  `^(?:(today|tomorrow|tmrw)|(?:(next)\\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*|(\\d{4})-(\\d{1,2})-(\\d{1,2})|(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4}))?(?:\\s*(?:t|at|@)?\\s*${TIME})?$`,
);

/** A length of time in milliseconds, or null. Zero or a text that is not entirely a length is null. */
export function parseLength(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!DURATION_ALL.test(s)) return null;
  let total = 0;
  for (const [, n, unit] of s.matchAll(DURATION_PART)) total += Number(n) * UNIT_MS[unit![0]!]!;
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

/** Date fields (in the zone) of a moment. */
function zoneDate(at: number, zone: string): { y: number; mo: number; d: number } {
  const w = new Date(wallClock(at, zone));
  return { y: w.getUTCFullYear(), mo: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

/** `days` after a calendar date, as a calendar date. */
function addDays(date: { y: number; mo: number; d: number }, days: number): { y: number; mo: number; d: number } {
  const w = new Date(Date.UTC(date.y, date.mo - 1, date.d) + days * DAY_MS);
  return { y: w.getUTCFullYear(), mo: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

export function parseReminderTime(input: string, now: number, timeZone: string): number | null {
  const raw = input.trim();
  if (!raw || raw.length > 60) return null;

  // An ISO moment that names its own zone is taken as written.
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const ms = Date.parse(raw.replace(' ', 'T').replace(/\s+/g, ''));
    return Number.isNaN(ms) ? null : ms;
  }

  const s = raw.toLowerCase().replace(/^(in|on|at)\s+/, '').replace(/\s+/g, ' ');

  const length = parseLength(s);
  if (length !== null) return now + length;

  const m = s.match(DATE_TIME);
  if (!m) return null;
  const [, relDay, next, weekday, isoY, isoMo, isoD, dmD, dmMo, dmY, hh, mm, ampm] = m;
  const hasDate = Boolean(relDay || weekday || isoY || dmY);
  const hasTime = hh !== undefined;
  if (!hasDate && !hasTime) return null;
  // A bare number is a length with a missing unit, not a time of day.
  if (!hasDate && mm === undefined && ampm === undefined) return null;

  let hour = DEFAULT_HOUR;
  let minute = 0;
  if (hasTime) {
    hour = Number(hh);
    minute = mm === undefined ? 0 : Number(mm);
    if (ampm) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (ampm === 'pm' ? 12 : 0);
    }
    if (hour > 23 || minute > 59) return null;
  }

  const today = zoneDate(now, timeZone);
  const at = (date: { y: number; mo: number; d: number }) => zonedEpoch(date.y, date.mo, date.d, hour, minute, timeZone);

  if (isoY) return at({ y: Number(isoY), mo: Number(isoMo), d: Number(isoD) });
  if (dmY) return at({ y: Number(dmY), mo: Number(dmMo), d: Number(dmD) });
  if (relDay === 'today') return at(today);
  if (relDay) return at(addDays(today, 1));

  // A weekday, or only a time of day: the first moment after now that fits ("friday" on a Friday morning is today, in the evening next week).
  const wanted = weekday ? WEEKDAYS.indexOf(weekday) : -1;
  const todayDow = new Date(Date.UTC(today.y, today.mo - 1, today.d)).getUTCDay();
  for (let ahead = next ? 1 : 0; ahead <= 8; ahead++) {
    if (wanted >= 0 && (todayDow + ahead) % 7 !== wanted) continue;
    const t = at(addDays(today, ahead));
    if (t !== null && t > now) return t;
  }
  return null;
}
