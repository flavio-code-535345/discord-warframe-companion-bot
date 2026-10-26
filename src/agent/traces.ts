/**
 * What the agent did, step by step, kept in memory (the last 30 runs) so staff can read its "thinking" on the Brain page:
 * every model call, the reasoning text the model exposed, each tool call with its arguments and result.
 * A run is created when it starts and filled in live, so the page can show it while it is still working.
 */

export interface ToolCallTrace {
  name: string;
  args: unknown;
  /** The (clipped) result the model saw; empty while the tool is still running. */
  result: string;
  ms: number;
  error: boolean;
}

export interface StepTrace {
  n: number;
  endpoint: 'local' | 'cloud';
  model: string;
  ms: number;
  reasoning: string;
  content: string;
  calls: ToolCallTrace[];
  /** Tokens the model generated in this step, the speed while generating (tokens/s), the wait for the first token (ms; includes loading the model) and the prompt size when the server says. */
  tokens: number;
  tps: number;
  ttft: number;
  promptTokens: number | null;
}

export interface AgentRun {
  id: string;
  at: number;
  who: string;
  operator: boolean;
  question: string;
  status: 'running' | 'done' | 'failed';
  text: string | null;
  via: 'local' | 'cloud' | null;
  model: string | null;
  /** How tool calls were made: the model's own function calling, or written as text. */
  mode: 'native' | 'text' | null;
  steps: StepTrace[];
  ms: number;
  /** Totals over all steps: generated tokens and the average generation speed. */
  tokens: number;
  tps: number;
  error: string | null;
  /** The system prompt this run used, so a result can be matched to the settings that produced it. */
  system: string;
}

const KEEP = 30;
const runs: AgentRun[] = [];
let counter = 0;

export function newRun(init: Pick<AgentRun, 'who' | 'operator' | 'question' | 'system'>): AgentRun {
  const run: AgentRun = { id: `${Date.now().toString(36)}${(counter++).toString(36)}`, at: Date.now(), status: 'running', text: null, via: null, model: null, mode: null, steps: [], ms: 0, tokens: 0, tps: 0, error: null, ...init };
  runs.unshift(run);
  if (runs.length > KEEP) runs.length = KEEP;
  return run;
}

export const recentRuns = (): AgentRun[] => runs;
export const getRun = (id: string): AgentRun | undefined => runs.find((r) => r.id === id);

/** Test hook. */
export const resetRuns = (): void => {
  runs.length = 0;
};
