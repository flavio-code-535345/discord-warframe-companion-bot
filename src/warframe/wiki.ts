import { apiFetch } from './fetch.js';

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
  const res = await apiFetch(`${API}?${qs}`);
  if (!res.ok) throw new Error(`Wiki request failed: HTTP ${res.status}`);
  return (await res.json()) as T;
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

/** Full-text wiki search, returning each hit's intro paragraph. */
export async function searchWiki(query: string, limit = 3): Promise<WikiResult[]> {
  const data = await api<SearchResponse>({ action: 'query', list: 'search', srsearch: query, srlimit: String(limit), srnamespace: '0' });
  return extracts((data.query?.search ?? []).map((s) => s.title), true);
}

/** One article as plain text, cut to `maxChars` (the wiki's long pages would otherwise flood a model's context). */
export async function readWikiPage(title: string, maxChars = 8000): Promise<WikiResult | null> {
  return (await extracts([title], false, maxChars))[0] ?? null;
}
