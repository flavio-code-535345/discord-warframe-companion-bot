import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { localModelOf } from '../ai/ollama.js';
import { localAvailable } from '../answers/compose.js';
import type { AppContext } from '../context.js';
import type { AiLogEntry, AiSource } from '../db.js';
import { levelOf, xpForLevel } from '../leveling/xp.js';
import { syncLevelRoles } from '../leveling/service.js';
import { UserError } from '../services/clan.js';
import { getWikiIndex } from '../wiki/index.js';
import { worldStateInfo } from '../warframe/worldstate.js';
import { READ_ONLY, snowflake, tool } from './util.js';

/**
 * Read-mostly tools for running the bot with an AI assistant: what members asked and who answered, whether the bot and
 * its models are healthy, and member levels (with a way to lift people to a level, e.g. when a level unlocks a permission).
 */

const SOURCES = ['local', 'cloud', 'excerpt', 'lookup'] as const satisfies readonly AiSource[];
const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/** Lower-cased, punctuation-free question, so "How do I unlock Venus?" and "how do i unlock venus" count as one. */
export const normalizeQuestion = (q: string): string => q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export interface AiLogSummary {
  count: number;
  bySource: Record<string, number>;
  byIntent: Record<string, number>;
  unanswered: number;
  repeatedQuestions: { question: string; times: number }[];
}

export function summarizeAiLog(entries: Pick<AiLogEntry, 'source' | 'intent' | 'found' | 'question'>[]): AiLogSummary {
  const bySource: Record<string, number> = {};
  const byIntent: Record<string, number> = {};
  const seen = new Map<string, number>();
  let unanswered = 0;
  for (const e of entries) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    const intent = e.intent ?? 'unknown';
    byIntent[intent] = (byIntent[intent] ?? 0) + 1;
    if (!e.found) unanswered++;
    const key = normalizeQuestion(e.question);
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeatedQuestions = [...seen.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([question, times]) => ({ question, times }));
  return { count: entries.length, bySource, byIntent, unanswered, repeatedQuestions };
}

