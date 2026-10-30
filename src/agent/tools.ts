import { aiToggle } from '../ai/settings.js';
import type { AppContext } from '../context.js';
import { DEFAULT_SECTIONS, SECTIONS, summarizeFissures, summarizeWorldState } from '../mcp/worldstate-summary.js';
import { searchDrops } from '../warframe/drops.js';
import { lookupItem, summarizeLookup } from '../warframe/items.js';
import { priceCheck } from '../warframe/market.js';
import { withTimeout } from '../timeout.js';
import { webSearch } from '../warframe/websearch.js';
import { readWikiPage, searchWiki } from '../warframe/wiki.js';
import { FISSURE_TIERS, filterFissures, getWorldState } from '../warframe/worldstate.js';
import { brain } from './brain.js';

/**
 * The agent's tools: the same data sources as the slash commands and the MCP, described for a model that picks them
 * itself. Provider-neutral JSON schemas (OpenAI-style function calling), no Discord types. Every tool returns text (JSON),
 * never throws to the model: errors come back as `{"error": ...}` so it can try something else.
 */

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema of the arguments (an object). */
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, unknown>, ctx: AppContext) => Promise<unknown>;
  /** Hidden from the model (and the panel) when this returns false. */
  available?: (ctx: AppContext) => boolean;
}

