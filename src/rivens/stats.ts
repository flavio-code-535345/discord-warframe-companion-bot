import { UserError } from '../services/clan.js';
import type { StatInput } from './grade.js';
import type { RivenAttribute } from './types.js';

/** Players say "cc cd ms": these map the short forms to the names warframe.market uses. A list means "the first of these that exists". */
const ALIASES: Record<string, string[]> = {
  cc: ['critical chance'],
  crit: ['critical chance'],
  cd: ['critical damage'],
  ms: ['multishot'],
  multi: ['multishot'],
  dmg: ['damage', 'base damage melee damage', 'base damage', 'melee damage'],
  dam: ['damage', 'base damage melee damage', 'base damage', 'melee damage'],
  damage: ['damage', 'base damage melee damage', 'base damage', 'melee damage'],
  sc: ['status chance'],
  sd: ['status duration'],
  fr: ['fire rate attack speed', 'fire rate'],
  as: ['fire rate attack speed', 'attack speed'],
  speed: ['fire rate attack speed', 'attack speed'],
  rl: ['reload speed'],
  reload: ['reload speed'],
  mag: ['magazine capacity'],
  ammo: ['ammo maximum'],
  ic: ['initial combo'],
  cdur: ['combo duration'],
  pt: ['punch through'],
  heat: ['heat damage'],
  cold: ['cold damage'],
  elec: ['electric damage', 'electricity damage'],
  toxin: ['toxin damage'],
  impact: ['impact damage'],
  puncture: ['puncture damage'],
  slash: ['slash damage'],
  grineer: ['damage vs grineer'],
  corpus: ['damage vs corpus'],
  infested: ['damage vs infested'],
  finisher: ['finisher damage'],
  slide: ['critical chance on slide attack'],
  proj: ['projectile speed'],
};

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Abbreviations inside a longer name ("crit dmg"). */
const WORDS: Record<string, string> = { dmg: 'damage', dam: 'damage', crit: 'critical', mult: 'multishot', reloadspeed: 'reload speed' };

/** The attribute a short or loose name means, or null. Order: an alias, the exact name, a name that starts with it, one whose words start with its words, one that contains it. */
export function resolveStat(attrs: RivenAttribute[], text: string, mode: 'loose' | 'prefix' | 'strict' = 'loose'): RivenAttribute | null {
  const typed = norm(text);
  if (!typed) return null;
  const byName = new Map(attrs.map((a) => [norm(a.name), a]));
  for (const candidate of ALIASES[typed] ?? []) {
    const hit = byName.get(norm(candidate));
    if (hit) return hit;
  }
  const q = typed.split(' ').map((w) => WORDS[w] ?? w).join(' ');
  const exact = byName.get(q) ?? attrs.find((a) => a.slug === q.replace(/ /g, '_'));
  if (exact) return exact;
  // Strict: an alias or the exact name only, no loose matching ("damage p" must not turn into "Weak Point Damage").
  if (mode === 'strict') return null;
  const shortest = (list: RivenAttribute[]) => [...list].sort((a, b) => a.name.length - b.name.length)[0] ?? null;
  // Prefix: also a name that starts with the text ("ammo e" is the start of "Ammo Efficiency").
  if (mode === 'prefix') return shortest(attrs.filter((a) => norm(a.name).startsWith(q)));
  const words = q.split(' ');
  return (
    shortest(attrs.filter((a) => norm(a.name).startsWith(q))) ??
    shortest(attrs.filter((a) => { const w = norm(a.name).split(' '); return words.every((x) => w.some((y) => y.startsWith(x))); })) ??
    shortest(attrs.filter((a) => norm(a.name).includes(q)))
  );
}

const NUMBER = /-?\d+(?:[.,]\d+)?\s*%?/;

/**
 * "cc 180, multishot 120.5, sc" or "cc cd ms": a list of stats, each optionally followed by its rolled value. Separators are commas,
 * plus signs and semicolons; without them, a part that is not one stat is read word by word ("cc cd ms").
 */
export function parseStatList(text: string, attrs: RivenAttribute[]): StatInput[] {
  const out: StatInput[] = [];
  const unknown: string[] = [];
  for (const part of text.split(/[,;+&\n]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const found = NUMBER.exec(trimmed);
    const value = found ? Number(found[0].replace('%', '').replace(',', '.')) : null;
    const name = trimmed.replace(NUMBER, ' ').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const whole = resolveStat(attrs, name);
    if (whole) {
      out.push({ slug: whole.slug, value });
      continue;
    }
    const each = name.split(' ').map((w) => ({ w, a: resolveStat(attrs, w) }));
    if (each.length > 1 && each.every((e) => e.a)) for (const e of each) out.push({ slug: e.a!.slug });
    else unknown.push(name);
  }
  if (unknown.length) throw new UserError(`I don't know the riven stat${unknown.length > 1 ? 's' : ''} "${unknown.join('", "')}". Use names like Critical Chance, or short forms like cc, cd, ms, sc, dmg.`);
  return out;
}
