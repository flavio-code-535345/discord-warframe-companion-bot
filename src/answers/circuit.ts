import { distance } from '../ssroles/parse.js';
import { discordTime } from '../time.js';
import { type WikiResult, readWikiPage } from '../warframe/wiki.js';
import { type WorldState, getWorldState, worldStateEnabled } from '../warframe/worldstate.js';

/**
 * "When can I get the Torid Incarnon?" answered exactly, with no model. The Steel Path Circuit offers five Incarnon Genesis
 * adapters a week and the normal Circuit three Warframes, each from a fixed rotation (the tables on the wiki's "The Circuit"
 * page). The world state says which ones are on offer this week, so the weeks until any other one follow by counting through
 * the table. Weekly rewards reset on Monday 00:00 UTC. A small model guessed here (it once read the Cambion Drift cycle as
 * the Incarnon rotation), and the clan asks this every week.
 */

export interface Rotations {
  /** incarnon[i]: the weapons whose Incarnon Genesis is offered in week i + 1. */
  incarnon: string[][];
  /** warframes[i]: the Warframes the normal Circuit offers in week i + 1. */
  warframes: string[][];
}

const WEEK_MS = 7 * 86_400_000;
const RELOAD_MS = 6 * 3_600_000;

/** The table only counts when every week from 1 on is there; a gap would make every count after it wrong. */
const complete = (weeks: string[][]): string[][] => {
  for (let i = 0; i < weeks.length; i++) if (!weeks[i]?.length) return [];
  return weeks.length >= 3 ? weeks : [];
};

