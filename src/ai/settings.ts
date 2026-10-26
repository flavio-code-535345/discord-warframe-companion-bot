import type { Store } from '../db.js';

/**
 * Runtime switches for the AI features. They live in bot_meta and in memory, and every surface (the /ai command, the
 * admin panel's AI page and the MCP tools) reads and writes them through here, so they always agree and a change takes
 * effect immediately, with no redeploy.
 */

export type AiToggle = 'local' | 'thinking' | 'websearch' | 'operators' | 'log' | 'cache';

export interface ToggleInfo {
  label: string;
  help: string;
  default: boolean;
}

export const TOGGLES: Record<AiToggle, ToggleInfo> = {
  local: { label: 'Local model', help: 'Use the self-hosted Ollama model for answers (and as the screenshot backup). Off: only the free cloud model.', default: true },
  thinking: { label: 'Thinking', help: 'Let the local model reason before answering. Slower (30 s or more on a CPU) and only for models that support it.', default: false },
  websearch: { label: 'Web search', help: 'Add fresh Warframe web results from SearXNG to answers.', default: true },
  operators: { label: 'Operator mode', help: 'Let the two operators give Ordis free-form instructions.', default: true },
  cache: { label: 'Answer cache', help: 'Serve saved, verified answers to repeat questions, and let the daily refresh keep them current.', default: true },
  log: { label: 'Question log', help: 'Record the questions members ask, for /ailog (kept 30 days).', default: true },
};

export const TOGGLE_KEYS = Object.keys(TOGGLES) as AiToggle[];

const META = (t: AiToggle): string => `ai_toggle_${t}`;

let state: Partial<Record<AiToggle, boolean>> = {};

/** Current value of a switch: what staff chose, else its default. */
export const aiToggle = (t: AiToggle): boolean => state[t] ?? TOGGLES[t].default;

export function loadAiToggles(store: Pick<Store, 'getMeta'>): void {
  state = {};
  for (const t of TOGGLE_KEYS) {
    const v = store.getMeta(META(t));
    if (v === 'on') state[t] = true;
    else if (v === 'off') state[t] = false;
  }
}

export function setAiToggle(store: Pick<Store, 'setMeta'>, t: AiToggle, on: boolean): void {
  state[t] = on;
  store.setMeta(META(t), on ? 'on' : 'off');
}

/** Test hook. */
export const resetAiToggles = (): void => {
  state = {};
};

export const isToggle = (v: unknown): v is AiToggle => typeof v === 'string' && (TOGGLE_KEYS as string[]).includes(v);
