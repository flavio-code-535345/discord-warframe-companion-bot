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
import { searchDrops } from '../warframe/drops.js';
import { lookupItem } from '../warframe/items.js';
import { priceCheck } from '../warframe/market.js';
import { getWikiIndex } from '../wiki/index.js';
import type { AiSource } from '../db.js';
import { agentAnswer, agentFits, useAgent } from '../agent/answer.js';
import { type StatusListener, withStatus } from './status.js';
import { QueueFullError } from '../queue.js';
import { withAsker, withModelSlot } from './slot.js';
import { brain } from '../agent/brain.js';
import { circuitAnswer } from './circuit.js';
import { masteryAnswer } from './mastery.js';
import { findCorrection, guidanceFor } from './corrections.js';
import { isFollowUp, recall, recallSubject, remember, transcript } from './memory.js';
import { operatorAnswer, useOperatorMode } from './operator.js';
import { factAnswer, mathAnswer, smallTalkAnswer } from './pipeline.js';
import { classifyAsk, mathExpression, noContent, questionLike, wantsResearch } from './understand.js';
import { type WorldState, filterFissures, getWorldState } from '../warframe/worldstate.js';
import { type Intent, type WorldView, detectIntent } from './intent.js';

/** Who is asking. `key` (memoryKey of channel and person) turns on conversation memory for the exchange. */
export interface Asker {
  id: string;
  name: string;
  key?: string;
}

export interface SmartAnswer {
  content: string;
  embeds: EmbedBuilder[];
  /** False when nothing useful was found, so a busy chat channel can stay quiet instead of replying "no idea". */
  found: boolean;
  /** For the AI log: how the answer was produced. Filled in by smartAnswer. */
  source?: AiSource;
  model?: string | null;
  intent?: string;
  ms?: number;
  /** The wiki page the answer was about, remembered so a follow-up ("and how do I get it?") knows what "it" is. */
  subject?: string | null;
  /** How a facts answer was made (for test_answer and debugging): the facts the model saw, its own words, what the check removed. */
  trace?: { facts: string[]; written?: string; removed?: string[] };
}

/** One of the in-character intro lines; below Ordis-ness 10 a neutral one. */
const pick = (xs: string[]): string => (brain().ordisness < 10 ? 'Here you go.' : xs[Math.floor(Math.random() * xs.length)]!);

/** Ordis's voice: one short line before the data, with the occasional glitch. */
const LINES: Record<string, string[]> = {
  price: ['Ordis has consulted the market, Operator.', 'The traders of the Relays report the following, Operator.', 'Market data acquired. Ordis advises haggling -- RUTHLESSLY -- politely.'],
  relic: ['Ordis has scanned the relic, Operator.', 'The Void whispers its contents, Operator.'],
  world: ['Ordis has checked the Origin System, Operator.', 'Current readings, Operator.', 'Ordis is happy to report -- EVERYTHING IS FINE -- the following.'],
  item: ['Ordis has pulled the Codex entry, Operator.', 'Arsenal data, Operator.'],
  build: ['Ordis cannot mod for you, Operator, but here is what you are working with.'],
  clan: ['Clan schedule, Operator.'],
};

export const HELP_TEXT = [
  'Operator! Ordis can answer questions like these:',
  '• **Prices:** "price of Arcane Energize", "how much is Wisp Prime set worth?"',
  '• **Farming:** "where does Neo N16 drop?", "how do I get Condition Overload?", "best kuva farm?"',
  '• **Items:** "Kuva Bramma stats", "what\'s in Axi A1?"',
  '• **Right now:** "when is Baro coming?", "is it night on Cetus?", "steel path axi fissures", "today\'s sortie", "Entrati bounties", "when can I get the Torid Incarnon?"',
  '• **Your clan:** "when is our next clan event?"',
  '• **Anything else:** Ordis checks the wiki ("how do Archon Shards work?"). Add "check reddit" to include Warframe sites on the web.',
  '• **Just write:** in the chat channel Ordis answers anything, no question mark needed. He remembers your last few messages, so "and how do I get it?" works; reply to his answer to carry on.',
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
  return { content: line, embeds: [result.kind === 'relic' ? relicEmbed(result.relic) : lookupEmbed(result, drops)], found: true, subject: result.kind === 'item' ? result.item.name : null };
}