/** Both rotation tables from the text of the wiki's "The Circuit" page (as the local index stores it). Pure. */
export function parseRotations(text: string): Rotations {
  const incarnon: string[][] = [];
  const warframes: string[][] = [];
  let inFrames = false;
  let week = -1;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // "|Week 5 (E) · | · *Torid Incarnon Genesis (Torid) · *Dual Toxocyst Incarnon Genesis (Dual Toxocyst) · …"
    const genesis = /^\|?\s*Week\s+(\d+)\b[^·]*·(.*\bIncarnon Genesis\b.*)$/i.exec(line);
    if (genesis) {
      const n = Number(genesis[1]) - 1;
      const names = [...genesis[2]!.matchAll(/([^*·()|]+?)\s+Incarnon Genesis/gi)].map((m) => m[1]!.trim()).filter(Boolean);
      if (names.length && !incarnon[n]) incarnon[n] = names;
      continue;
    }
    // "Normal Circuit Warframe Rotation", then "Week 1", "Excalibur (Furious Javelin)", … until "Week 12 ⟲ 1".
    if (/\bWarframe Rotation\b/i.test(line)) {
      inFrames = warframes.length === 0;
      continue;
    }
    if (!inFrames) continue;
    const head = /^Week\s+(\d+)(.*)$/i.exec(line);
    if (head) {
      if (head[2]!.trim()) inFrames = false;
      else week = Number(head[1]) - 1;
      continue;
    }
    const frame = /^(\p{Lu}[\p{L}' &.-]*?)\s*\(/u.exec(line);
    if (frame && week >= 0) (warframes[week] ??= []).push(frame[1]!);
  }
  return { incarnon: complete(incarnon), warframes: complete(warframes) };
}

let cache: { at: number; value: Rotations } | null = null;

/** The rotation tables from the wiki (cached a few hours), or empty tables when the page can't be read. */
export async function loadRotations(read: (title: string, maxChars: number) => Promise<WikiResult | null> = readWikiPage, now = Date.now()): Promise<Rotations> {
  if (cache && now - cache.at < RELOAD_MS) return cache.value;
  const page = await read('The Circuit', 60_000).catch(() => null);
  const value = page ? parseRotations(page.extract) : { incarnon: [], warframes: [] };
  if (value.incarnon.length || value.warframes.length) cache = { at: now, value };
  return value;
}

/** Test hook. */
export const resetRotations = (): void => {
  cache = null;
};

/** Monday 00:00 UTC after `now`, when the Circuit's weekly rewards change. */
export function nextReset(now: number): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight + (7 - ((d.getUTCDay() + 6) % 7)) * 86_400_000;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9& ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Which week of a rotation is on offer now: the week sharing the most names with the world state's choices (at least two). */
export function weekOf(rotation: string[][], offered: string[]): number {
  const have = new Set(offered.map(norm));
  let best = -1;
  let score = 1;
  rotation.forEach((names, i) => {
    const s = names.filter((n) => have.has(norm(n))).length;
    if (s > score) {
      best = i;
      score = s;
    }
  });
  return best;
}

/** The rotation entry the question names (the longest name wins; one wrong letter forgiven from six letters), or null. */
export function namedIn(question: string, rotation: string[][]): string | null {
  const q = ` ${norm(question)} `;
  const words = norm(question).split(' ');
  const names = [...new Set(rotation.flat())].sort((a, b) => b.length - a.length);
  for (const name of names) if (q.includes(` ${norm(name)} `)) return name;
  for (const name of names) {
    const n = norm(name);
    if (n.length < 6 || n.includes(' ')) continue;
    if (words.some((w) => w.length >= 5 && w[0] === n[0] && distance(w, n) <= 1)) return name;
  }
  return null;
}

export type CircuitTopic = 'incarnon' | 'warframe';

/** Whether a question is about the Circuit's weekly rewards: Incarnon adapters (also misspelt), or the Circuit's Warframes. */
export function circuitTopic(question: string): CircuitTopic | null {
  const q = question.toLowerCase();
  const incarnonWord = /\b(genesis|adapters?)\b/.test(q) || q.split(/[^a-z]+/).some((w) => w.length >= 7 && w.length <= 10 && w.startsWith('inc') && distance(w.replace(/s$/, ''), 'incarnon') <= 2);
  if (incarnonWord) return 'incarnon';
  if (/\bcircuit\b/.test(q)) return /\b(steel path|sp|weapons?|adapters?)\b/.test(q) ? 'incarnon' : 'warframe';
  return null;
}

export interface Availability {
  name: string;
  /** 0-based week of the rotation. */
  week: number;
  /** 0 = on offer this week. */
  weeksAhead: number;
  from: number;
  until: number;
}

/** When `name` is next on offer, given the week on offer now. Null when the name is not in the rotation. */
export function availability(name: string, rotation: string[][], current: number, now: number): Availability | null {
  const week = rotation.findIndex((names) => names.some((n) => norm(n) === norm(name)));
  if (week < 0 || current < 0) return null;
  const weeksAhead = (week - current + rotation.length) % rotation.length;
  const reset = nextReset(now);
  const from = weeksAhead === 0 ? reset - WEEK_MS : reset + (weeksAhead - 1) * WEEK_MS;
  return { name, week, weeksAhead, from, until: from + WEEK_MS };
}

const letter = (week: number) => String.fromCharCode(65 + week);
const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

/** A "this week / next week / what's on offer" question, which needs no name. */
const LISTING = /\b(this|next|current|coming)\s+week\b|\bwhat('s| is| are)?\b[^?]*\b(in|on offer|available|offered)\b|\brotation\b|\bright now\b|\bcurrently\b|\bschedule\b|\ball (the )?(incarnons?|adapters?|weeks|warframes)\b/i;
/** "The full schedule", "all incarnons", "every week": the whole rotation rather than this week and next. */
const FULL = /\bschedule\b|\b(full|whole|entire|complete)\b[^?]*\b(rotation|list|weeks)\b|\bevery week\b|\ball (the )?(incarnons?|adapters?|weeks|warframes|weapons)\b/i;

export interface CircuitDeps {
  now?: number;
  read?: (title: string, maxChars: number) => Promise<WikiResult | null>;
  world?: () => Promise<Pick<WorldState, 'duviriCycle'>>;
}

/**
 * The exact answer to a Circuit rotation question, or null when the question is not one (or names something the rotation
 * doesn't have, such as an Incarnon weapon from elsewhere): the normal answer path then takes it.
 */
export async function circuitAnswer(question: string, deps: CircuitDeps = {}): Promise<string | null> {
  const topic = circuitTopic(question);
  if (!topic) return null;
  const now = deps.now ?? Date.now();
  const rotations = await loadRotations(deps.read, now);
  const table = topic === 'incarnon' ? rotations.incarnon : rotations.warframes;
  if (!table.length) return null;
  const name = namedIn(question, table);
  if (!name && !LISTING.test(question)) return null;

  let offered: string[] = [];
  if (deps.world || worldStateEnabled()) {
    try {
      const ws = await (deps.world ?? getWorldState)();
      const choices = (ws.duviriCycle as { choices?: { category?: string; choices?: string[] }[] } | undefined)?.choices;
      offered = choices?.find((c) => c.category === (topic === 'incarnon' ? 'hard' : 'normal'))?.choices ?? [];
    } catch {
      // No world state: the answer says so and gives the week of the rotation instead.
    }
  }
  const current = weekOf(table, offered);
  const reset = nextReset(now);
  const what = (n: string) => (topic === 'incarnon' ? `**${n} Incarnon Genesis**` : `**${n}**`);
  const circuitName = topic === 'incarnon' ? 'Steel Path Circuit' : 'Circuit';
  const where = `the ${circuitName}`;
  const how =
    topic === 'incarnon'
      ? 'Run The Circuit with the Steel Path on: you pick two of the week\'s five adapters as the tier 5 and 10 rewards.'
      : 'Run the normal Circuit: you pick one of the week\'s three Warframes, its parts come from the tier rewards.';
  const source = `-# ${table.length}-week rotation from the wiki's The Circuit page${current >= 0 ? `; this week is week ${current + 1} (${letter(current)})` : ''}.`;

  // "The full schedule": every week of the rotation, from this one on, each with the Monday it starts.
  if (!name && FULL.test(question)) {
    const rows = table.map((_, k) => {
      const w = current >= 0 ? (current + k) % table.length : k;
      const when = current < 0 ? '' : k === 0 ? ' · **this week**' : ` · from ${discordTime(reset + (k - 1) * WEEK_MS, 'D')}`;
      return `**Week ${w + 1} (${letter(w)})**${when}: ${list(table[w]!)}`;
    });
    const note = current < 0 ? " (I can't see this week's offerings right now, so the weeks are listed without dates)" : '';
    return `The ${circuitName} rotation, Operator${note}:\n${rows.join('\n')}\nAfter week ${table.length} it starts again at week 1. ${how}\n${source}`;
  }

  if (current < 0) {
    const week = name ? table.findIndex((names) => names.includes(name)) : -1;
    const head = name
      ? `${what(name)} is in week ${week + 1} (${letter(week)}) of the ${table.length}-week ${circuitName} rotation, Operator.`
      : `The ${circuitName} rotation has ${table.length} weeks, Operator.`;
    return `${head} I can't see this week's offerings right now (the world state is off or unavailable), so I can't count the weeks for you. ${how}\n${source}`;
  }

  const thisWeek = `This week (until ${discordTime(reset, 'f')}): ${list(table[current]!)}.`;
  if (!name) {
    const next = table[(current + 1) % table.length]!;
    return `${thisWeek}\nNext week: ${list(next)}.\n${how}\n${source}`;
  }
  const a = availability(name, table, current, now)!;
  const head =
    a.weeksAhead === 0
      ? `${what(name)} is in ${where} **this week**, Operator, until ${discordTime(a.until, 'F')} (${discordTime(a.until, 'R')}).`
      : `${what(name)} is next in ${where} in **${a.weeksAhead} week${a.weeksAhead === 1 ? '' : 's'}**, Operator: from ${discordTime(a.from, 'F')} until ${discordTime(a.until, 'F')} (${discordTime(a.from, 'R')}).`;
  return `${head}\n${how}\n${a.weeksAhead === 0 ? '' : `${thisWeek}\n`}${source}`;
}
