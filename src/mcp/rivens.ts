import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { rivenTrace, scanLog, scanTotals } from '../rivens/channel.js';
import { gradeFor, rivenStatus, topFor } from '../rivens/service.js';
import { READ_ONLY, tool } from './util.js';

/**
 * Riven analyzer over MCP (same data as /riven): grade a roll by how common it is among the expensive listings on warframe.market,
 * see what sells for a weapon, and check how much the slow background read has gathered.
 */
export function registerRivenTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'grade_riven',
    {
      title: 'Grade a riven',
      description:
        "Grades a riven roll (S best to D) by how common its bonus stats are among the expensive riven listings on warframe.market, and shows what similar rolls are listed for (asking prices, not sales). Stats can be names or short forms (cc, cd, ms, sc, dmg...); values are optional.",
      inputSchema: {
        weapon: z.string().min(2).max(80).describe('Weapon name, e.g. "Kuva Bramma"'),
        bonuses: z.string().min(2).max(200).describe('The 2 or 3 bonus stats, e.g. "cc cd ms" or "Critical Chance 180, Multishot 120"'),
        curse: z.string().max(60).optional().describe('The curse, e.g. "zoom"'),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ weapon, bonuses, curse }) => {
      const r = await gradeFor(ctx, { weapon, positives: bonuses, negative: curse });
      const name = (slug: string) => r.names[slug] ?? slug;
      if (!r.grade) return { weapon: r.weapon.name, grade: null, listings: r.listings, note: 'Too few listings on warframe.market to compare with.' };
      const g = r.grade;
      return {
        weapon: r.weapon.name,
        grade: g.letter,
        stats: g.stats.map((s) => ({ stat: name(s.slug), shareOfExpensiveRivens: Number(s.share.toFixed(2)), rank: s.rank, rollPercentile: s.percentile === null ? null : Number(s.percentile.toFixed(2)) })),
        curse: g.negative ? { stat: name(g.negative.slug), shareOfExpensiveRivens: Number(g.negative.share.toFixed(2)), rank: g.negative.rank } : null,
        expensiveRivensWithExactBonuses: g.exact,
        // source 'market': asked warframe.market for exactly these bonuses (complete = that is everything for sale); 'top': only the weapon's priciest stored listings, so prices lean high.
        comparableListings: g.comparable,
        marketChecked: g.marketChecked,
        comparedWith: { ...g.bracket, highPriceLine: r.minPrice },
        dataReadAt: r.fetchedAt ? new Date(r.fetchedAt).toISOString() : null,
        stale: r.stale,
      };
    }),
  );

  server.registerTool(
    'riven_top_rolls',
    {
      title: 'What sells for a weapon',
      description: "The bonus stats, curses and exact combinations that the expensive riven listings of a weapon have on warframe.market, most common first.",
      inputSchema: { weapon: z.string().min(2).max(80) },
      annotations: READ_ONLY,
    },
    tool(async ({ weapon }) => {
      const r = await topFor(ctx, weapon);
      const name = (slug: string) => r.names[slug] ?? slug;
      if (!r.top) return { weapon: r.weapon.name, listings: r.listings, note: 'Too few listings on warframe.market to compare with.' };
      return {
        weapon: r.weapon.name,
        comparedWith: { ...r.top.bracket, highPriceLine: r.minPrice },
        bonusStats: r.top.stats.map((s) => ({ stat: name(s.slug), share: Number(s.share.toFixed(2)) })),
        curses: r.top.negatives.map((s) => ({ stat: name(s.slug), share: Number(s.share.toFixed(2)) })),
        combinations: r.top.combos.map((c) => ({ stats: c.slugs.map(name), listings: c.count, medianPrice: c.median })),
        dataReadAt: r.fetchedAt ? new Date(r.fetchedAt).toISOString() : null,
      };
    }),
  );

  server.registerTool(
    'riven_status',
    {
      title: 'Riven analyzer status',
      description: 'How much riven data the slow background read has gathered (weapons read, listings stored, last read, recent problems, whether it is paused).',
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    tool(async () => ({
      ...(await rivenStatus(ctx)),
      channel: { ...rivenTrace(), messageContentOn: ctx.config.ENABLE_MESSAGE_CONTENT, scans: scanTotals(), latest: scanLog().slice(0, 5) },
    })),
  );
}
