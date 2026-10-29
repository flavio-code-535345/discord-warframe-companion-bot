import { distance } from '../ssroles/parse.js';
import type { OcrLine } from '../ssroles/parse.js';
import type { StatInput } from './grade.js';
import type { Box } from './pointer.js';
import { statKey } from './ranges.js';
import { canon, norm, resolveStat } from './stats.js';
import type { RivenAttribute, RivenWeapon } from './types.js';

/**
 * Reads what OCR made of a screenshot of an unveiled riven mod card: the weapon (the first words of the riven's name, e.g.
 * "Kuva Bramma Crita-lexitis") and the stat lines ("+168.7% Critical Chance", "-45.2% Zoom"). Pure, so it is tested on made-up OCR
 * output. It forgives the usual OCR slips (a wrong letter, a lost "+", a "," for a "."), and says what it was unsure of instead of
 * guessing silently, because a wrong stat would give a confidently wrong grade.
 */

export interface CardReading {
  weapon: RivenWeapon | null;
  /** Bonus stats, in the order they appear, with their values. */
  positives: StatInput[];
  negative: StatInput | null;
  /** Stat names whose +/- sign OCR did not see; they were taken as bonuses (or, for a fourth line, the curse), which may be wrong. */
  unsureSign: string[];
  /** Lines that look like stats (a number with % or a sign) but whose name matched no riven stat. */
  unknown: string[];
  /** The stat lines as OCR gave them, for the "I read" message. */
  statLines: string[];
  /** Stats whose name was unreadable and were worked out from what was left (see `interpretUnknown`). */
  guessed: string[];
  /** The card's text block (name to footer) in the coordinates of the picture OCR read; null when the name was not found by its hyphenated title. */
  box?: Box | null;
}

