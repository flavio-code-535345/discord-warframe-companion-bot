import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { distance } from '../ssroles/parse.js';
import type { Chunk } from './clean.js';
import { isGenericName, isStopWord, queryTerms, synonymsOf, titleCandidates, withSynonyms } from './terms.js';

/** A local, searchable copy of the Warframe wiki (full-text index in its own SQLite file). */

export interface WikiPassage {
  title: string;
  url: string;
  extract: string;
}

export interface WikiStats {
  pages: number;
  chunks: number;
  refreshedAt: number | null;
}

/** Below this many pages the index is considered still being built, and lookups use the live wiki instead. */
export const MIN_READY_PAGES = 500;
const MAX_EXTRACT = 1500;
const PER_PAGE_CHUNKS = 2;
/** Patch notes repeat item names constantly and would swamp real answers, so they only rank when asked for. */
const PATCH_TITLE = /^(update|hotfix|patch|conclave:|version|redtext)\b|\/patch history\b|^user:/i;
const WANTS_PATCHES = /\b(update|hotfix|patch|changelog|version|nerf|buff|changed|added when)\b/i;
/** Dev streams, voice lines and sound effects mention everything too; same idea. */
const FLUFF_TITLE = /^(devstream|prime time|developer workshop)\b|\/(quotes?|sfx|dialogue|transcripts?)(\/|$)/i;
const WANTS_FLUFF = /\b(devstream|dev stream|quote|quotes|says|said|dialogue|voice ?lines?|sfx|sound|transcript)\b/i;
/** "how do I get/unlock/farm …" questions prefer sections that explain acquisition. */
const WANTS_ACQUISITION = /\b(get|getting|obtain|acquire|unlock|farm|farming|find|where|source|craft|start|begin|access|gain|earn|gather)\b/i;
const ACQUISITION_SECTION = /obtain|acqui|unlock|farm|source|location|requirement|spawn|start|how to|crafting|getting|access|gain|earn|reward|drop/i;
/** "best kuva farm", "fastest way to get endo": the sections that name places and methods. */
const WANTS_FARMING = /\b(best|fastest|quickest|easiest|efficient|good)\b[^?]*\b(farm|farming|grind|way|place|spot)\b/i;
const FARMING_SECTION = /farm|location|tips?|strateg|method|source|best|mission/i;
/** "What is / who is / explain / tell me about X": the page's introduction is part of the answer. */
const WANTS_DEFINITION = /\b(what('s| is| are| was)|who('s| is| are)|explain|tell me about|describe|define)\b/i;
/** Story and background sections mention a lot but only answer lore questions. */
const LORE_SECTION = /^(lore|history|trivia|culture|cuisine|language|etymology|appearance|personality|gallery|media|bugs?)\b/i;
const WANTS_LORE = /\b(lore|story|stories|history|backstory|personality|who (is|was|are|were))\b/i;
/** "What is X / how does X work": the sections that say what it does. */
const USAGE_SECTION = /usage|\buse|mechanic|overview|function|feature|how|abilit|subsum|effect|work/i;
const MAX_SUBPAGES = 6;
/** Kept passage vectors (about 3 KB each); the oldest are dropped past this. */
const MAX_VECTORS = 30_000;
const VECTOR_PRUNE_EXTRA = 3_000;

export const wikiUrl = (title: string) => `https://wiki.warframe.com/w/${encodeURIComponent(title.replace(/ /g, '_'))}`;

type Row = Record<string, unknown>;

/** Whether lowercase `text` contains the question word, plural or singular ("arcanes" finds "Arcane"). */
const mentions = (text: string, term: string) => text.includes(term) || (term.length > 3 && term.endsWith('s') && text.includes(term.slice(0, -1)));

/** A title as members type it: lowercase, without a leading "The", spaces or punctuation ("ice bind" finds "The Icebind"). */
export const looseKey = (title: string): string =>
  title
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]/gu, '');

/** Letters a typed name may get wrong and still mean a page: none for short names, one from 7 letters, two from 8. */
const typosAllowed = (length: number): number => (length >= 8 ? 2 : length >= 7 ? 1 : 0);

