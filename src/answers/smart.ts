import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import {
  BOUNTY_SYNDICATES,
  COLORS,
  archimedeaEmbed,
  archonEmbed,
  baroEmbed,
  bountiesEmbed,
  clampLines,
  cyclesEmbed,
  dealsEmbed,
  dropsEmbed,
  eventsEmbed,
  fissuresEmbed,
  invasionsEmbed,
  nightwaveEmbed,
  priceEmbed,
  resurgenceEmbed,
  sortieEmbed,
  steelPathEmbed,
} from '../discord/embeds.js';
import { lookupEmbed, relicEmbed, showsDrops } from '../discord/lookup-embeds.js';
import { discordTime } from '../time.js';
import { type DropGroup, searchDrops } from '../warframe/drops.js';
import { lookupItem } from '../warframe/items.js';
import { priceCheck } from '../warframe/market.js';
import { type WikiResult, pageUrl, readWikiPage, searchWiki } from '../warframe/wiki.js';
import { answerFrom } from '../wiki/answer.js';
import { getWikiIndex } from '../wiki/index.js';
import type { AiSource } from '../db.js';
import { type WorldState, filterFissures, getWorldState } from '../warframe/worldstate.js';
import { calculate } from './calc.js';
import { circuitAnswer } from './circuit.js';
import { findCorrection } from './corrections.js';
import { type Intent, type WorldView, detectIntent } from './intent.js';
import { masteryAnswer } from './mastery.js';
import { mathExpression, noContent, questionLike, thanks } from './understand.js';

/**
 * How Ordis answers in chat, with no model: what can be looked up or computed exactly is (prices, drop tables, relics, the world
 * state, the Circuit rotation, mastery ranks, sums, clan events, item cards), and everything else is answered from the wiki
 * (the local copy, see src/wiki): links to the most relevant pages and, when the question names a page, the one sentence of it
 * that answers best, quoted word for word. Nothing is ever written or guessed.
 */

/** Who is asking. */
export interface Asker {
  id: string;
  name: string;
}

export interface SmartAnswer {
  content: string;
  embeds: EmbedBuilder[];
  /** False when nothing useful was found. */
  found: boolean;
  /** Nothing to reply to (a link, a reaction, chatter): the chat channel stays quiet. */
  silent?: boolean;
  /** For the AI log: how the answer was produced. Filled in by smartAnswer. */
  source?: AiSource;
  model?: string | null;
  intent?: string;
  ms?: number;
  /** Why the answer needs a look (it is logged and listed by the MCP tool answers_to_review). */
  review?: string | null;
}

/** Ordis's voice: one short line before the data. */
const LINES: Record<string, string[]> = {
  price: ['Ordis has consulted the market, Operator.', 'The traders of the Relays report the following, Operator.', 'Market data acquired. Ordis advises haggling -- RUTHLESSLY -- politely.'],
  relic: ['Ordis has scanned the relic, Operator.', 'The Void whispers its contents, Operator.'],
  world: ['Ordis has checked the Origin System, Operator.', 'Current readings, Operator.', 'Ordis is happy to report -- EVERYTHING IS FINE -- the following.'],
  item: ['Ordis has pulled the Codex entry, Operator.', 'Arsenal data, Operator.'],
  drops: ['The drop tables, Operator.', 'Ordis has searched the drop tables, Operator.'],
  clan: ['Clan schedule, Operator.'],
};
const pick = (xs: string[]): string => xs[Math.floor(Math.random() * xs.length)]!;

export const HELP_TEXT = [
  'Operator! Ordis can answer questions like these:',
  '• **Prices:** "price of Arcane Energize", "how much is Wisp Prime set worth?"',
  '• **Drops:** "where does Neo N16 drop?", "where does Bite drop?"',
  '• **Items:** "Kuva Bramma stats", "what\'s in Axi A1?"',
  '• **Right now:** "when is Baro coming?", "is it night on Cetus?", "steel path axi fissures", "today\'s sortie", "Entrati bounties", "when can I get the Torid Incarnon?"',
  '• **Your clan:** "when is our next clan event?"',
  '• **Anything else:** Ordis links the wiki pages that answer it ("how do Archon Shards work?").',
  '• **Wrong answer?** Reply to it with the right one (no question mark). When an admin replies it takes effect at once; other replies go to the admins to approve.',
  'Slash commands: `/item` `/price` `/drops` `/wiki` `/wf` `/track` `/event` `/lfg` `/clan`.',
].join('\n');

