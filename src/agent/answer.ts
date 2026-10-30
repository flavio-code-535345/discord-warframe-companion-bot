import { localModelOf } from '../ai/ollama.js';
import { aiToggle } from '../ai/settings.js';
import { isOperatorId } from '../answers/operator.js';
import type { SmartAnswer } from '../answers/smart.js';
import type { AppContext } from '../context.js';
import { OPERATOR_NOTE, brain, buildSystemPrompt } from './brain.js';
import { reportStatus, toolStatus } from '../answers/status.js';
import { runAgent } from './run.js';
import { enabledTools } from './tools.js';

/** The local model's context in tokens (Ollama's default, and OLLAMA_CONTEXT_LENGTH in this stack). */
export const LOCAL_CONTEXT_TOKENS = 4096;
/** What every agent request starts with (prompt and tool list) may take this share of it; the rest is for the question, passages, tool results and the answer. */
const MAX_FIXED_SHARE = 0.6;

/** Rough token count of the system prompt plus the tool list every agent request starts with (about 4 characters a token, measured on Gemma). */
export function agentPromptTokens(ctx: AppContext): number {
  const system = buildSystemPrompt({ bot: ctx.config.BOT_NAME, clan: ctx.config.CLAN_NAME }).length + OPERATOR_NOTE.length;
  const tools = enabledTools(ctx).reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters).length + 40, 0);
  return Math.round((system + tools) / 4);
}

/** False when the local model would get a cut-off prompt: the agent then stays out (the 8,000-character prompt plus 14 tools took 3,700 of 4,096 tokens). */
export function agentFits(ctx: AppContext): boolean {
  const local = Boolean(ctx.config.LOCAL_AI_URL && localModelOf(ctx.config) && aiToggle('local'));
  return !local || agentPromptTokens(ctx) <= LOCAL_CONTEXT_TOKENS * MAX_FIXED_SHARE;
}

/** Open-ended intents, where the agent can pick its own sources. Prices, drops, world state and clan lookups keep their exact answers unless the scope is "all". */
const OPEN_ENDED = new Set(['wiki', 'build']);

/**
 * Whether the agent may take this question: switched on for this asker, the right kind of question, and a model to run it.
 * smartAnswer only asks when the facts pipeline found no answer: the agent is the fallback that digs further with its tools.
 */
export function useAgent(ctx: AppContext, userId: string, intentKind: string, followUp = false): boolean {
  const s = brain();
  if (s.agentFor === 'off' || intentKind === 'help') return false;
  // A follow-up only makes sense with the conversation in front of the model, so it goes to the agent for everyone and for every kind of question.
  if (!followUp) {
    if (s.agentFor === 'operators' && !isOperatorId(ctx.config, userId)) return false;
    if (s.scope === 'open' && !OPEN_ENDED.has(intentKind)) return false;
  }
  const local = Boolean(ctx.config.LOCAL_AI_URL && localModelOf(ctx.config) && aiToggle('local'));
  return local || Boolean(ctx.config.FREE_AI_KEY);
}

/** The agent's answer as a chat answer, or null when it could not produce one (the normal answer path then takes over). */
export async function agentAnswer(ctx: AppContext, question: string, asker: { id: string; name: string }, extra: { history?: { role: 'user' | 'assistant'; content: string }[]; guidance?: string } = {}): Promise<SmartAnswer | null> {
  const run = await runAgent(ctx, question, { id: asker.id, name: asker.name, operator: isOperatorId(ctx.config, asker.id) }, { stream: false, ...(extra.history?.length ? { history: extra.history } : {}), ...(extra.guidance ? { guidance: extra.guidance } : {}), onEvent: (e) => reportStatus(e.t === 'tool' ? toolStatus(e.name) : e.t === 'step' ? (e.n === 1 ? '🧠 Thinking' : `🧠 Thinking (step ${e.n})`) : '') });
  if (!run.text) return null;
  const tools = [...new Set(run.steps.flatMap((st) => st.calls.map((c) => c.name)))];
  return {
    content: brain().showTools && tools.length ? `${run.text}\n-# 🔧 ${tools.join(' · ')}` : run.text,
    embeds: [],
    found: true,
    source: run.via ?? 'local',
    model: run.model,
    intent: 'agent',
  };
}
