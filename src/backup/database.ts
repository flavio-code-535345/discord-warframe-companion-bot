import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { createGzip } from 'node:zlib';
import type { AppContext } from '../context.js';
import { staffNotice } from '../discord/staff.js';

/**
 * Copies of Ordis's own database (`bot.db`: members, trackers, levels, settings, the riven and relic data), one a night, kept as
 * gzipped files in `<DATA_DIR>/backups`. This is not the server backup of `service.ts` (roles and channels, stored inside the
 * database): it is what brings the database itself back after a bad update, a corrupted file or a mistake.
 *
 * A copy leaves out what can be fetched again (the API cache, up to 200 MB) and what must not travel with a file someone downloads
 * (the panel's logins and the key that signs their cookies).
 */

export type CopyKind = 'auto' | 'manual';

export interface DatabaseCopy {
  file: string;
  path: string;
  kind: CopyKind;
  /** When it was taken, read from the name (a file's own date changes when it is moved around). */
  at: number;
  bytes: number;
}

/** How often the `db-copy` job looks whether the night's copy is still to be made. */
export const DB_COPY_CHECK_MS = 3_600_000;
export const KEEP_AUTO_COPIES = 7;
export const KEEP_MANUAL_COPIES = 3;

const DAY_MS = 24 * 3_600_000;
/** A copy "night" starts at 03:00 UTC: the first check after that makes the copy, also when the bot was off at that hour. */
const NIGHT_STARTS_MS = 3 * 3_600_000;
const nightOf = (at: number) => Math.floor((at - NIGHT_STARTS_MS) / DAY_MS);

/** The tables and bot_meta keys a copy leaves out. */
const SKIP_TABLES = ['api_cache', 'panel_sessions'];
const SKIP_META = ['panel_session_secret'];

const NAME = /^ordis-db-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})-(auto|manual)\.db\.gz$/;
/** What a run that was cut off leaves behind: the raw copy with SQLite's side files, and a half-written archive. */
const LEFTOVER = /\.(?:tmp(?:-wal|-shm|-journal)?|partial)$/;

function nameFor(kind: CopyKind, at: number): string {
  const iso = new Date(at).toISOString();
  return `ordis-db-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}-${kind}.db.gz`;
}

/** The kind and time a file name says, or null for anything that is not a copy (also a name with a date that does not exist). */
function readName(file: string): { kind: CopyKind; at: number } | null {
  const m = NAME.exec(file);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const at = Date.UTC(y, mo - 1, d, h, mi, s);
  const kind = m[7] as CopyKind;
  return Number.isFinite(at) && nameFor(kind, at) === file ? { kind, at } : null;
}

export const databaseCopyDir = (config: Pick<AppContext['config'], 'DATA_DIR'>): string => resolve(config.DATA_DIR, 'backups');

/**
 * The copies in the folder, newest first. Only files whose name is exactly what `copyDatabase` writes are listed, so a name from an
 * address can be looked up here and never leads anywhere else.
 */
export function listDatabaseCopies(ctx: Pick<AppContext, 'config'>): DatabaseCopy[] {
  const dir = databaseCopyDir(ctx.config);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const copies: DatabaseCopy[] = [];
  for (const file of names) {
    const named = readName(file);
    if (!named) continue;
    try {
      const stat = statSync(join(dir, file));
      if (stat.isFile()) copies.push({ file, path: join(dir, file), ...named, bytes: stat.size });
    } catch {
      // Gone between the listing and the look: not a copy any more.
    }
  }
  return copies.sort((a, b) => b.at - a.at);
}

function clearLeftovers(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const file of names) {
    if (!LEFTOVER.test(file)) continue;
    try {
      rmSync(join(dir, file), { force: true });
    } catch (err) {
      console.warn(`[db-copy] could not remove ${file}:`, (err as Error).message);
    }
  }
}

/**
 * Runs in a worker thread, on the raw copy: empties what a copy leaves out, rewrites the file without the freed pages (VACUUM, so
 * what was deleted is really gone from the file and not just unlinked) and has SQLite check the result. All of it is synchronous
 * SQLite work that would hold up the bot for as long as it takes, which is why it is not done on the main thread. Plain JavaScript
 * in a string, so it runs the same from source (tsx), in the tests and from `dist/`.
 */