function worldEmbed(ws: WorldState, view: WorldView): EmbedBuilder {
  switch (view) {
    case 'baro':
      return baroEmbed(ws);
    case 'sortie':
      return sortieEmbed(ws);
    case 'archon':
      return archonEmbed(ws);
    case 'steelpath':
      return steelPathEmbed(ws);
    case 'nightwave':
      return nightwaveEmbed(ws);
    case 'invasions':
      return invasionsEmbed(ws);
    case 'deals':
      return dealsEmbed(ws);
    case 'events':
      return eventsEmbed(ws);
    case 'archimedea':
      return archimedeaEmbed(ws);
    case 'resurgence':
      return resurgenceEmbed(ws);
    case 'cycles':
      return cyclesEmbed(ws);
  }
}

/** "9 x 2" → "9 × 2 = **18**", or null when it isn't a sum calculate() accepts. */
export function mathAnswer(expression: string): string | null {
  try {
    const result = Number(calculate(expression).toPrecision(12));
    const shown = result.toLocaleString('en-US', { maximumFractionDigits: 6 });
    return `${expression.replace(/\s+/g, ' ').replace(/(?<=\d)\s*[x×]\s*(?=\d)/g, ' × ').trim()} = **${shown}**`;
  } catch {
    return null;
  }
}

/** Drop tables of the item itself or of its blueprints ("Wisp" → Wisp Chassis Blueprint…), never of items that merely contain the word. */
export function relevantDrops(groups: DropGroup[], name: string): DropGroup[] {
  const n = name.toLowerCase().trim();
  const prime = /\bprime\b/.test(n);
  return groups
    .filter((g) => {
      const item = g.item.toLowerCase();
      if (item === n || item === `${n} blueprint`) return true;
      return item.startsWith(`${n} `) && item.endsWith(' blueprint') && (prime || !/\bprime\b/.test(item));
    })
    .slice(0, 4);
}

const SECONDARY_ELEMENTS = ['Blast', 'Corrosive', 'Gas', 'Magnetic', 'Radiation', 'Viral'];
const ELEMENT_WORDS = /\b(combin\w*|combos?|elements?|elemental|secondary)\b/i;
const MAKE_WORDS = /\b(get|gain|make|made|create|build|apply|proc|need|combine|mods?)\b/i;

/**
 * "All damage combinations", "how do I get Viral on my gun": the recipe of each secondary element, read from the first sentence
 * of its wiki page ("composed of Cold and Toxin"). All six for a combinations question, only the named ones otherwise.
 */
export async function elementsAnswer(question: string, read: (title: string, maxChars: number) => Promise<WikiResult | null> = readWikiPage): Promise<string | null> {
  const named = SECONDARY_ELEMENTS.filter((e) => new RegExp(`\\b${e}\\b`, 'i').test(question));
  if (!ELEMENT_WORDS.test(question) && !(named.length && MAKE_WORDS.test(question))) return null;
  const wanted = ELEMENT_WORDS.test(question) || !named.length ? SECONDARY_ELEMENTS : named;
  const lines: string[] = [];
  for (const e of wanted) {
    const page = await read(`Damage/${e} Damage`, 600).catch(() => null);
    const m = page ? /composed of (\w+) and (\w+)/i.exec(page.extract) : null;
    if (m) lines.push(`**${e}** = ${m[1]} + ${m[2]}`);
  }
  if (lines.length < Math.min(3, wanted.length)) return null;
  return `${lines.join('\n')}\n${links(['Damage'])}`;
}

/** The wiki pages as one line of links (no previews). */
export const links = (titles: string[]): string => `📖 ${titles.map((t) => `[${t}](<${pageUrl(t)}>)`).join(' · ')}`;

const searchLink = (q: string) => `<https://wiki.warframe.com/index.php?search=${encodeURIComponent(q.slice(0, 100))}>`;

/** The page the question names in the local wiki ("how do archon shards work" → Archon Shard), or null. */
const namedPage = (question: string): string | null => {
  const index = getWikiIndex();
  return index?.ready() ? index.subjectOf(question) : null;
};

/**
 * The answer from the wiki: the most relevant pages as links, and when the question names a page, the sentence of it that fits
 * the question best, quoted. A page that merely shares a word with the question is linked but never quoted, since the
 * sentence would be out of context.
 */
