import { localModelOf } from '../ai/ollama.js';
import { aiToggle } from '../ai/settings.js';
import { isOperatorId } from '../answers/operator.js';
import type { SmartAnswer } from '../answers/smart.js';
import type { AppContext } from '../context.js';
import { brain } from './brain.js';
import { reportStatus, toolStatus } from '../answers/status.js';
import { runAgent } from './run.js';

/** Open-ended intents, where the agent can pick its own sources. Prices, drops, world state and clan lookups keep their exact answers unless the scope is "all". */
const OPEN_ENDED = new Set(['wiki', 'build']);

/** Whether this question goes to the agent: switched on for this asker, the right kind of question, and a model to run it. */
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
