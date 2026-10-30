import { createHash } from 'node:crypto';
import type { WikiIndex, WikiPassage } from './index.js';

/**
 * Meaning-based reranking of wiki search results. The full-text index finds passages that share words with the question;
 * an embedding model (a small one running in the same Ollama as the chat model) scores how close each passage is in
 * meaning, so a question worded differently from the wiki still reaches the right page. Everything here is optional: with no
 * Ollama, no embedding model or any failure, the plain full-text results are used unchanged.
 */

type Fetcher = typeof fetch;

export interface EmbedConfig {
  LOCAL_AI_URL?: string | undefined;
  EMBED_MODEL?: string | undefined;
}

let cfg: EmbedConfig | null = null;
let downUntil = 0;
let lastError: string | null = null;
const stats = { reranked: 0, skipped: 0, failed: 0 };

/** The shared config object (settings changed in the panel are written into it, so it is always current). */
export const bindEmbedder = (config: EmbedConfig | null): void => {
  cfg = config;
  downUntil = 0;
};

export const embedderEnabled = (): boolean => Boolean(cfg?.LOCAL_AI_URL && cfg.EMBED_MODEL?.trim());

export const embedStatus = () => ({ enabled: embedderEnabled(), model: cfg?.EMBED_MODEL?.trim() || null, pausedForMs: Math.max(0, downUntil - Date.now()), lastError, ...stats });

/** After a failure (no Ollama, model not installed) the embedder is left alone this long, so a missing model never slows a question. */
const FAILURE_PAUSE_MS = 5 * 60_000;
const EMBED_TIMEOUT_MS = 8_000;

/** nomic-embed-text wants a task prefix on both sides; other models do not. */
const prefix = (model: string, kind: 'query' | 'document'): string => (/nomic/i.test(model) ? `search_${kind}: ` : '');

const MAX_DOC_CHARS = 1200;
/** A passage that only entered through the extra candidates needs at least this cosine similarity to count. */
export const MIN_POOL_SIMILARITY = 0.5;
const POOL_PAGES = 12;
/** The full-text order counts a little less than the meaning, but enough that a page whose title is named in the question stays near the top. */
const LEXICAL_WEIGHT = 0.45;
const EXTRA_PRIOR = 0.25;

const base = (url: string): string => url.replace(/\/+$/, '').replace(/\/v1$/, '');

/** Embeddings for the texts, in order; null when the embedder is off or failed (and then it is paused for a while). */
export async function embedTexts(texts: string[], fetcher: Fetcher = fetch, now = Date.now()): Promise<number[][] | null> {
  if (!cfg || !embedderEnabled() || now < downUntil) return null;
  try {
    const res = await fetcher(`${base(cfg.LOCAL_AI_URL!)}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.EMBED_MODEL!.trim(), input: texts }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { embeddings?: unknown };
    const out = data.embeddings;
    if (!Array.isArray(out) || out.length !== texts.length || out.some((v) => !Array.isArray(v) || !v.length)) throw new Error('unexpected answer');
    lastError = null;
    return out as number[][];
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    downUntil = now + FAILURE_PAUSE_MS;
    stats.failed++;
    return null;
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const docText = (p: WikiPassage): string => `${p.title}\n${p.extract}`.slice(0, MAX_DOC_CHARS);
const hashOf = (model: string, text: string): string => createHash('sha1').update(model).update('\0').update(text).digest('hex');

/**
 * Reorders the full-text results by meaning. The candidates are the full-text results (`base`, best first) plus a few extra
 * pages from a looser full-text query (`pool`); each is scored by cosine similarity to the question, and the full-text
 * position and the similarity are blended. Extra pages must be clearly similar to get in. Returns null when nothing could be embedded.
 */
export async function rerankPassages(index: WikiIndex, question: string, results: WikiPassage[], limit: number, fetcher: Fetcher = fetch): Promise<WikiPassage[] | null> {
  if (!embedderEnabled()) return null;
  const model = cfg!.EMBED_MODEL!.trim();
  const seen = new Set(results.map((p) => p.title.toLowerCase()));
  const pool = index.pool(question, seen, POOL_PAGES);
  const candidates = [...results.map((p) => ({ p, extra: false })), ...pool.map((p) => ({ p, extra: true }))];
  if (candidates.length < 2) {
    stats.skipped++;
    return null;
  }

  const hashes = candidates.map((c) => hashOf(model, prefix(model, 'document') + docText(c.p)));
  const cached = index.getVectors(hashes);
  const missing = hashes.map((h, i) => [h, i] as const).filter(([h]) => !cached.has(h));
  const asked = await embedTexts([prefix(model, 'query') + question.slice(0, 400), ...missing.map(([, i]) => prefix(model, 'document') + docText(candidates[i]!.p))], fetcher);
  if (!asked) return null;
  const [query, ...fresh] = asked as [number[], ...number[][]];
  index.putVectors(missing.map(([h], j) => [h, Float32Array.from(fresh[j]!)] as const));
  missing.forEach(([h], j) => cached.set(h, Float32Array.from(fresh[j]!)));

  const similarity = candidates.map((_, i) => cosine(query, cached.get(hashes[i]!)!));
  const lo = Math.min(...similarity);
  const span = Math.max(...similarity) - lo || 1;
  const scored = candidates
    .map((c, i) => {
      // Full-text position (the best result 1, the last of them about 0.5; extra pages 0.25) blended with how close the passage is in meaning.
      const lexical = c.extra ? EXTRA_PRIOR : 1 - (0.5 * i) / Math.max(1, results.length - 1);
      return { c, i, score: LEXICAL_WEIGHT * lexical + (1 - LEXICAL_WEIGHT) * ((similarity[i]! - lo) / span) };
    })
    .filter((x) => !x.c.extra || similarity[x.i]! >= MIN_POOL_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c.p);
  stats.reranked++;
  return scored;
}
