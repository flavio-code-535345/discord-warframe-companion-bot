import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DEFAULT_PROMPT, LIMITS, brain, buildSystemPrompt, personaBand, resetBrain, updateBrain } from '../agent/brain.js';
import { runAgent } from '../agent/run.js';
import { AGENT_TOOLS, enabledTools } from '../agent/tools.js';
import type { AppContext } from '../context.js';
import { READ_ONLY, tool } from './util.js';

/** The agent's brain over MCP: read it, tune it, and run a question through it to see the trace (same settings as the admin panel's Brain page). */
export function registerBrainTools(server: McpServer, ctx: AppContext): void {
  const view = () => {
    const s = brain();
    return {
      settings: { ...s, prompt: s.prompt || '(built-in default)' },
      persona: { level: s.ordisness, band: personaBand(s.ordisness).name },
      tools: AGENT_TOOLS.map((t) => ({ name: t.name, on: enabledTools(ctx).some((x) => x.name === t.name), description: t.description })),
      systemPrompt: buildSystemPrompt({ bot: ctx.config.BOT_NAME, clan: ctx.config.CLAN_NAME }),
    };
  };

  server.registerTool(
    'get_brain',
    { title: 'Agent brain', description: "The Ordis agent's current settings: system prompt, Ordis-ness level (0 plain ... 100 full), temperature, steps, which tools it may use, and who gets it. Same as the admin panel's Brain page.", inputSchema: {}, annotations: { ...READ_ONLY, openWorldHint: false } },
    tool(async () => view()),
  );

  server.registerTool(
    'update_brain',
    {
      title: 'Tune the agent brain',
      description: 'Changes any of the agent settings (only the fields you pass). prompt "" restores the built-in default. Takes effect on the next question. reset: true restores every default first.',
      inputSchema: {
        prompt: z.string().max(8000).optional().describe('System prompt; placeholders {{bot}} {{clan}} {{date}} {{persona}}'),
        ordisness: z.number().min(LIMITS.ordisness.min).max(LIMITS.ordisness.max).optional(),
        temperature: z.number().min(LIMITS.temperature.min).max(LIMITS.temperature.max).optional(),
        topP: z.number().min(LIMITS.topP.min).max(LIMITS.topP.max).optional(),
        maxSteps: z.number().int().min(LIMITS.maxSteps.min).max(LIMITS.maxSteps.max).optional(),
        maxTokens: z.number().int().min(LIMITS.maxTokens.min).max(LIMITS.maxTokens.max).optional(),
        maxChars: z.number().int().min(LIMITS.maxChars.min).max(LIMITS.maxChars.max).optional(),
        toolResultChars: z.number().int().min(LIMITS.toolResultChars.min).max(LIMITS.toolResultChars.max).optional(),
        memoryMessages: z.number().int().min(LIMITS.memoryMessages.min).max(LIMITS.memoryMessages.max).optional(),
        agentFor: z.enum(['off', 'operators', 'everyone']).optional(),
        scope: z.enum(['open', 'all']).optional(),
        toolMode: z.enum(['auto', 'native', 'text']).optional(),
        showTools: z.boolean().optional(),
        disabledTools: z.array(z.string()).optional().describe('Tool names the agent may not use'),
        reset: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    tool(async ({ reset, ...patch }) => {
      if (reset) resetBrain(ctx.store);
      const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (typeof fields.prompt === 'string' && fields.prompt.trim() === DEFAULT_PROMPT.trim()) fields.prompt = '';
      if (Object.keys(fields).length) updateBrain(ctx.store, fields);
      return view();
    }),
  );

  server.registerTool(
    'test_agent',
    {
      title: 'Run the agent',
      description: 'Asks the agent one question with the current brain and returns the answer plus its trace (each model call, tool calls with arguments and clipped results). Can take a minute on a CPU.',
      inputSchema: { question: z.string().min(2).max(600), operator: z.boolean().optional().describe('Answer as one of the two operators') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    tool(async ({ question, operator }) => {
      const run = await runAgent(ctx, question, { id: 'mcp', name: 'MCP', operator: operator === true });
      return {
        status: run.status,
        answer: run.text,
        error: run.error,
        via: run.via,
        model: run.model,
        mode: run.mode,
        seconds: Number((run.ms / 1000).toFixed(1)),
        steps: run.steps.map((st) => ({ n: st.n, ms: st.ms, reasoning: st.reasoning.slice(0, 800) || undefined, said: st.calls.length ? st.content.slice(0, 300) || undefined : undefined, calls: st.calls.map((c) => ({ tool: c.name, args: c.args, ms: c.ms, error: c.error, result: c.result.slice(0, 600) })) })),
      };
    }),
  );
}