export async function wikiAnswer(question: string): Promise<SmartAnswer> {
  const results = await searchWiki(question, 3, { pageChunks: 3, pageChars: 2600 }).catch(() => [] as WikiResult[]);
  if (!results.length) {
    return { content: `Ordis found nothing on the wiki for that, Operator. Try other words, or search it yourself: ${searchLink(question)}`, embeds: [], found: false, source: 'lookup', review: 'nothing found on the wiki' };
  }
  const named = namedPage(question);
  // Only a sentence of the named page itself is quoted (its passages from the search, else the page read whole).
  const own = named ? results.filter((r) => r.title.toLowerCase() === named.toLowerCase()) : [];
  const page = named && !own.length ? await readWikiPage(named, 2600).catch(() => null) : null;
  const direct = named ? answerFrom(question, page ? [page] : own, 400, 1) : null;
  // "Best tellurium farm": the wiki's farming guide for it, when there is one, is the best link.
  const guide = named && BEST_FARM.test(question) ? await readWikiPage(`${named.replace(/\s*\([^)]*\)$/, '')} Farming Guide`, 100).catch(() => null) : null;
  const titles = [...new Set([guide?.title, direct?.source.title, named, ...results.map((r) => r.title)].filter((t): t is string => Boolean(t)))].slice(0, 3);
  const quote = direct ? `> ${direct.text.replace(/\s+/g, ' ')}\n` : '';
  return { content: `${quote}${links(titles)}`, embeds: [], found: true, source: direct ? 'excerpt' : 'lookup', review: direct ? null : 'links only: no sentence of a named page fit the question' };
}

/** The item card for a name the member typed, when the item database has exactly that item ("helminth" is not the Helminth Charger). */
async function itemCard(name: string, line: string): Promise<SmartAnswer | null> {
  const result = await lookupItem(name).catch(() => null);
  if (!result) return null;
  const found = (result.kind === 'relic' ? result.relic.name : result.item.name).toLowerCase().replace(/ relic$/, '');
  if (found !== name.toLowerCase().trim().replace(/ relic$/, '')) return null;
  let drops;
  if (showsDrops(result) && result.kind === 'item') {
    const groups = await searchDrops(result.item.name, 6, 10).catch(() => []);
    drops = groups.find((g) => g.item.toLowerCase() === result.item.name.toLowerCase())?.locations;
  }
  const title = result.kind === 'relic' ? null : (namedPage(result.item.name) ?? result.item.name);
  return { content: title ? `${line}\n${links([title])}` : line, embeds: [result.kind === 'relic' ? relicEmbed(result.relic) : lookupEmbed(result, drops)], found: true };
}

/**
 * "where does Bite drop": the drop tables of the item and its blueprints, with its wiki page. The page the question names is
 * tried first ("the mod bite" is the page Bite), then the words the intent rules took for the item. Null when the tables have nothing.
 */
async function dropsAnswer(question: string, item: string): Promise<SmartAnswer | null> {
  const page = namedPage(question);
  // "Kuva (Resource)" is called "Kuva" in the drop tables.
  const names = [...new Set([page, item].map((n) => n?.replace(/\s*\([^)]*\)$/, '').trim()).filter((n): n is string => Boolean(n && n.length >= 3)))];
  for (const name of names) {
    const groups = relevantDrops(await searchDrops(name, 6, 20).catch(() => []), name);
    if (!groups.length) continue;
    const title = page ?? namedPage(name);
    return { content: title ? `${pick(LINES.drops!)}\n${links([title])}` : pick(LINES.drops!), embeds: [dropsEmbed(groups[0]!.item, groups)], found: true };
  }
  return null;
}

const BEST_FARM = /\b(best|fastest|quickest|easiest|efficient|optimal|good)\b[^?]*\b(farm|farming|grind|grinding|way|place|spot)\b/i;