export class WikiIndex {
  private readonly db: DatabaseSync;
  /** looseKey → page title (built on first use, dropped when pages change). */
  private keys: Map<string, string> | null = null;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pages (title TEXT PRIMARY KEY COLLATE NOCASE, revid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunk_ids (title TEXT NOT NULL COLLATE NOCASE, id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chunk_ids_title ON chunk_ids (title);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY COLLATE NOCASE, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (hash TEXT PRIMARY KEY, vec BLOB NOT NULL, at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(title, section, body, tokenize = 'porter unicode61 remove_diacritics 2');
    `);
  }

  close(): void {
    this.db.close();
  }

  // --- writing ---

  /** Replaces everything stored for a page. */
  putPage(title: string, revid: number, chunks: Chunk[]): void {
    this.keys = null;
    this.db.exec('BEGIN');
    try {
      this.deletePage(title);
      this.db.prepare('INSERT INTO pages (title, revid) VALUES (?, ?)').run(title, revid);
      const insert = this.db.prepare('INSERT INTO chunks (title, section, body) VALUES (?, ?, ?)');
      const link = this.db.prepare('INSERT INTO chunk_ids (title, id) VALUES (?, ?)');
      for (const c of chunks) link.run(title, Number(insert.run(title, c.section, c.body).lastInsertRowid));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Redirect titles that lead to an article ("Zari" → "Zariman ARG"); replaced wholesale on every refresh. */
  replaceAliases(aliases: Map<string, string>): void {
    this.keys = null;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM aliases');
      const insert = this.db.prepare('INSERT OR REPLACE INTO aliases (alias, target) VALUES (?, ?)');
      for (const [alias, target] of aliases) insert.run(alias, target);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deletePage(title: string): void {
    this.keys = null;
    const ids = this.db.prepare('SELECT id FROM chunk_ids WHERE title = ?').all(title) as Row[];
    const del = this.db.prepare('DELETE FROM chunks WHERE rowid = ?');
    for (const r of ids) del.run(Number(r.id));
    this.db.prepare('DELETE FROM chunk_ids WHERE title = ?').run(title);
    this.db.prepare('DELETE FROM pages WHERE title = ?').run(title);
  }

  /** Page title → last indexed revision. */
  revisions(): Map<string, number> {
    const rows = this.db.prepare('SELECT title, revid FROM pages').all() as Row[];
    return new Map(rows.map((r) => [String(r.title), Number(r.revid)]));
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  // --- reading ---

  stats(): WikiStats {
    const pages = Number((this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as Row).n);
    const chunks = Number((this.db.prepare('SELECT COUNT(*) AS n FROM chunk_ids').get() as Row).n);
    const at = this.getMeta('refreshed_at');
    return { pages, chunks, refreshedAt: at ? Number(at) : null };
  }

  ready(): boolean {
    return this.stats().pages >= MIN_READY_PAGES;
  }

  // --- embeddings (see embed.ts): vectors of passages already scored, keyed by a hash of model + text ---

  getVectors(hashes: string[]): Map<string, Float32Array> {
    const out = new Map<string, Float32Array>();
    const get = this.db.prepare('SELECT vec FROM embeddings WHERE hash = ?');
    for (const h of hashes) {
      const row = get.get(h) as Row | undefined;
      const blob = row?.vec as Uint8Array | undefined;
      if (blob) out.set(h, new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength)));
    }
    return out;
  }

  putVectors(entries: readonly (readonly [string, Float32Array])[]): void {
    if (!entries.length) return;
    const put = this.db.prepare('INSERT OR REPLACE INTO embeddings (hash, vec, at) VALUES (?, ?, ?)');
    const now = Date.now();
    for (const [hash, vec] of entries) put.run(hash, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength), now);
    // Passages change with the wiki and with the question, so old vectors are dropped instead of growing without limit.
    const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM embeddings').get() as Row).n);
    if (n > MAX_VECTORS) this.db.prepare('DELETE FROM embeddings WHERE hash IN (SELECT hash FROM embeddings ORDER BY at LIMIT ?)').run(n - MAX_VECTORS + VECTOR_PRUNE_EXTRA);
  }

  /**
   * More candidate pages for the reranker: the best full-text matches for ANY word of the question (search() requires most
   * of them), skipping the pages in `exclude`. Unranked here; the reranker decides whether they are close enough in meaning.
   */
  pool(question: string, exclude: Set<string>, pages: number): WikiPassage[] {
    const terms = queryTerms(question);
    if (!terms.length) return [];
    const wantsPatches = WANTS_PATCHES.test(question);
    const wantsFluff = WANTS_FLUFF.test(question);
    let rows: Row[];
    try {
      rows = this.db.prepare('SELECT title, section, body FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks, 8.0, 3.0, 1.0) LIMIT 80').all(terms.map((t) => `"${t}"`).join(' OR ')) as Row[];
    } catch {
      return [];
    }
    const byPage = new Map<string, { title: string; chunks: { section: string; body: string }[] }>();
    for (const r of rows) {
      const t = String(r.title);
      if (exclude.has(t.toLowerCase()) || (!wantsPatches && PATCH_TITLE.test(t)) || (!wantsFluff && FLUFF_TITLE.test(t))) continue;
      if (!byPage.has(t) && byPage.size >= pages) continue;
      const entry = byPage.get(t) ?? { title: t, chunks: [] };
      if (entry.chunks.length < PER_PAGE_CHUNKS) entry.chunks.push({ section: String(r.section), body: String(r.body) });
      byPage.set(t, entry);
    }
    return [...byPage.values()].map((p) => this.toPassage(p.title, p.chunks));
  }

  private chunksOf(title: string): { section: string; body: string }[] {
    return (
      this.db.prepare('SELECT section, body FROM chunks WHERE rowid IN (SELECT id FROM chunk_ids WHERE title = ?) ORDER BY rowid').all(title) as Row[]
    ).map((r) => ({ section: String(r.section), body: String(r.body) }));
  }

  /** A whole page as plain text, cut to `maxChars`; null when the page isn't indexed. */
  readPage(title: string, maxChars = 8000): WikiPassage | null {
    const page = this.db.prepare('SELECT title FROM pages WHERE title = ?').get(title) as Row | undefined;
    if (!page) return null;
    const real = String(page.title);
    const text = this.chunksOf(real)
      .map((c, i, all) => (c.section !== all[i - 1]?.section ? `\n== ${c.section} ==\n${c.body}` : c.body))
      .join('\n')
      .trim();
    return text ? { title: real, url: wikiUrl(real), extract: text.slice(0, maxChars) } : null;
  }

  /** The longest phrase of the question that is a page title; shell pages fall through to their subpages. */
  /** False for empty stubs, which would otherwise swallow a title match that a real page deserves. */
  private hasContent(title: string): boolean {
    if (this.chunksOf(title).some((c) => c.body.length >= 40)) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM pages WHERE title LIKE ? ESCAPE '\\' LIMIT 1`).get(`${title.replace(/[\\%_]/g, '\\$&')}/%`));
  }