const SCRUB = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.path);
try {
  // One file, without the write-ahead log's side files: the copy is opened once more and then only read.
  db.exec('PRAGMA journal_mode = DELETE');
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const name of workerData.tables) if (table.get(name)) db.exec('DELETE FROM "' + name + '"');
  if (table.get('bot_meta')) {
    const forget = db.prepare('DELETE FROM bot_meta WHERE key = ?');
    for (const key of workerData.meta) forget.run(key);
  }
  db.exec('VACUUM');
  parentPort.postMessage(String(Object.values(db.prepare('PRAGMA quick_check').get() ?? {})[0]));
} finally {
  db.close();
}
`;

function scrub(path: string): Promise<void> {
  return new Promise((done, fail) => {
    // No execArgv: the worker needs none of the loaders the bot itself may have been started with.
    const worker = new Worker(SCRUB, { eval: true, execArgv: [], workerData: { path, tables: SKIP_TABLES, meta: SKIP_META } });
    let verdict: unknown;
    worker.once('message', (message) => {
      verdict = message;
    });
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (code !== 0) fail(new Error(`cleaning the copy stopped with exit code ${code}`));
      else if (verdict !== 'ok') fail(new Error(`SQLite found the copy damaged: ${String(verdict).slice(0, 200)}`));
      else done();
    });
  });
}

/** Keeps the newest copies of each kind and deletes the rest. */
function prune(ctx: Pick<AppContext, 'config'>): void {
  const copies = listDatabaseCopies(ctx);
  const extra = [...copies.filter((c) => c.kind === 'auto').slice(KEEP_AUTO_COPIES), ...copies.filter((c) => c.kind === 'manual').slice(KEEP_MANUAL_COPIES)];
  for (const copy of extra) {
    try {
      rmSync(copy.path, { force: true });
    } catch (err) {
      console.warn(`[db-copy] could not remove the old copy ${copy.file}:`, (err as Error).message);
    }
  }
}

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

async function make(ctx: Pick<AppContext, 'config' | 'store'>, kind: CopyKind, now: number): Promise<DatabaseCopy> {
  const dir = databaseCopyDir(ctx.config);
  mkdirSync(dir, { recursive: true });
  clearLeftovers(dir);
  const file = nameFor(kind, now);
  const raw = join(dir, `${file}.tmp`);
  const packed = join(dir, `${file}.partial`);
  const started = Date.now();
  try {
    await ctx.store.copyTo(raw);
    await scrub(raw);
    await pipeline(createReadStream(raw), createGzip(), createWriteStream(packed));
    // Only a finished archive gets a name the listing knows.
    renameSync(packed, join(dir, file));
  } finally {
    clearLeftovers(dir);
  }
  prune(ctx);
  const copy = listDatabaseCopies(ctx).find((c) => c.file === file);
  if (!copy) throw new Error(`the copy ${file} was written but is not in ${dir}`);
  console.log(`[db-copy] ${kind === 'auto' ? 'nightly' : 'manual'} copy ${file} saved (${size(copy.bytes)}, ${Date.now() - started} ms)`);
  return copy;
}

let running: Promise<DatabaseCopy> | null = null;

/**
 * Makes a copy now. Calls that overlap share one copy (the nightly one and a tap on "Copy now"), so what comes back may be of the
 * other kind.
 */
export function copyDatabase(ctx: Pick<AppContext, 'config' | 'store'>, kind: CopyKind, now = Date.now()): Promise<DatabaseCopy> {
  running ??= make(ctx, kind, now).finally(() => {
    running = null;
  });
  return running;
}

/**
 * The hourly `db-copy` job (src/jobs.ts): makes the night's copy when there is none yet. A failure is thrown on, so the job's health
 * shows it, and the staff are told once a night (a backup that fails without anyone noticing is no backup).
 */
export async function databaseCopyIfDue(ctx: AppContext, now = Date.now()): Promise<DatabaseCopy | null> {
  const newest = listDatabaseCopies(ctx).find((c) => c.kind === 'auto');
  if (newest && nightOf(newest.at) >= nightOf(now)) return null;
  try {
    return await copyDatabase(ctx, 'auto', now);
  } catch (err) {
    const night = String(nightOf(now));
    if (ctx.store.getMeta('db_copy_failed') !== night) {
      ctx.store.setMeta('db_copy_failed', night);
      await staffNotice(ctx, {
        tone: 'warn',
        title: '⚠️ The nightly database copy failed',
        text: `Ordis could not copy his database: ${(err as Error).message.slice(0, 500)}\n\nHe tries again every hour. ${
          newest ? `The newest copy is from <t:${Math.floor(newest.at / 1000)}:f>.` : 'There is no copy yet.'
        } A full disk is the usual reason: the copies are in \`${databaseCopyDir(ctx.config)}\`.`,
      });
    }
    throw err;
  }
}