/** Intents with an exact answer from live data or a database. */
async function exactAnswer(intent: Intent, question: string, ctx: AppContext): Promise<SmartAnswer | null> {
  switch (intent.kind) {
    case 'help':
      return { content: HELP_TEXT, embeds: [], found: true };

    case 'price': {
      try {
        const result = await priceCheck(intent.item, ctx.config.WARFRAME_PLATFORM);
        return { content: pick(LINES.price!), embeds: [priceEmbed(result)], found: true };
      } catch {
        return { content: `Ordis found no tradable item called "${intent.item}" on warframe.market, Operator. Check the spelling, or try \`/price\` for autocomplete.`, embeds: [], found: false };
      }
    }

    case 'relic': {
      const result = await lookupItem(intent.name).catch(() => null);
      return result?.kind === 'relic' ? { content: pick(LINES.relic!), embeds: [relicEmbed(result.relic)], found: true } : null;
    }

    case 'world': {
      const ws = await getWorldState();
      return { content: pick(LINES.world!), embeds: [worldEmbed(ws, intent.view)], found: true };
    }

    case 'fissures': {
      const ws = await getWorldState();
      const list = filterFissures(ws.fissures, { tier: intent.tier, steelPath: intent.steelPath, storm: intent.storm });
      return { content: pick(LINES.world!), embeds: [fissuresEmbed(list)], found: true };
    }

    case 'bounties': {
      const ws = await getWorldState();
      if (!intent.syndicate) {
        const open = BOUNTY_SYNDICATES.filter((s) => ws.syndicateMissions?.some((m) => m.syndicate === s && m.jobs?.length));
        return {
          content: `Which syndicate, Operator? Bounties are up for **${open.join('**, **') || 'nobody right now'}**. Ask e.g. "Entrati bounties", or use \`/wf bounties\`.`,
          embeds: [],
          found: true,
        };
      }
      return { content: pick(LINES.world!), embeds: [bountiesEmbed(ws, intent.syndicate)], found: true };
    }

    case 'clanEvents': {
      const events = ctx.store.upcomingEvents(ctx.config.DISCORD_GUILD_ID).slice(0, 8);
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(`${ctx.config.CLAN_NAME}: upcoming events`)
        .setDescription(
          events.length
            ? clampLines(events.map((e) => `**${e.title}** — ${e.endsAt !== null && e.startsAt <= Date.now() ? `🟢 live, ends ${discordTime(e.endsAt)}` : `${discordTime(e.startsAt, 'f')} (${discordTime(e.startsAt)})${e.endsAt ? ` → ${discordTime(e.endsAt, 't')}` : ''}`} · ${ctx.store.getRsvps(e.id).going.length} going`))
            : 'Nothing scheduled yet. Create one with `/event create`.',
        );
      return { content: pick(LINES.clan!), embeds: [embed], found: true };
    }

    case 'drops':
      // "Best kuva farm": a drop table ranks a guaranteed drop from one enemy first, which is not the best farm the wiki describes.
      return BEST_FARM.test(question) ? null : dropsAnswer(question, intent.item);

    case 'item':
      return itemCard(intent.name, pick(LINES.item!));

    case 'build':
      return itemCard(intent.item, pick(LINES.item!));

    default:
      return null;
  }
}

/**
 * "Ordis, how do I …" → "how do I …": the name is how members address him, not part of the question. Only before a comma or
 * the like, or a question word: "Ordis is dumb" is about Ordis, and "is dumb" would read like a question.
 */
export function withoutName(q: string): string {
  const m = /^\s*(?:hey\s+|ok\s+)?ordis\b([\s,:;!.-]*)([\s\S]*)$/i.exec(q);
  const rest = m?.[2]?.trim();
  if (!m || !rest) return q;
  return /[,:;!.-]/.test(m[1]!) || /^(how|what|whats|what's|where|when|whens|why|who|which|can|could|should|would|will|do|does|did|tell|give|show|list|find|check|research|search|explain|help|please)\b/i.test(rest) ? rest : q;
}

/** Answers a chat message: a staff correction, an exact lookup, or the wiki. */
export async function smartAnswer(raw: string, ctx: AppContext): Promise<SmartAnswer> {
  const question = withoutName(raw);
  const intent = detectIntent(question);
  const started = Date.now();
  const done = (a: SmartAnswer, kind?: string): SmartAnswer => ({ ...a, source: a.source ?? 'lookup', model: null, intent: a.intent ?? kind ?? intent.kind, ms: Date.now() - started });

  // A staff correction (see answers/corrections.ts) for exactly this question wins over everything else.
  const fix = findCorrection(ctx, question);
  if (fix) return { content: fix.correction, embeds: [], found: true, source: 'correction', model: null, intent: 'correction', ms: Date.now() - started };
  if (thanks(question)) return done({ content: 'Always, Operator. Ordis lives to serve.', embeds: [], found: true }, 'smalltalk');
  // A link, an emoji or "lol" has nothing to look up.
  if (noContent(question)) return done({ content: '', embeds: [], found: false, silent: true }, 'smalltalk');

  const expression = mathExpression(question);
  const sum = expression ? mathAnswer(expression) : null;
  if (sum) return done({ content: sum, embeds: [], found: true }, 'math');
  const circuit = await circuitAnswer(question).catch(() => null);
  if (circuit) return done({ content: circuit, embeds: [], found: true }, 'circuit');
  const mastery = masteryAnswer(question);
  if (mastery) return done({ content: mastery, embeds: [], found: true }, 'mastery');
  const elements = await elementsAnswer(question).catch(() => null);
  if (elements) return done({ content: elements, embeds: [], found: true }, 'elements');

  // A bare item name or a stats question gets the item card; other questions about an item go to the wiki.
  const asksStats = !questionLike(question) || /\b(stats?|statistics|abilities)\b/i.test(question);
  if (intent.kind !== 'item' || asksStats) {
    const exact = await exactAnswer(intent, question, ctx);
    if (exact) return done(exact);
  }
  // Chatter (no question, and no wiki page named but maybe Ordis himself) gets no reply.
  const named = namedPage(question);
  if (!questionLike(question) && (!named || /^(cephalon )?ordis$/i.test(named))) return done({ content: '', embeds: [], found: false, silent: true }, 'smalltalk');
  return done(await wikiAnswer(question), 'wiki');
}