  private titleMatch(question: string): { title: string; disambiguation: boolean } | null {
    const find = this.db.prepare('SELECT title FROM pages WHERE title = ?');
    const alias = this.db.prepare('SELECT target FROM aliases WHERE alias = ?');
    let disambiguation: string | null = null;
    const hits: { title: string; words: number; generic: boolean; uses: number }[] = [];
    const seen = new Set<string>();
    for (const candidate of titleCandidates(question)) {
      // A redirect ("Zariman" → "Zariman (Tileset)") counts as naming its target page.
      const target = (alias.get(candidate) as Row | undefined)?.target;
      const hit = (find.get(candidate) as Row | undefined) ?? (target ? (find.get(String(target)) as Row | undefined) : undefined);
      if (!hit) continue;
      const title = String(hit.title);
      if (seen.has(title) || !this.hasContent(title)) continue;
      seen.add(title);
      // "Requiem may refer to: …" lists are a last resort, behind any real page named in the question.
      if (this.isDisambiguation(title)) disambiguation ??= title;
      else {
        const words = candidate.split(' ').length;
        hits.push({ title, words, generic: isGenericName(candidate), uses: words === 1 ? this.uses(candidate) : 0 });
      }
    }
    // A name made only of category words ("Syndicate Reputation", "Status Effect") gives way to a specific one ("Ostron", "Viral");
    // then the longer name wins, and of one-word names the rarest in the wiki, since ordinary words are pages or redirects too ("Time", "Next").
    const best = hits.sort((a, b) => Number(a.generic) - Number(b.generic) || b.words - a.words || a.uses - b.uses)[0];
    if (best) return { title: best.title, disambiguation: false };
    const loose = this.looseMatch(question);
    if (loose) return { title: loose, disambiguation: false };
    return disambiguation ? { title: disambiguation, disambiguation: true } : null;
  }