const MINUS = /[-−–—‒]/;
// Stray symbols and spaces between the value and the name are skipped: the game draws an element's icon there ("+98.3% * Cold" is what OCR makes
// of it). One flat class, not a group of symbols followed by optional spaces: that nesting backtracks exponentially on a long run of symbols.
const STAT_LINE = /([+\-−–—‒]?)\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*(%|s\b|m\b)?[^A-Za-z0-9+\-−–—‒]*([A-Za-z][A-Za-z '/\-]{2,})/;

/** "x0.75 Damage to Infested": a faction multiplier, with a stray letter or two around it. */
const MULTIPLIER_LINE = /(?:^|[^A-Za-z0-9])[xX]\s*(\d(?:[.,]\d{1,2})?)\s+([A-Za-z][A-Za-z '/\-]{2,})/;

/** No riven stat reaches 1000%: a longer number has a symbol read as a digit in front of it (the "+" turned into a "1" in "1252.6%"). */
const plausible = (number: string): number => {
  const digits = number.replace(',', '.');
  const v = Number(digits);
  return v >= 1000 && /^[0-9]{4}/.test(digits) ? Number(digits.slice(1)) : v;
};

/**
 * Stats the game shows with a minus when they are a *bonus* (less recoil is better), and with a plus when they are the curse. The
 * market names the attribute "Weapon Recoil" or "Recoil"; matching the name keeps this independent of its slug.
 */
const lowerIsBetter = (a: RivenAttribute): boolean => /recoil/i.test(a.name) || /recoil/.test(a.slug);

/**
 * The words a stat name continues with on the next line of the card ("Critical Chance" / "for Slide Attack"; the "(x2 for Heavy Attacks)" note
 * is only a description of the stat, not part of its name), or null when the next line starts another stat or has no words.
 */
const continuation = (next: string | undefined): string | null => {
  if (!next || /\d[.,]?\d*\s*%/.test(next) || MULTIPLIER_LINE.test(next)) return null;
  const words = next.replace(/\([^)]*\)/g, ' ').replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z '/-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words.length >= 3 ? words : null;
};

/** A stat name that may wrap onto a second line: the joined text wins when it is a longer name that starts with the first line, else the first line alone. */
function nameWithContinuation(attrs: RivenAttribute[], first: string, next: string | undefined): RivenAttribute | null {
  const alone = matchName(attrs, first);
  const more = continuation(next);
  if (!more) return alone;
  const joined = matchName(attrs, `${first} ${more}`);
  return joined && joined !== alone && norm(joined.name).includes(norm(first)) ? joined : alone;
}

/** The attribute a possibly mis-read name means: the usual matching first, then one or two wrong letters forgiven. */
export function closestAttribute(attrs: RivenAttribute[], text: string): RivenAttribute | null {
  const exact = resolveStat(attrs, text);
  if (exact) return exact;
  const q = canon(text);
  if (q.length < 5) return null;
  const limit = Math.max(1, Math.floor(q.length / 6));
  let best: { a: RivenAttribute; d: number } | null = null;
  for (const a of attrs) {
    const d = distance(q, norm(a.name));
    if (d <= limit && (!best || d < best.d)) best = { a, d };
  }
  return best?.a ?? null;
}

/** A stat name as OCR gave it, which may have stray letters at the end ("Damage p", "Zoom b" from the card's frame): the whole text first, then without trailing one- or two-letter tokens. */
export function matchName(attrs: RivenAttribute[], name: string): RivenAttribute | null {
  const tokens = name.split(/\s+/).filter(Boolean);
  // The whole text as an exact name, an alias or the start of a name ("Ammo E" is the start of "Ammo Efficiency") wins over a loose match.
  const whole = tokens.join(' ');
  const direct = resolveStat(attrs, whole, 'strict') ?? resolveStat(attrs, whole, 'prefix');
  if (direct) return direct;
  // Then the same with stray short trailing tokens dropped: "Damage p" is Damage plus a stray letter, not "Weak Point Damage".
  for (let drop = 1; drop <= 2 && tokens.length - drop >= 1; drop++) {
    if (tokens[tokens.length - drop]!.length > 2) break;
    const hit = resolveStat(attrs, tokens.slice(0, tokens.length - drop).join(' '), 'strict');
    if (hit) return hit;
  }
  for (let drop = 0; drop <= 2 && tokens.length - drop >= 1; drop++) {
    if (drop > 0 && tokens[tokens.length - drop]!.length > 2) break;
    const hit = closestAttribute(attrs, tokens.slice(0, tokens.length - drop).join(' '));
    if (hit) return hit;
  }
  return null;
}

/**
 * A riven's name is the weapon followed by one hyphenated word ("Zarr Crita-parciata", "Kuva Bramma Hexa-tox"), so the words before
 * that hyphenated word are the weapon, and a wrong letter can be forgiven there more freely than anywhere else on the card.
 */
function weaponFromTitle(weapons: RivenWeapon[], lines: string[]): { weapon: RivenWeapon; index: number } | null {
  for (const [index, line] of lines.entries()) {
    const title = /\b[A-Za-z]{3,}-[A-Za-z]{3,}\b/.exec(line);
    if (!title) continue;
    // Drop stray symbols and digits in front ("2 Zarr", "© Kuva Bramma").
    const words = line.slice(0, title.index).split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z']*$/.test(w) && w.length > 1);
    if (!words.length) continue;
    let best: { w: RivenWeapon; d: number } | null = null;
    for (const w of weapons) {
      const target = norm(w.name);
      const k = target.split(' ').length;
      if (words.length < k) continue;
      const d = distance(norm(words.slice(words.length - k).join(' ')), target);
      if (d <= Math.max(1, Math.floor(target.length / 6)) && (!best || d < best.d || (d === best.d && target.length > norm(best.w.name).length))) best = { w, d };
    }
    if (best) return { weapon: best.w, index };
  }
  return null;
}

/** The weapon whose name starts (or sits in) a line of the card, forgiving a wrong letter in longer names. The longest name wins. */
export function findWeapon(weapons: RivenWeapon[], lines: string[]): RivenWeapon | null {
  const fromTitle = weaponFromTitle(weapons, lines);
  if (fromTitle) return fromTitle.weapon;
  let best: { w: RivenWeapon; score: number } | null = null;
  for (const line of lines) {
    const words = norm(line).split(' ').filter(Boolean);
    for (const w of weapons) {
      const target = norm(w.name);
      const k = target.split(' ').length;
      const limit = target.length >= 8 ? Math.floor(target.length / 8) : 0;
      for (let i = 0; i + k <= words.length; i++) {
        const d = distance(words.slice(i, i + k).join(' '), target);
        if (d > limit) continue;
        // A longer name beats a shorter one ("Kuva Bramma" over "Bramma"), and an exact match beats a near one.
        const score = target.length * 10 - d;
        if (!best || score > best.score) best = { w, score };
      }
    }
  }
  return best?.w ?? null;
}

export function parseRivenCard(lines: OcrLine[], attrs: RivenAttribute[], weapons: RivenWeapon[]): CardReading {
  const entries = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0).map((line) => ({ line, text: line.text.replace(/\s+/g, ' ').trim() })).filter((e) => e.text);
  const texts = entries.map((e) => e.text);
  const weapon = findWeapon(weapons, texts);
  // The stat lines sit under the riven's name and above the footer ("MR 16", rank, re-rolls). OCR also finds noise in the artwork above the
  // name, and a signed number in it must not count as a stat (it would push a real one out, or block grading as unreadable).
  // A riven with only two stat names has no hyphenated title ("Ripkas Sciata"): then the line that holds the weapon's name is where the stats start.
  const hyphenated = weaponFromTitle(weapons, texts);
  const named = hyphenated ? hyphenated.index : weapon ? texts.findIndex((t) => norm(t).includes(norm(weapon.name))) : -1;
  const title = named >= 0 ? { index: named } : null;
  const footer = texts.findIndex((t, i) => i > (title?.index ?? -1) && /(^|[^A-Za-z])MR *[0-9]/.test(t));
  const body = texts.slice(title ? title.index + 1 : 0, footer >= 0 ? footer : undefined);

  const found: { attr: RivenAttribute; value: number; sign: '+' | '-' | null; line: string }[] = [];
  const unknown: string[] = [];
  for (const [bodyIndex, original] of body.entries()) {
    // The icon of an element is read as a small number ("+101.5% 4% Electricity"): one or two digits, with or without a %, between the
    // real value and the name are not a second value.
    // Stray symbols around it ("+135.4% # 4% Electricity", "+135.4% 4) Electricity") are skipped too.
    const text = original.replace(/(\d[.,]?\d*\s*%)(?:[^A-Za-z0-9]*\d{1,2}\s*%?)+[^A-Za-z0-9]*(?=[A-Za-z])/, '$1 ');
    // Faction damage is a multiplier: "x1.55 Damage to Grineer" is a bonus, "x0.75 Damage to Infested" the curse.
    const mult = MULTIPLIER_LINE.exec(text);
    if (mult) {
      const attr = matchName(attrs, mult[2]!.trim());
      if (attr && statKey(attr.name) === 'faction') {
        const value = Number(mult[1]!.replace(',', '.'));
        found.push({ attr, value, sign: value < 1 ? '-' : '+', line: text });
        continue;
      }
    }
    const m = STAT_LINE.exec(text);
    if (!m) {
      // A signed or decimal value with a percent sign but no readable name ("+112.5% Cr#t?cal"): still a stat line, to be interpreted.
      if (/[+\-−–—‒]\s*\d{1,4}(?:[.,]\d{1,2})?\s*%|\d[.,]\d{1,2}\s*%/.test(text)) unknown.push(text);
      // A faction line whose multiplier was lost ("Jk Damage to Grineer" for "x0.72 Damage to Grineer") is a stat that went missing, not noise.
      else if (/damage\s+(to|vs)\s+(grineer|corpus|infested|corrupted)/i.test(text)) unknown.push(text);
      continue;
    }
    const [, sign, number, unit, name] = m;
    // A stat line has a % or an explicit sign; "Rank 0/8" or "MR 15" don't, and the name must not be a bare unit letter.
    if (!unit && !sign) continue;
    const attr = nameWithContinuation(attrs, name!.trim(), body[bodyIndex + 1]);
    if (!attr) {
      // Only a signed value or one with a decimal point is surely a stat ("1% MR 9" from the card's footer is not).
      if (sign || number!.includes('.') || number!.includes(',')) unknown.push(text);
      continue;
    }
    found.push({ attr, value: plausible(number!), sign: sign ? (MINUS.test(sign) ? '-' : '+') : null, line: text });
  }

  // The first four stat lines are the card's; a stat seen twice (a line OCR split or repeated) counts once.
  const seen = new Set<string>();
  const stats = found.filter((f) => (seen.has(f.attr.slug) ? false : (seen.add(f.attr.slug), true))).slice(0, 4);

  const positives: StatInput[] = [];
  let negative: StatInput | null = null;
  const unsureSign: string[] = [];
  stats.forEach((s, i) => {
    let isCurse: boolean;
    if (s.sign !== null) isCurse = lowerIsBetter(s.attr) ? s.sign === '+' : s.sign === '-';
    else {
      // Without a visible sign, a fourth line must be the curse (a riven has at most 3 bonuses); otherwise it is taken as a bonus.
      isCurse = stats.length === 4 && i === 3;
      unsureSign.push(s.attr.name);
    }
    if (isCurse && !negative) negative = { slug: s.attr.slug, value: s.value };
    else positives.push({ slug: s.attr.slug, value: s.value });
  });

  // Where the card's text block (name down to the footer) sits in the picture, so a screenshot of a whole screen can be cropped to the card.
  let box: Box | null = null;
  if (title) {
    const last = footer >= 0 ? footer : title.index + body.length;
    for (const { line } of entries.slice(title.index, last + 1)) {
      box = box ? { x0: Math.min(box.x0, line.x0), y0: Math.min(box.y0, line.y0), x1: Math.max(box.x1, line.x1), y1: Math.max(box.y1, line.y1) } : { x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 };
    }
  }
  return { weapon, positives: positives.slice(0, 3), negative, unsureSign, unknown, statLines: stats.map((s) => s.line), guessed: [], box };
}

/** Stats that are on most rivens people ask about: a tie-breaker when the garbled text fits several names about equally. */
const COMMON = /critical (chance|damage)|^damage$|multishot|status (chance|duration)|fire rate|attack speed|cold|heat|toxin|electricity|slash|puncture|impact|reload|magazine|ammo|projectile|range|zoom/i;

const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');
const similarity = (a: string, b: string): number => {
  const x = letters(a);
  const y = letters(b);
  const longest = Math.max(x.length, y.length);
  return longest ? 1 - distance(x, y) / longest : 0;
};

const LOOSE = /([+\-−–—‒]?)\s*(\d{1,4}(?:[.,]\d{1,2})?)\s*%?(.*)/;

/**
 * A stat line whose name could not be read (a mouse pointer over it, a smudge) is not dropped: the value and sign are still known, so
 * the likeliest stat is worked out from what is left of its name in every reading of the picture and from the stats the card does not
 * already have. It is a guess, so the stat is listed in `guessed` and the card shows it with a "?".
 */
export function interpretUnknown(reading: CardReading, texts: string[], attrs: RivenAttribute[]): CardReading {
  if (!reading.unknown.length) return reading;
  const used = new Set([...reading.positives.map((p) => p.slug), ...(reading.negative ? [reading.negative.slug] : [])]);
  const positives = [...reading.positives];
  let negative = reading.negative;
  const guessed = [...reading.guessed];
  const unknown: string[] = [];
  for (const line of reading.unknown) {
    const m = LOOSE.exec(line);
    if (!m) {
      unknown.push(line);
      continue;
    }
    const [, sign, number] = m;
    const value = Number(number!.replace(',', '.'));
    const minus = Boolean(sign && MINUS.test(sign));
    const evidence = texts.filter((t) => t.includes(number!)).map((t) => LOOSE.exec(t.slice(t.indexOf(number!) - (/[+\-−–—‒]/.test(t[t.indexOf(number!) - 1] ?? '') ? 1 : 0)))?.[3] ?? '');
    let best: { a: RivenAttribute; score: number } | null = null;
    for (const a of attrs) {
      if (used.has(a.slug)) continue;
      const asCurse = minus !== lowerIsBetter(a);
      if (asCurse ? a.positiveOnly : a.negativeOnly) continue;
      const fit = Math.max(0, ...evidence.map((e) => similarity(e, a.name)));
      const score = fit + (COMMON.test(a.name) ? 0.08 : 0);
      if (!best || score > best.score) best = { a, score };
    }
    if (!best) {
      unknown.push(line);
      continue;
    }
    const curse = minus !== lowerIsBetter(best.a);
    if (curse && !negative) negative = { slug: best.a.slug, value };
    else if (!curse && positives.length < 3) positives.push({ slug: best.a.slug, value });
    else {
      unknown.push(line);
      continue;
    }
    used.add(best.a.slug);
    guessed.push(best.a.name);
  }
  return { ...reading, positives, negative, guessed, unknown };
}
