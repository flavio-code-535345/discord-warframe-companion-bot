import { apiFetch } from '../warframe/fetch.js';
import { chunkWikitext } from './clean.js';
import type { WikiIndex } from './index.js';

const API = 'https://wiki.warframe.com/api.php';
const LIST_PAGE_SIZE = 500;
const CONTENT_BATCH = 40;
const MAX_SOURCE_CHARS = 400_000;
const REQUEST_GAP_MS = 1500;
const STARTUP_DELAY_MS = 90_000;
const CHECK_INTERVAL_MS = 6 * 3_600_000;
const REFRESH_AFTER_MS = 24 * 3_600_000;

type Fetcher = (url: string) => Promise<Response>;

interface ApiPage {
  title: string;
  lastrevid?: number;
  redirects?: { title: string }[];
  missing?: boolean;
  revisions?: { revid: number; slots?: { main?: { content?: string } } }[];
}
interface ApiResponse {
  continue?: Record<string, string>;
  query?: { pages?: ApiPage[] };
  error?: { code: string; info: string };
}

export interface RefreshResult {
  total: number;
  changed: number;
  removed: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Keeps the local wiki index current. It lists every article with its latest revision (cheap), downloads only the
 * pages that changed, and removes deleted ones. It is slow on purpose (one request every 1.5s) to be a good citizen.
 */
export class WikiCrawler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly index: WikiIndex,
    private readonly fetcher: Fetcher = apiFetch,
    private readonly gapMs = REQUEST_GAP_MS,
  ) {}

  start(): void {
    setTimeout(() => void this.maybeRefresh(), STARTUP_DELAY_MS);
    this.timer = setInterval(() => void this.maybeRefresh(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get busy(): boolean {
    return this.running;
  }

  private async maybeRefresh(): Promise<void> {
    const last = Number(this.index.getMeta('refreshed_at') ?? 0);
    if (Date.now() - last < REFRESH_AFTER_MS) return;
    await this.refresh().catch((err) => console.error('[wiki] refresh failed:', err));
  }

  private async call(params: Record<string, string>): Promise<ApiResponse> {
    const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await sleep(this.gapMs);
        const res = await this.fetcher(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ApiResponse;
        if (data.error?.code === 'maxlag') throw new Error('wiki servers are lagging');
        if (data.error) throw new Error(`${data.error.code}: ${data.error.info}`);
        return data;
      } catch (err) {
        lastError = err;
        await sleep(this.gapMs * 4 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /** Every main-namespace article with its latest revision id, plus the redirects that point at them ("Zariman" → its page). */
  private async listArticles(): Promise<{ revisions: Map<string, number>; aliases: Map<string, string> }> {
    const revisions = new Map<string, number>();
    const aliases = new Map<string, string>();
    let cont: Record<string, string> = {};
    do {
      const data = await this.call({
        action: 'query',
        generator: 'allpages',
        gapnamespace: '0',
        gapfilterredir: 'nonredirects',
        gaplimit: String(LIST_PAGE_SIZE),
        prop: 'info|redirects',
        rdlimit: 'max',
        rdnamespace: '0',
        ...cont,
      });
      for (const p of data.query?.pages ?? []) {
        if (p.lastrevid) revisions.set(p.title, p.lastrevid);
        for (const r of p.redirects ?? []) aliases.set(r.title, p.title);
      }
      cont = data.continue ?? {};
    } while (Object.keys(cont).length);
    return { revisions, aliases };
  }

  /** Brings the index up to date. Safe to interrupt: every stored page is complete, and the next run resumes by revision. */
  async refresh(): Promise<RefreshResult> {
    if (this.running) throw new Error('A wiki refresh is already running.');
    this.running = true;
    try {
      const started = Date.now();
      const { revisions: remote, aliases } = await this.listArticles();
      const local = this.index.revisions();
      // A truncated listing must never wipe a healthy index.
      if (local.size >= 50 && remote.size < local.size * 0.5) throw new Error(`Wiki listing looks incomplete (${remote.size} of ${local.size} pages), keeping the index.`);

      const stale = [...remote].filter(([title, revid]) => local.get(title) !== revid).map(([title]) => title);
      console.log(`[wiki] ${remote.size} articles, ${stale.length} to download`);
      let done = 0;
      for (let i = 0; i < stale.length; i += CONTENT_BATCH) {
        const batch = stale.slice(i, i + CONTENT_BATCH);
        const data = await this.call({ action: 'query', prop: 'revisions', rvprop: 'ids|content', rvslots: 'main', titles: batch.join('|') });
        for (const page of data.query?.pages ?? []) {
          const rev = page.revisions?.[0];
          const source = rev?.slots?.main?.content;
          if (page.missing || !rev || !source) continue;
          this.index.putPage(page.title, rev.revid, chunkWikitext(source.slice(0, MAX_SOURCE_CHARS)));
          done++;
        }
        await yieldToLoop();
        if ((i / CONTENT_BATCH) % 25 === 24) console.log(`[wiki] indexed ${done}/${stale.length}`);
      }

      let removed = 0;
      for (const title of local.keys()) {
        if (!remote.has(title)) {
          this.index.deletePage(title);
          removed++;
        }
      }
      this.index.replaceAliases(aliases);
      this.index.setMeta('refreshed_at', String(Date.now()));
      console.log(`[wiki] index up to date: ${remote.size} pages (${done} updated, ${removed} removed) in ${Math.round((Date.now() - started) / 1000)}s`);
      return { total: remote.size, changed: done, removed };
    } finally {
      this.running = false;
    }
  }
}