  /** How many passages use a word (stemmed): few for a name like "Strun", thousands for "time". */
  private uses(word: string): number {
    try {
      return Number((this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE chunks MATCH ?').get(`"${word.replace(/"/g, '')}"`) as Row).n);
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  private isDisambiguation(title: string): boolean {
    return /\b(?:may|can|might) (?:also )?refer to\b/i.test(this.chunksOf(title)[0]?.body ?? '');
  }

  /** Page titles by looseKey. Redirects are left out: many are ordinary words ("Next"), and the exact match already follows them. */
  private titleKeys(): Map<string, string> {
    if (this.keys) return this.keys;
    const keys = new Map<string, string>();
    for (const r of this.db.prepare('SELECT title FROM pages').all() as Row[]) keys.set(looseKey(String(r.title)), String(r.title));
    this.keys = keys;
    return keys;
  }

  /**
   * A page the question names the way members type it: spaced or joined differently ("ice bind" → The Icebind), or misspelt
   * ("incronon" → Incarnon; one wrong letter from 7 letters, two from 8, first and last letter right). Only names with no filler
   * words in them (a leading "the" aside) are tried, typos only in names of one or two words, so ordinary words don't turn into
   * page titles.
   */
  private looseMatch(question: string): string | null {
    const keys = this.titleKeys();
    const usable = (title: string) => !title.includes('/') && this.hasContent(title) && !this.isDisambiguation(title);
    const candidates = titleCandidates(question).filter((c) => !c.replace(/^The /, '').split(' ').some((w) => isStopWord(w)));
    for (const c of candidates) {
      const title = keys.get(looseKey(c));
      if (title && looseKey(c).length >= 6 && usable(title)) return title;
    }
    for (const c of candidates) {
      if (c.split(' ').length > 2) continue;
      const key = looseKey(c);
      const allowed = typosAllowed(key.length);
      if (!allowed) continue;
      let best: { title: string; d: number } | null = null;
      for (const [k, title] of keys) {
        if (k[0] !== key[0] || k.at(-1) !== key.at(-1) || Math.abs(k.length - key.length) > allowed) continue;
        const d = distance(key, k);
        if (d <= allowed && (!best || d < best.d)) best = { title, d };
      }
      if (best && usable(best.title)) return best.title;
    }
    return null;
  }

  /** The page a question is about: one it names (exactly, loosely or with a typo), or null. Disambiguation pages don't count. */
  subjectOf(question: string): string | null {
    const match = this.titleMatch(question);
    return match && !match.disambiguation ? match.title : null;
  }

  /** Text of a shell page's subpages ("Kuva Lich" → "Kuva Lich/Main", "/Gameplay", …), sections labelled by subpage. */
  private subpageChunks(title: string, question: string): { section: string; body: string }[] {
    const rows = this.db
      .prepare(`SELECT title FROM pages WHERE title LIKE ? ESCAPE '\\' ORDER BY length(title), title LIMIT 25`)
      .all(`${title.replace(/[\\%_]/g, '\\$&')}/%`) as Row[];
    const wantsPatches = WANTS_PATCHES.test(question);
    const wantsFluff = WANTS_FLUFF.test(question);
    const out: { section: string; body: string }[] = [];
    let used = 0;
    for (const r of rows) {
      const sub = String(r.title);
      if ((!wantsPatches && PATCH_TITLE.test(sub)) || (!wantsFluff && FLUFF_TITLE.test(sub)) || used >= MAX_SUBPAGES) continue;
      used++;
      const label = sub.slice(title.length + 1);
      for (const c of this.chunksOf(sub)) out.push({ section: c.section === 'Introduction' ? label : `${label} › ${c.section}`, body: c.body });
    }
    return out;
  }

  private bestChunks(chunks: { section: string; body: string }[], terms: string[], n: number, question = '', title = '') {
    const acquisition = WANTS_ACQUISITION.test(question);
    const farming = WANTS_FARMING.test(question);
    const lore = WANTS_LORE.test(question);
    const definition = WANTS_DEFINITION.test(question) || /\bhow (does|do)\b[^?]*\bwork/i.test(question);
    // A section named after the page itself ("Helminth Cyst" on Helminth) says nothing about what was asked.
    const named = title.toLowerCase();
    const score = (c: { section: string; body: string }) => {
      const text = `${c.section} ${c.body}`.toLowerCase();
      const section = c.section.toLowerCase();
      let s = terms.reduce((sum, t) => sum + (mentions(text, t) ? 1 : 0) + (mentions(section, t) && !mentions(named, t) ? 2 : 0), 0);
      if (acquisition && ACQUISITION_SECTION.test(c.section)) s += 3;
      if (farming && FARMING_SECTION.test(c.section)) s += 2;
      if (!lore && LORE_SECTION.test(c.section)) s -= 3;
      if (definition && USAGE_SECTION.test(c.section)) s += 1;
      return s;
    };
    // Stable sort: ties keep page order, so the introduction wins when nothing else matches better.
    return chunks
      .map((c, i) => ({ c, i, s: score(c) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, n)
      .sort((a, b) => a.i - b.i)
      .map((x) => x.c);
  }

  private toPassage(title: string, chunks: { section: string; body: string }[], maxChars = MAX_EXTRACT): WikiPassage {
    const text = chunks
      .map((c) => (c.section === 'Introduction' ? c.body : `**${c.section}**\n${c.body}`))
      .join('\n\n')
      .slice(0, maxChars);
    return { title, url: wikiUrl(title), extract: text };
  }

  /**
   * Passages that answer a question: the page whose title appears in it first, then the best full-text matches
   * (every word, then most words). Returns [] when nothing relevant is indexed. `pageChunks`/`pageChars` give the named
   * page more room (the answer pipeline uses it: the page a question names usually holds the answer).
   */
  search(question: string, limit = 3, opts: { pageChunks?: number; pageChars?: number } = {}): WikiPassage[] {
    const terms = queryTerms(question);
    if (!terms.length) return [];
    const out: WikiPassage[] = [];
    const seen = new Set<string>();

    // A disambiguation page ("Riven may refer to…") only goes first when nothing else turns up.
    let trailing: WikiPassage | null = null;
    const match = this.titleMatch(question);
    if (match) {
      const { title } = match;
      let source = this.chunksOf(title);
      // Many pages are navigation shells whose text lives on subpages ("Kuva Lich" → "Kuva Lich/Main").
      if (source.reduce((n, c) => n + c.body.length, 0) < 300) source = [...source, ...this.subpageChunks(title, question)];
      if (source.length) {
        // "What is a Helminth?" only names the page, so the introduction alone answers it; other questions get more.
        const justTheName = terms.every((t) => mentions(title.toLowerCase(), t));
        const perPage = opts.pageChunks ?? PER_PAGE_CHUNKS;
        // "What is X and how do I start it": the introduction says what X is, so it always comes first for a definition question,
        // and in the answer pipeline always (it says what something is made of: "Viral is Cold and Toxin"); the best sections fill the rest.
        const [intro, ...rest] = source;
        const picked =
          intro && (WANTS_DEFINITION.test(question) || opts.pageChunks)
            ? [intro, ...this.bestChunks(rest, withSynonyms(terms), perPage - 1, question, title)]
            : this.bestChunks(source, withSynonyms(terms), justTheName ? 1 : perPage, question, title);
        const passage = this.toPassage(title, picked, opts.pageChars);
        if (match.disambiguation) trailing = passage;
        else out.push(passage);
        seen.add(title.toLowerCase());
      }
    }

    const wantsPatches = WANTS_PATCHES.test(question);
    const wantsFluff = WANTS_FLUFF.test(question);
    // A term with synonyms matches any of them ("nickname" finds the FAQ's "username").
    const groups = terms.map((t) => [t, ...synonymsOf(t)]);
    const quoted = groups.map((g) => (g.length > 1 ? `(${g.map((w) => `"${w}"`).join(' OR ')})` : `"${g[0]}"`));
    const queries = [quoted.join(' AND '), quoted.join(' OR ')];
    const need = Math.max(1, Math.ceil(terms.length * 0.6));
    const stmt = this.db.prepare('SELECT title, section, body, bm25(chunks, 8.0, 3.0, 1.0) AS score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT 60');
    const byPage = new Map<string, { title: string; chunks: { section: string; body: string }[] }>();
    for (const q of queries) {
      for (const r of stmt.all(q) as Row[]) {
        const t = String(r.title);
        if (seen.has(t.toLowerCase()) || (!wantsPatches && PATCH_TITLE.test(t)) || (!wantsFluff && FLUFF_TITLE.test(t))) continue;
        const text = `${r.section} ${r.body} ${t}`.toLowerCase();
        if (groups.filter((g) => g.some((w) => mentions(text, w))).length < need) continue;
        const entry = byPage.get(t) ?? { title: t, chunks: [] };
        if (entry.chunks.length < PER_PAGE_CHUNKS) entry.chunks.push({ section: String(r.section), body: String(r.body) });
        byPage.set(t, entry);
      }
      if (byPage.size >= limit) break;
    }
    // Pages whose title holds every word of the question ("Riven Mods" for "riven") beat looser matches, shortest title first.
    const covers = (title: string) => terms.every((t) => mentions(title.toLowerCase(), t));
    const ranked = [...byPage.values()].sort((a, b) => Number(covers(b.title)) - Number(covers(a.title)) || (covers(a.title) && covers(b.title) ? a.title.length - b.title.length : 0));
    for (const page of ranked) {
      if (out.length >= limit) break;
      out.push(this.toPassage(page.title, page.chunks));
    }
    if (trailing && out.length < limit) out.push(trailing);
    return out.slice(0, limit);
  }
}

let current: WikiIndex | null = null;
/** The process-wide index that searchWiki() consults (null when disabled). */
export const setWikiIndex = (index: WikiIndex | null) => {
  current = index;
};
export const getWikiIndex = () => current;
