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
import { lookupEmbed, relicEmbed, showsDrops, wikiEmbed } from '../discord/lookup-embeds.js';
import { discordTime } from '../time.js';
import { searchDrops } from '../warframe/drops.js';
import { lookupItem } from '../warframe/items.js';
import { priceCheck } from '../warframe/market.js';
import { asPassages, webSearch } from '../warframe/websearch.js';
import { searchWiki } from '../warframe/wiki.js';
import type { AiSource } from '../db.js';
import { composeDetailed } from './compose.js';
import { agentAnswer, useAgent } from '../agent/answer.js';
import { type StatusListener, reportStatus, withStatus } from './status.js';
import { QueueFullError } from '../queue.js';
import { withAsker, withModelSlot } from './slot.js';
import { brain } from '../agent/brain.js';
import { cacheAllowedFor, getCachedAnswer, noteCacheHit } from './cache.js';
import { findCorrection, guidanceFor } from './corrections.js';
import { isFollowUp, recall, remember, transcript } from './memory.js';
import { isOperatorId, operatorAnswer, useOperatorMode } from './operator.js';
import { type WorldState, filterFissures, getWorldState } from '../warframe/worldstate.js';
import { type Intent, type WorldView, cleanQuestion, detectIntent } from './intent.js';

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
}

/** One of the in-character intro lines; below Ordis-ness 10 a neutral one. */
const pick = (xs: string[]): string => (brain().ordisness < 10 ? 'Here you go.' : xs[Math.floor(Math.random() * xs.length)]!);

/** Ordis's voice: one short line before the data, with the occasional glitch. */
const LINES: Record<string, string[]> = {
  price: ['Ordis has consulted the market, Operator.', 'The traders of the Relays report the following, Operator.', 'Market data acquired. Ordis advises haggling -- RUTHLESSLY -- politely.'],
  drops: ['Ordis has searched the drop tables, Operator.', 'Here is where to find it, Operator. Happy hunting!'],
  relic: ['Ordis has scanned the relic, Operator.', 'The Void whispers its contents, Operator.'],
  world: ['Ordis has checked the Origin System, Operator.', 'Current readings, Operator.', 'Ordis is happy to report -- EVERYTHING IS FINE -- the following.'],
  item: ['Ordis has pulled the Codex entry, Operator.', 'Arsenal data, Operator.'],
  build: ['Ordis cannot mod for you, Operator, but here is what you are working with.'],
  wiki: ['Ordis knows this one, Operator:', 'Ordis consulted the archives, Operator:'],
  clan: ['Clan schedule, Operator.'],
};

export const HELP_TEXT = [
  'Operator! Ordis can answer questions like these:',
  '• **Prices:** "price of Arcane Energize", "how much is Wisp Prime set worth?"',
  '• **Farming:** "where does Neo N16 drop?", "how do I get Condition Overload?"',
  '• **Items:** "Kuva Bramma stats", "what\'s in Axi A1?"',
  '• **Right now:** "when is Baro coming?", "is it night on Cetus?", "steel path axi fissures", "today\'s sortie", "Entrati bounties", "what is Varzia selling?"',
  '• **Your clan:** "when is our next clan event?"',
  '• **Anything else:** Ordis checks the wiki ("how do Archon Shards work?").',
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

async function wikiAnswer(query: string, ctx: AppContext, extra = ''): Promise<SmartAnswer> {
  reportStatus('🔎 Searching the wiki');
  const [results, web] = await Promise.all([searchWiki(query, 3).catch(() => []), webSearch(ctx.config.SEARXNG_URL, query, 2)]);
  if (!results.length && !web.length) {
    return {
      content: `Ordis searched everywhere, Operator, but found nothing on "${query}". Try rephrasing, or ask Ordis "help".`,
      embeds: [],
      found: false,
    };
  }
  reportStatus('✍️ Writing the answer');
  // With a free-tier model configured, the excerpts are worded into a real answer; the source stays below it.
  const written = await withModelSlot(() => composeDetailed(ctx.config, query, [...results, ...asPassages(web)], fetch, Date.now(), extra));
  if (written) return { content: written.text, embeds: [wikiEmbed(query, results.length ? results : asPassages(web), true)], found: true, source: written.via, model: written.model };
  if (!results.length) return { content: pick(LINES.wiki!), embeds: [wikiEmbed(query, asPassages(web))], found: true, source: 'excerpt' };
  return { content: pick(LINES.wiki!), embeds: [wikiEmbed(query, results)], found: true, source: 'excerpt' };
}

async function itemAnswer(name: string, line: string, fallbackQuery: string, ctx: AppContext, extra = ''): Promise<SmartAnswer> {
  const result = await lookupItem(name).catch(() => null);
  if (!result) return wikiAnswer(fallbackQuery, ctx, extra);
  let drops;
  if (showsDrops(result) && result.kind === 'item') {
    const groups = await searchDrops(result.item.name, 6, 10).catch(() => []);
    drops = groups.find((g) => g.item.toLowerCase() === result.item.name.toLowerCase())?.locations;
  }
  return { content: line, embeds: [lookupEmbed(result, drops)], found: true };
}

async function answerIntent(intent: Intent, question: string, ctx: AppContext, extra = ''): Promise<SmartAnswer> {
  const fallback = cleanQuestion(question);
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

    case 'drops': {
      const groups = await searchDrops(intent.item).catch(() => []);
      if (groups.length) return { content: pick(LINES.drops!), embeds: [dropsEmbed(intent.item, groups)], found: true };
      // Not in the drop tables (e.g. a Warframe or a place): the item card or the wiki explains how to get it.
      return itemAnswer(intent.item, pick(LINES.item!), fallback, ctx, extra);
    }

    case 'relic': {
      const result = await lookupItem(intent.name).catch(() => null);
      if (result?.kind === 'relic') return { content: pick(LINES.relic!), embeds: [relicEmbed(result.relic)], found: true };
      return wikiAnswer(fallback, ctx, extra);
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
            ? clampLines(events.map((e) => `**${e.title}** — ${discordTime(e.startsAt, 'f')} (${discordTime(e.startsAt)}) · ${ctx.store.getRsvps(e.id).going.length} going`))
            : 'Nothing scheduled yet. Create one with `/event create`.',
        );
      return { content: pick(LINES.clan!), embeds: [embed], found: true };
    }

    case 'build': {
      const answer = await itemAnswer(intent.item, pick(LINES.build!), fallback, ctx, extra);
      if (answer.found) {
        const q = encodeURIComponent(intent.item);
        answer.content += `\nCommunity builds: <https://overframe.gg/search/?q=${q}> · wiki: <https://wiki.warframe.com/index.php?search=${q}>`;
      }
      return answer;
    }

    case 'item':
      return itemAnswer(intent.name, pick(LINES.item!), fallback, ctx, extra);

    case 'wiki':
      return wikiAnswer(intent.query, ctx, extra);
  }
}