/** Intents with an exact answer from live data or a database: no model, no wiki. */
const EXACT = new Set<Intent['kind']>(['help', 'price', 'relic', 'world', 'fissures', 'bounties', 'clanEvents']);

async function exactAnswer(intent: Intent, ctx: AppContext): Promise<SmartAnswer | null> {
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

    default:
      return null;
  }
}

/** Answers a chat question: exact data where there is some, otherwise the facts pipeline (see pipeline.ts). */
export function smartAnswer(question: string, ctx: AppContext, asker?: Asker, onStatus?: StatusListener): Promise<SmartAnswer> {
  return withStatus(onStatus, () =>
    withAsker(asker?.id ?? '', () => smartAnswerInner(question, ctx, asker))
      .then((answer) => {
        // The exchange goes into this person's conversation memory (see answers/memory.ts) so a follow-up can lean on it.
        if (asker?.key && answer.found && answer.intent !== 'busy' && answer.intent !== 'smalltalk' && brain().memoryMessages > 0) {
          remember(asker.key, question, answer.content.replace(/\n-# [^\n]*$/, ''), Date.now(), answer.subject);
        }
        return answer;
      })
      .catch((err: unknown) => {
      if (!(err instanceof QueueFullError)) throw err;
      // Too many waiting: say so instead of failing, and keep it out of the saved answers (source 'lookup', intent 'busy').
      const content = err.reason === 'user' ? 'Ordis is already working on two of your questions, Operator. Wait for those answers first.' : 'Ordis has a long line of questions right now, Operator. Please ask again in a few minutes.';
      return { content, embeds: [], found: true, source: 'lookup', model: null, intent: 'busy', ms: 0 } as SmartAnswer;
    }),
  );
}

/**
 * "Ordis, how do I …" → "how do I …": the name is how operators address him in the chat channel, not part of the question. Only
 * before a comma or the like, or a question word: "Ordis is dumb" is about Ordis, and "is dumb" would read like a question.
 */
export function withoutName(q: string): string {
  const m = /^\s*(?:hey\s+|ok\s+)?ordis\b([\s,:;!.-]*)([\s\S]*)$/i.exec(q);
  const rest = m?.[2]?.trim();
  if (!m || !rest) return q;
  return /[,:;!.-]/.test(m[1]!) || /^(how|what|whats|what's|where|when|whens|why|who|which|can|could|should|would|will|do|does|did|tell|give|show|list|find|check|research|search|explain|help|please)\b/i.test(rest) ? rest : q;
}

async function smartAnswerInner(raw: string, ctx: AppContext, asker?: Asker): Promise<SmartAnswer> {
  const question = withoutName(raw);
  const intent = detectIntent(question);
  const started = Date.now();
  const done = (a: SmartAnswer, kind?: string): SmartAnswer => ({ ...a, source: a.source ?? 'lookup', model: a.model ?? null, intent: a.intent ?? kind ?? intent.kind, ms: Date.now() - started });
  // The conversation so far (the Brain page's memory slider) and what makes this a follow-up: such a message only makes sense with that context.
  const history = asker?.key ? recall(asker.key, brain().memoryMessages) : [];
  const followUp = history.length > 0 && isFollowUp(question);
  const previous = followUp ? ([...history].reverse().find((t) => t.role === 'user')?.content ?? null) : null;
  // A staff correction (see answers/corrections.ts) for exactly this question wins over everything else, a saved answer included.
  const fix = followUp ? null : findCorrection(ctx, question);
  if (fix) return { content: fix.correction, embeds: [], found: true, source: 'correction', model: null, intent: 'correction', ms: Date.now() - started };
  // A link, an emoji, "lol" or a bare "thanks" (also after an answer) gets a fixed line: there is nothing to look up.
  if (noContent(question)) return done(await smallTalkAnswer(ctx, question, true), 'smalltalk');

  // Exact answers need no model: plain arithmetic, and the Circuit's weekly rotation (computed from the wiki's table and the world state).
  const expression = mathExpression(question);
  const sum = expression ? mathAnswer(expression) : null;
  if (sum) return done({ content: sum, embeds: [], found: true }, 'math');
  const circuit = await circuitAnswer(previous ? `${previous} ${question}` : question).catch(() => null);
  if (circuit) return done({ content: circuit, embeds: [], found: true }, 'circuit');
  const mastery = masteryAnswer(question);
  if (mastery) return done({ content: mastery, embeds: [], found: true }, 'mastery');

  // Prices, relics, world state, fissures, bounties and the clan schedule stay plain lookups for everyone, operators included.
  if (!followUp && EXACT.has(intent.kind)) {
    const exact = await exactAnswer(intent, ctx);
    if (exact) return done(exact);
  }
  // A bare item name or a stats question gets the item card from the database.
  if (!followUp && intent.kind === 'item' && (!questionLike(question) || /\b(stats?|statistics|abilities)\b/i.test(question))) {
    const card = await itemCard(intent.name, pick(LINES.item!));
    if (card) return done(card);
  }
  // Chatter (no question, and nothing from the game named but maybe Ordis himself) gets a short line, never a wiki lookup.
  const index = getWikiIndex();
  const named = index?.ready() ? index.subjectOf(question) : undefined;
  if (!followUp && !questionLike(question) && intent.kind !== 'build' && named !== undefined && (!named || /^(cephalon )?ordis$/i.test(named))) {
    return done(await smallTalkAnswer(ctx, question, false), 'smalltalk');
  }
  // Operators may ask for a build: the model designs it, with the wiki as reference.
  const who = asker ?? { id: '', name: 'a clan member' };
  if (intent.kind === 'build') {
    const designed = asker && useOperatorMode(ctx.config, asker.id, 'build') ? await withModelSlot(() => operatorAnswer(ctx, question, asker.name)) : null;
    if (designed) return done(designed);
    const card = await itemCard(intent.item, pick(LINES.build!));
    if (card) {
      const q = encodeURIComponent(intent.item);
      card.content += `\nCommunity builds: <https://overframe.gg/search/?q=${q}> · wiki: <https://wiki.warframe.com/index.php?search=${q}>`;
      return done(card);
    }
  }

  // Everything else: the facts pipeline (gather the facts, the model words them, the check removes anything unsupported).
  const answer = await factAnswer(ctx, question, {
    ask: classifyAsk(question),
    subject: followUp && asker?.key ? recallSubject(asker.key) : null,
    previous,
    item: intent.kind === 'drops' ? intent.item : null,
    research: wantsResearch(question),
  });
  if (answer.found) return done(answer);

  // Nothing in the facts: where the Brain settings allow it, the agent may dig further with its tools, and an operator's question
  // may still get a free-form answer. Members get the honest "not found" with the closest pages.
  const guidance = guidanceFor(ctx, previous ? `${previous} ${question}` : question);
  const agent = useAgent(ctx, who.id, 'wiki', followUp) && agentFits(ctx) ? await withModelSlot(() => agentAnswer(ctx, question, who, { history, guidance })) : null;
  if (agent) return done(agent);
  const extra = [guidance, history.length ? `Conversation so far (context only; answer the newest question):\n${transcript(history)}` : ''].filter(Boolean).join('\n\n');
  const free = asker && useOperatorMode(ctx.config, asker.id, 'wiki') ? await withModelSlot(() => operatorAnswer(ctx, question, asker.name, extra)) : null;
  return done(free ?? answer);
}