export function registerInsightTools(server: McpServer, ctx: AppContext): void {
  const { store, config, client } = ctx;
  const guildId = config.DISCORD_GUILD_ID;

  server.registerTool(
    'get_ai_log',
    {
      title: 'Questions members asked Ordis',
      description:
        'The log of questions members asked Ordis (chat channel, DMs, /ask) with the answer, which model wrote it (local Ollama, cloud, wiki excerpt, or a direct lookup) and how long it took. Kept 30 days. Also returns counts by source and intent, the questions that found nothing, and questions asked more than once, which shows what the wiki or rules should cover.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30).describe('Newest entries to return'),
        hours: z.number().min(1).max(720).optional().describe('Only the last N hours'),
        user_id: snowflake.optional().describe('Only this member'),
        source: z.enum(SOURCES).optional(),
        only_unanswered: z.boolean().default(false).describe('Only questions where nothing useful was found'),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ limit, hours, user_id, source, only_unanswered }) => {
      const since = hours ? Date.now() - hours * 3_600_000 : 0;
      const matching = store
        .recentAiLog(guildId, 5000, user_id)
        .filter((e) => e.at >= since && (!source || e.source === source) && (!only_unanswered || !e.found));
      return {
        summary: summarizeAiLog(matching),
        entries: matching.slice(0, limit).map((e) => ({
          at: iso(e.at),
          userId: e.userId,
          user: e.userName,
          via: e.via,
          channelId: e.channelId,
          question: e.question,
          intent: e.intent,
          source: e.source,
          model: e.model,
          seconds: Number((e.ms / 1000).toFixed(1)),
          found: e.found,
          answer: e.answer,
        })),
      };
    }),
  );

  server.registerTool(
    'get_bot_health',
    {
      title: 'Bot health',
      description:
        'One-call health check: uptime, Discord connection, last start/stop reports, the Warframe API pacing state, which AI models are configured (and whether the local one is currently being skipped after a failure), the wiki index size, and how many questions were answered in the last 24 hours by source. Use ollama_status to probe the Ollama server itself.',
      annotations: READ_ONLY,
    },
    tool(async () => {
      const guild = client.guilds.cache.get(guildId);
      const ws = worldStateInfo();
      const wiki = getWikiIndex()?.stats() ?? null;
      const s = store.getSettings(guildId);
      return {
        uptimeSeconds: Math.floor(process.uptime()),
        discord: { ready: client.isReady(), pingMs: client.isReady() ? client.ws.ping : null, memberCount: guild?.memberCount ?? null },
        lifecycle: {
          state: store.getMeta('lifecycle_state'),
          startedAt: iso(Number(store.getMeta('lifecycle_started_at')) || null),
          stoppedAt: iso(Number(store.getMeta('lifecycle_stopped_at')) || null),
        },
        warframeApi: { enabled: ws.enabled, everySeconds: ws.intervalSeconds, lastCall: iso(ws.lastCallAt), lastOk: ws.lastOk, detail: ws.lastDetail },
        ai: {
          localModel: config.LOCAL_AI_URL ? (localModelOf(config) ?? null) : null,
          localSkippedAfterFailure: config.LOCAL_AI_URL ? !localAvailable() : null,
          cloudModel: config.FREE_AI_KEY ? config.FREE_AI_MODEL : null,
          cloudDailyLimit: config.FREE_AI_KEY ? config.FREE_AI_DAILY_LIMIT : null,
          claudeChat: Boolean(ctx.ai),
        },
        wikiIndex: wiki && { pages: wiki.pages, chunks: wiki.chunks, refreshedAt: iso(wiki.refreshedAt) },
        answersLast24h: store.aiLogStats(guildId, Date.now() - 86_400_000),
        features: {
          statusReports: Boolean(s.statusChannelId),
          auditLog: Boolean(s.auditLogChannelId ?? s.modLogChannelId),
          leveling: s.levelingOff !== 1,
          screenshotRoles: Boolean(s.ssRolesChannelId),
          verification: Boolean(s.verifyRoleId),
          honeypot: Boolean(s.honeypotChannelId),
          chatChannel: Boolean(s.chatChannelId),
        },
      };
    }),
  );

  server.registerTool(
    'list_member_levels',
    {
      title: 'Member levels',
      description: 'Members with XP, their level, total XP and message count, highest first. Filter by level range, e.g. max_level 9 to see who has not reached a level that unlocks something.',
      inputSchema: {
        min_level: z.number().int().min(0).optional(),
        max_level: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: READ_ONLY,
    },
    tool(async ({ min_level, max_level, limit }) => {
      const guild = client.guilds.cache.get(guildId);
      const rows = store
        .topXp(guildId, 10_000)
        .map((r) => ({ ...r, level: levelOf(r.xp) }))
        .filter((r) => (min_level === undefined || r.level >= min_level) && (max_level === undefined || r.level <= max_level));
      return {
        matching: rows.length,
        members: rows.slice(0, limit).map((r) => ({ userId: r.userId, name: guild?.members.cache.get(r.userId)?.displayName ?? null, level: r.level, xp: r.xp, messages: r.messages })),
      };
    }),
  );

  server.registerTool(
    'set_member_level',
    {
      title: 'Set member levels',
      description:
        'Sets members to a level (their XP becomes the minimum for that level) and updates their "Level N+" roles. With only_raise, members already at or above the level are left alone: use that to lift everyone to the level that unlocks something. Changes real members: confirm the list first.',
      inputSchema: {
        user_ids: z.array(snowflake).min(1).max(50),
        level: z.number().int().min(0).max(200),
        only_raise: z.boolean().default(true).describe('Never lower a member who is already above this level'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ user_ids, level, only_raise }) => {
      const guild = await client.guilds.fetch(guildId);
      const results = [];
      for (const id of new Set(user_ids)) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (!member) {
          results.push({ userId: id, result: 'not in the server' });
          continue;
        }
        if (member.user.bot) {
          results.push({ userId: id, name: member.displayName, result: 'bots do not level up' });
          continue;
        }
        const before = levelOf(store.getMemberXp(guildId, id)?.xp ?? 0);
        if (only_raise && before >= level) {
          results.push({ userId: id, name: member.displayName, before, after: before, result: 'already at or above this level' });
          continue;
        }
        store.setXp(guildId, id, xpForLevel(level));
        const role = await syncLevelRoles(guild, member, level);
        console.log(`[mcp-admin] set level of ${id} to ${level} (was ${before})`);
        results.push({ userId: id, name: member.displayName, before, after: level, roleAdded: role?.name ?? null, result: 'updated' });
      }
      if (!results.length) throw new UserError('No members given.');
      return { results };
    }),
  );
}
