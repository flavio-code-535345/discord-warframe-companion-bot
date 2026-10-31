import { aiToggle } from '../ai/settings.js';
import type { WikiResult } from './wiki.js';

/**
 * Fresh web results from a self-hosted SearXNG (SEARXNG_URL) for the MCP tool search_web: patch notes, news, forum and Reddit
 * threads, things the local wiki index is days behind on. Results are limited to Warframe sources and are plain snippets. Never
 * throws: a down search engine just means no results.
 */

type Fetcher = typeof fetch;

/** Hosts whose results are used; anything else a search engine returns is dropped. */
export const ALLOWED_HOSTS = [
  'wiki.warframe.com',
  'warframe.com',
  'forums.warframe.com',
  'reddit.com',
  'warframe.market',
  'overframe.gg',
  'warframestat.us',
  'warframe.fandom.com',
];

export const allowedUrl = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && ALLOWED_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

/** Reddit results only count from the Warframe subreddits. */
const okForHost = (url: string): boolean => !/(^|\.)reddit\.com$/.test(new URL(url).hostname) || /\/r\/(warframe|warframeprimetrading|warframememes)\b/i.test(url);

interface SearxResponse {
  results?: { title?: string; url?: string; content?: string; publishedDate?: string | null }[];
}

export interface WebResult extends WikiResult {
  published: string | null;
}

export const withWarframe = (q: string): string => (/warframe/i.test(q) ? q : `warframe ${q}`);

export async function webSearch(baseUrl: string | undefined, query: string, limit = 3, fetcher: Fetcher = fetch): Promise<WebResult[]> {
  if (!baseUrl || !query.trim() || !aiToggle('websearch')) return [];
  try {
    const q = query.trim().slice(0, 200);
    const params = new URLSearchParams({ q: withWarframe(q), format: 'json', language: 'en', categories: 'general,news', safesearch: '0' });
    const res = await fetcher(`${baseUrl.replace(/\/+$/, '')}/search?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) {
      console.warn(`[websearch] SearXNG answered HTTP ${res.status} (is the json format enabled in its settings?)`);
      return [];
    }
    const data = (await res.json()) as SearxResponse;
    const seen = new Set<string>();
    const out: WebResult[] = [];
    for (const r of data.results ?? []) {
      if (!r.url || !r.title || !allowedUrl(r.url) || !okForHost(r.url) || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({ title: r.title.slice(0, 120), url: r.url, extract: (r.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), published: r.publishedDate ?? null });
      if (out.length >= limit) break;
    }
    return out.filter((r) => r.extract);
  } catch (err) {
    console.warn('[websearch] search failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
