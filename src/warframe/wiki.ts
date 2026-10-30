import { rerankPassages } from '../wiki/embed.js';
import { getWikiIndex } from '../wiki/index.js';
import { titleCandidates } from '../wiki/terms.js';
import { apiJson } from './fetch.js';

// The official community wiki (MediaWiki, with the TextExtracts extension for plain-text summaries).
const API = 'https://wiki.warframe.com/api.php';

export interface WikiResult {
  title: string;
  url: string;
  extract: string;
}

interface SearchResponse {
  query?: { search: { title: string }[] };
}

interface ExtractResponse {
  query?: { pages: Record<string, { title: string; extract?: string; missing?: string }> };
}

export const pageUrl = (title: string) => `https://wiki.warframe.com/w/${encodeURIComponent(title.replace(/ /g, '_'))}`;

async function api<T>(params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ format: 'json', formatversion: '1', ...params });
  // The local wiki copy answers most questions; this live fallback is cached for the stable lifetime.
  const { data } = await apiJson<T>(`${API}?${qs}`, { kind: 'stable' });
  if (data === null) throw new Error('Wiki request failed: HTTP 404');
  return data;
}

async function extracts(titles: string[], intro: boolean, maxChars?: number): Promise<WikiResult[]> {
  if (!titles.length) return [];
  const data = await api<ExtractResponse>({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    titles: titles.join('|'),
    ...(intro ? { exintro: '1' } : {}),
    ...(maxChars ? { exchars: String(maxChars) } : {}),
  });
  const pages = Object.values(data.query?.pages ?? {}).filter((p) => !p.missing && p.extract);
  // Keep the search ranking order rather than the API's page-id order.
  return titles
    .map((t) => pages.find((p) => p.title.toLowerCase() === t.toLowerCase()))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({ title: p.title, url: pageUrl(p.title), extract: p.extract!.trim() }));
}

interface TitlesResponse {
  query?: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages: Record<string, { title: string; missing?: string }>;
  };
}

export { titleCandidates };

/** The longest phrase of the query that is itself a wiki page title (following redirects), if any. */
async function exactTitle(query: string): Promise<string | null> {
  // MediaWiki takes at most 50 titles per request.
  const candidates = titleCandidates(query).slice(0, 50);
  if (!candidates.length) return null;
  const data = await api<TitlesResponse>({ action: 'query', titles: candidates.join('|'), redirects: '1' });
  const q = data.query;
  if (!q) return null;
  const existing = new Set(Object.values(q.pages).filter((p) => p.missing === undefined).map((p) => p.title));
  const resolve = (t: string) => {
    const normalized = q.normalized?.find((n) => n.from === t)?.to ?? t;
    return q.redirects?.find((r) => r.from === normalized)?.to ?? normalized;
  };
  for (const c of candidates) {
    const target = resolve(c);
    if (existing.has(target)) return target;
  }
  return null;
}

/**
 * Wiki search for a question: a page whose title appears in the query comes first ("how do archon shards
 * work" → Archon Shard), then MediaWiki's full-text hits, which alone rank loosely matching pages too high.
 */
export async function searchWiki(query: string, limit = 3, opts: { pageChunks?: number; pageChars?: number } = {}): Promise<WikiResult[]> {
  // The local copy of the whole wiki answers first: it is instant and returns the passage that matches the
  // question, not just the article's introduction. The live wiki covers a missing index and the gaps.
  const local = getWikiIndex();
  if (local?.ready()) {
    const hits = local.search(query, limit, opts);
    // With an embedding model available, reorder by meaning (and let close matches the word search missed in); never fatal.
    const better = await rerankPassages(local, query, hits, limit).catch(() => null);
    if (better?.length) return better;
    if (hits.length) return hits;
  }
  const [title, data] = await Promise.all([
    exactTitle(query).catch(() => null),
    api<SearchResponse>({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0' }),
  ]);
  const titles = (data.query?.search ?? []).map((s) => s.title);
  const ordered = title ? [title, ...titles.filter((t) => t !== title)] : titles;
  return extracts(ordered.slice(0, limit), true);
}

/** One article as plain text, cut to `maxChars` (the wiki's long pages would otherwise flood a model's context). */
export async function readWikiPage(title: string, maxChars = 8000): Promise<WikiResult | null> {
  const local = getWikiIndex();
  if (local?.ready()) {
    const page = local.readPage(title, maxChars);
    if (page) return page;
  }
  return (await extracts([title], false, maxChars))[0] ?? null;
}