/** Answers a chat question from live data and the wiki, without any AI model. */
export function smartAnswer(question: string, ctx: AppContext, asker?: Asker, onStatus?: StatusListener): Promise<SmartAnswer> {
  return withStatus(onStatus, () =>
    withAsker(asker?.id ?? '', () => smartAnswerInner(question, ctx, asker))
      .then((answer) => {
        // The exchange goes into this person's conversation memory (see answers/memory.ts) so a follow-up can lean on it.
        if (asker?.key && answer.found && answer.intent !== 'busy' && brain().memoryMessages > 0) remember(asker.key, question, answer.content.replace(/\n-# [^\n]*$/, ''));
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

async function smartAnswerInner(question: string, ctx: AppContext, asker?: Asker): Promise<SmartAnswer> {
  const intent = detectIntent(question);
  const started = Date.now();
  // The conversation so far (the Brain page's memory slider) and what makes this a follow-up: such a message only makes sense with that context.
  const history = asker?.key ? recall(asker.key, brain().memoryMessages) : [];
  const followUp = history.length > 0 && isFollowUp(question);
  // A staff correction (see answers/corrections.ts) for exactly this question wins over everything else, a saved answer included.
  const fix = followUp ? null : findCorrection(ctx, question);
  if (fix) return { content: fix.correction, embeds: [], found: true, source: 'correction', model: null, intent: 'correction', ms: Date.now() - started };
  // Staff corrections and rated answers related to this question, plus the conversation, for the models.
  const lastUser = [...history].reverse().find((t) => t.role === 'user')?.content ?? '';
  const guidance = guidanceFor(ctx, followUp ? `${lastUser} ${question}` : question);
  const extra = [guidance, history.length ? `Conversation so far (context only; answer the newest question):\n${transcript(history)}` : ''].filter(Boolean).join('\n\n');
  // Prices, drops, relics, world state and the clan schedule stay plain API lookups for everyone, operators included.
  // A saved, verified answer to a repeat question (see answers/cache.ts): same answer every time, no model call. Operators always get a fresh one.
  if (!followUp && !(asker && isOperatorId(ctx.config, asker.id)) && cacheAllowedFor(intent.kind)) {
    const hit = getCachedAnswer(ctx, question);
    if (hit) {
      noteCacheHit(ctx, hit);
      const sources = await searchWiki(cleanQuestion(question), 3).catch(() => []);
      return { content: hit.answer, embeds: sources.length ? [wikiEmbed(question, sources, true)] : [], found: true, source: 'cache', model: hit.model, intent: intent.kind, ms: Date.now() - started };
    }
  }
  // The agent (tools it picks itself, see src/agent) comes first where it is switched on; the operator answer and the plain lookups are the fallbacks.
  const who = asker ?? { id: '', name: 'a clan member' };
  const agent = useAgent(ctx, who.id, intent.kind, followUp) ? await withModelSlot(() => agentAnswer(ctx, question, who, { history, guidance })) : null;
  const operator = !agent && asker && useOperatorMode(ctx.config, asker.id, intent.kind) ? await withModelSlot(() => operatorAnswer(ctx, question, asker.name, extra)) : null;
  const answer = agent ?? operator ?? (await answerIntent(intent, question, ctx, extra));
  return { ...answer, source: answer.source ?? 'lookup', model: answer.model ?? null, intent: answer.intent ?? intent.kind, ms: Date.now() - started };
}
