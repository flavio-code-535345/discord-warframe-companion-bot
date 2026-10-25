import type { WikiResult } from '../warframe/wiki.js';

/**
 * Optional free-tier LLM that rewrites the retrieved wiki passages into a direct answer. It never answers from its
 * own memory: it only sees the excerpts, and anything it can't answer from them falls back to the plain excerpt.
 * Any OpenAI-compatible endpoint works (Groq, Gemini, OpenRouter, ...).
 */

export interface ComposeConfig {
  FREE_AI_KEY?: string | undefined;
  FREE_AI_URL: string;
  FREE_AI_MODEL: string;
  FREE_AI_DAILY_LIMIT: number;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const SYSTEM = [
  'You are Cephalon Ordis, the ship AI of a Warframe clan. You answer a clan member\'s question using ONLY the wiki excerpts provided.',
  'Answer directly in 2-5 short sentences, in plain Discord markdown (bold key names, short bullet list only if the answer is steps).',
  'Lead with the answer, not with "according to the wiki". Do not mention the excerpts or the wiki. Light Ordis flavour is fine, but stay brief and accurate.',
  'If the excerpts do not contain the answer, reply with exactly: NOT_COVERED',
].join(' ');

let day = '';
let used = 0;

/** Counts one call against today's budget; false once the free-tier allowance the owner set is used up. */
function allow(limit: number, now = Date.now()): boolean {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (used >= limit) return false;
  used++;
  return true;
}

export const composeEnabled = (c: Pick<ComposeConfig, 'FREE_AI_KEY'>) => Boolean(c.FREE_AI_KEY);

/** A written answer grounded in the excerpts, or null (no key, over budget, not covered, or any failure). */
export async function composeAnswer(config: ComposeConfig, question: string, passages: WikiResult[], fetcher: Fetcher = fetch): Promise<string | null> {
  if (!config.FREE_AI_KEY || !passages.length || !allow(config.FREE_AI_DAILY_LIMIT)) return null;
  const excerpts = passages
    .slice(0, 3)
    .map((p, i) => `[${i + 1}] ${p.title}\n${p.extract.slice(0, 1500)}`)
    .join('\n\n');
  try {
    const res = await fetcher(`${config.FREE_AI_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.FREE_AI_KEY}` },
      body: JSON.stringify({
        model: config.FREE_AI_MODEL,
        temperature: 0.2,
        max_tokens: 350,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Question: ${question}\n\nExcerpts:\n${excerpts}` },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/s+/g, ' ').slice(0, 200);
      console.error(`[answers] free AI returned HTTP ${res.status} from ${new URL(config.FREE_AI_URL).host}${new URL(config.FREE_AI_URL).pathname} (model ${config.FREE_AI_MODEL}): ${detail}`);
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text || /NOT_COVERED/i.test(text)) return null;
    return text.length > 1500 ? `${text.slice(0, 1497)}…` : text;
  } catch (err) {
    console.error('[answers] free AI failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