const string = (args: Record<string, unknown>, key: string, min = 1): string => {
  const v = args[key];
  if (typeof v !== 'string' || v.trim().length < min) throw new Error(`"${key}" must be a text of at least ${min} character${min === 1 ? '' : 's'}`);
  return v.trim().slice(0, 200);
};

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'get_worldstate',
    description:
      'Live Warframe world state. Sections: cycles (Cetus/Vallis/Cambion/Zariman/Earth/Duviri), sortie, archon, baro, steelpath, nightwave, invasions, alerts, deals (Darvo), events, archimedea (Deep/Temporal), bounties (syndicate jobs), resurgence (Varzia). Ask only for the sections you need.',
    parameters: { type: 'object', properties: { sections: { type: 'array', items: { type: 'string', enum: [...SECTIONS] }, description: 'Omit for everything except bounties and resurgence.' } } },
    run: async (args) => {
      const wanted = Array.isArray(args.sections) ? args.sections.filter((s): s is (typeof SECTIONS)[number] => (SECTIONS as readonly string[]).includes(String(s))) : [];
      return summarizeWorldState(await getWorldState(), wanted.length ? wanted : DEFAULT_SECTIONS);
    },
  },
  {
    name: 'get_fissures',
    description: 'Active Void fissures (relic cracking missions), optionally filtered by tier, Steel Path or Void Storm.',
    parameters: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: [...FISSURE_TIERS] },
        steel_path: { type: 'boolean' },
        void_storm: { type: 'boolean' },
      },
    },
    run: async (args) => {
      const tier = FISSURE_TIERS.find((t) => t === args.tier);
      return summarizeFissures(filterFissures((await getWorldState()).fissures, { tier, steelPath: args.steel_path === true ? true : undefined, storm: args.void_storm === true ? true : undefined }));
    },
  },
  {
    name: 'lookup_item',
    description:
      'Stats and details of a Warframe, weapon, mod, arcane, relic or other item: health/armor/abilities, damage/crit/status/riven disposition, mod effect at max rank, relic contents with intact/radiant chances and vaulted status.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Item name, e.g. "Wisp Prime", "Kuva Bramma", "Neo N16".' } }, required: ['name'] },
    run: async (args) => {
      const name = string(args, 'name', 2);
      const result = await lookupItem(name);
      return result ? summarizeLookup(result) : { error: `No item matches "${name}".` };
    },
  },
  {
    name: 'search_drops',
    description: 'Where an item, mod, resource, blueprint or relic drops, with drop chances in percent, from the official drop tables. Use the exact item name ("Ash Prime Systems Blueprint", "Lith A1"). Covers drops only: quest rewards, vendors and crafting are on the wiki.',
    parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
    run: async (args) => searchDrops(string(args, 'item', 2), 6, 4),
  },
  {
    name: 'price_check',
    description: 'Current warframe.market prices: cheapest online sellers and best online buyers, in platinum, for a tradable item (e.g. "Arcane Energize", "Wisp Prime Set").',
    parameters: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] },
    run: async (args, ctx) => {
      const p = await priceCheck(string(args, 'item', 2), ctx.config.WARFRAME_PLATFORM);
      const o = (x: (typeof p.sell)[number]) => ({ platinum: x.platinum, rank: x.rank, quantity: x.quantity, user: x.user.ingameName });
      return { item: p.item.name, url: p.url, sell: p.sell.slice(0, 5).map(o), buy: p.buy.slice(0, 5).map(o) };
    },
  },
  {
    name: 'search_wiki',
    description:
      'Search the Warframe wiki (a full local copy) for mechanics, how-tos, activities, lore and acquisition. Returns the 3 best pages with the passage that matches, and their URLs. Query with 1-4 keywords such as "Archon Shard" or "Helminth cyst", not a sentence. If the passage is thin, follow up with read_wiki_page.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async (args) => searchWiki(string(args, 'query', 2), 3),
  },
  {
    name: 'read_wiki_page',
    description: 'Read a whole Warframe wiki article as plain text (the first ~8,000 characters), by exact page title as returned by search_wiki. Use it when a search passage is cut off or lacks the detail asked for (numbers, steps, requirements).',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    run: async (args) => {
      const title = string(args, 'title');
      return (await readWikiPage(title)) ?? { error: `No wiki page titled "${title}".` };
    },
  },
  {
    name: 'search_web',
    description:
      'Fresh results from the open web, limited to Warframe sites (wiki, forums, official news, Overframe, the Warframe subreddits). Use it for recent updates, hotfixes, new content and patch changes, or when the wiki has nothing. Each result has a publish date when known. Slower than the other tools.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keywords; "warframe" is added for you.' } }, required: ['query'] },
    available: (ctx) => Boolean(ctx.config.SEARXNG_URL) && aiToggle('websearch'),
    run: async (args, ctx) => {
      const results = await webSearch(ctx.config.SEARXNG_URL, string(args, 'query', 2), 5);
      return results.length ? results : { error: 'The web search returned nothing useful.' };
    },
  },
  {
    name: 'get_clan_info',
    description: "This clan's upcoming events (with how many are going) and the in-game names of its registered members.",
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      const { config, store } = ctx;
      const guildId = config.DISCORD_GUILD_ID;
      return {
        clan: config.CLAN_NAME,
        upcomingEvents: store.upcomingEvents(guildId).slice(0, 10).map((e) => ({ title: e.title, description: e.description, startsAt: new Date(e.startsAt).toISOString(), endsAt: e.endsAt ? new Date(e.endsAt).toISOString() : null, going: store.getRsvps(e.id).going.length })),
        members: store.listMembers(guildId).map((m) => ({ ign: m.ign, masteryRank: m.masteryRank, platform: m.platform })),
      };
    },
  },
];

export const TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);

/** The tools the model may use right now: switched on in the brain and available in this deployment. */
export const enabledTools = (ctx: AppContext, tools: AgentTool[] = AGENT_TOOLS): AgentTool[] => {
  const off = new Set(brain().disabledTools);
  return tools.filter((t) => !off.has(t.name) && (t.available?.(ctx) ?? true));
};

/** Runs one tool for the model: the result as text, clipped; an error becomes `{"error": ...}`. Never throws. */
export async function runTool(tool: AgentTool, args: Record<string, unknown>, ctx: AppContext, clip: number): Promise<{ text: string; error: boolean }> {
  try {
    const out = await withTimeout(tool.run(args, ctx), 25_000, () => new Error('the tool took too long'));
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    return { text: s.length > clip ? `${s.slice(0, clip)}… (cut)` : s, error: false };
  } catch (err) {
    return { text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), error: true };
  }
}
