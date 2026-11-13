import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { KEEP_AUTO_COPIES, KEEP_MANUAL_COPIES, copyDatabase, databaseCopyDir, databaseCopyIfDue, listDatabaseCopies } from '../src/backup/database.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { sessionSecret } from '../src/web/admin/auth.js';

const G = '111111111111111111';
const HOUR = 3_600_000;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/** A bot with a real database, a data folder of its own and a staff channel that records what is posted in it. */
function world() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ordis-dbcopy-'));
  folders.push(dataDir);
  const store = new Store(':memory:');
  const notices: { channel: string; title: string; description: string }[] = [];
  const client = {
    channels: {
      fetch: async (id: string) => ({
        id,
        guildId: G,
        isSendable: () => true,
        send: async (payload: { embeds: { toJSON(): { title: string; description: string } }[] }) => {
          const embed = payload.embeds[0]!.toJSON();
          notices.push({ channel: id, title: embed.title, description: embed.description });
          return { id: 'm1' };
        },
      }),
    },
  };
  const ctx = { config: { DATA_DIR: dataDir, DISCORD_GUILD_ID: G, CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Cephalon Ordis' }, store, client } as unknown as AppContext;
  return { ctx, store, dataDir, dir: databaseCopyDir(ctx.config), notices };
}

const NIGHT = Date.UTC(2026, 10, 13, 3, 0, 12);

describe('the nightly copy of the database', () => {
  it('holds everything but the cache, the panel logins and the key that signs their cookies', async () => {
    const w = world();
    w.store.updateSettings(G, { newsChannelId: 'c-news' });
    w.store.setMeta('weekly_posted', '2026-W46');
    sessionSecret(w.store);
    const key = w.store.getMeta('panel_session_secret')!;
    w.store.createPanelSession({ id: 'session-id-0123456789', userId: '1', username: 'Rat', avatar: null, csrf: 'csrf-token-0123456789' }, 60_000);
    w.store.putApiCache('https://example.test/items', { body: 'CACHED-ANSWER '.repeat(4000), status: 200, etag: null, lastModified: null, fetchedAt: 1 });
    const version = (w.store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

    const copy = await copyDatabase(w.ctx, 'auto', NIGHT);
    assert.equal(copy.file, 'ordis-db-2026-11-13-030012-auto.db.gz');
    assert.equal(copy.kind, 'auto');
    assert.equal(copy.at, NIGHT);
    assert.deepEqual(readdirSync(w.dir), [copy.file], 'only the finished archive is left in the folder');
    assert.deepEqual(listDatabaseCopies(w.ctx), [copy]);

    // The bytes themselves: what was left out is not in the file any more, not even on a freed page.
    const raw = gunzipSync(readFileSync(copy.path));
    assert.equal(raw.subarray(0, 15).toString(), 'SQLite format 3');
    for (const gone of [key, 'CACHED-ANSWER', 'csrf-token-0123456789', 'session-id-0123456789']) assert.equal(raw.includes(gone), false, `${gone.slice(0, 13)}… is still in the copy`);

    const file = join(w.dataDir, 'restored.db');
    writeFileSync(file, raw);
    const db = new DatabaseSync(file);
    try {
      const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      assert.equal(count('api_cache'), 0);
      assert.equal(count('panel_sessions'), 0);
      assert.equal(db.prepare("SELECT value FROM bot_meta WHERE key = 'panel_session_secret'").get(), undefined);
      assert.equal((db.prepare("SELECT value FROM bot_meta WHERE key = 'weekly_posted'").get() as { value: string }).value, '2026-W46');
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, version, 'the schema version comes along');
    } finally {
      db.close();
    }

    // Putting it back is putting the file where bot.db was: Ordis opens it like any database of his.
    const restored = new Store(file);
    try {
      assert.equal(restored.getSettings(G).newsChannelId, 'c-news');
      assert.notEqual(sessionSecret(restored).toString('hex'), key, 'a new key is made, so the old logins end');
    } finally {
      restored.close();
    }

    // The live database lost nothing by being copied.
    assert.equal(w.store.getMeta('panel_session_secret'), key);
    assert.equal(w.store.apiCacheSize().entries, 1);
  });

  it(`keeps the newest ${KEEP_AUTO_COPIES} nightly and ${KEEP_MANUAL_COPIES} manual copies, and touches nothing else in the folder`, async () => {
    const w = world();
    mkdirSync(w.dir, { recursive: true });
    for (let day = 1; day <= 9; day++) writeFileSync(join(w.dir, `ordis-db-2026-11-0${day}-030000-auto.db.gz`), 'old');
    for (let n = 0; n < 5; n++) writeFileSync(join(w.dir, `ordis-db-2026-11-10-12000${n}-manual.db.gz`), 'old');
    writeFileSync(join(w.dir, 'notes.txt'), 'not a copy');
    writeFileSync(join(w.dir, 'ordis-db-2026-13-45-030000-auto.db.gz'), 'a date that does not exist');
    // What a run that was cut off left behind.
    writeFileSync(join(w.dir, 'ordis-db-2026-11-12-030000-auto.db.gz.tmp'), 'half');
    writeFileSync(join(w.dir, 'ordis-db-2026-11-12-030000-auto.db.gz.tmp-wal'), 'half');
    writeFileSync(join(w.dir, 'ordis-db-2026-11-12-030000-auto.db.gz.partial'), 'half');

    await copyDatabase(w.ctx, 'auto', NIGHT);
    const left = listDatabaseCopies(w.ctx);
    assert.deepEqual(
      left.filter((c) => c.kind === 'auto').map((c) => c.file.slice(9, 19)),
      ['2026-11-13', '2026-11-09', '2026-11-08', '2026-11-07', '2026-11-06', '2026-11-05', '2026-11-04'],
    );
    assert.deepEqual(
      left.filter((c) => c.kind === 'manual').map((c) => c.file.slice(20, 26)),
      ['120004', '120003', '120002'],
    );
    assert.deepEqual(
      readdirSync(w.dir)
        .filter((name) => !left.some((c) => c.file === name))
        .sort(),
      ['notes.txt', 'ordis-db-2026-13-45-030000-auto.db.gz'],
      'the leftovers are gone, everything that is not a copy stays',
    );
  });

  it('lists only files named exactly like a copy', () => {
    const w = world();
    assert.deepEqual(listDatabaseCopies(w.ctx), [], 'no folder yet');
    mkdirSync(w.dir, { recursive: true });
    const real = 'ordis-db-2026-11-13-030012-manual.db.gz';
    for (const name of [real, 'bot.db', `${real}.partial`, `x${real}`, 'ordis-db-2026-11-13-030012-AUTO.db.gz', 'ordis-db-2026-11-13-030012-auto.db', 'ordis-db-2026-02-30-030012-auto.db.gz']) {
      writeFileSync(join(w.dir, name), 'x');
    }
    mkdirSync(join(w.dir, 'ordis-db-2026-11-12-030012-auto.db.gz'));
    const copies = listDatabaseCopies(w.ctx);
    assert.deepEqual(copies.map((c) => [c.file, c.kind, c.at, c.bytes]), [[real, 'manual', NIGHT, 1]]);
  });

  it('makes one copy a night, from 03:00 UTC on, and a manual copy does not stand in for it', async () => {
    const w = world();
    const first = await databaseCopyIfDue(w.ctx, NIGHT);
    assert.equal(first?.kind, 'auto', 'none yet, so one is made at once');
    assert.equal(await databaseCopyIfDue(w.ctx, NIGHT + HOUR), null);
    assert.equal(await databaseCopyIfDue(w.ctx, Date.UTC(2026, 10, 14, 2, 59, 59)), null, 'the same night until 03:00 UTC');
    const second = await databaseCopyIfDue(w.ctx, Date.UTC(2026, 10, 14, 3, 0, 1));
    assert.equal(second?.file, 'ordis-db-2026-11-14-030001-auto.db.gz');
    assert.equal(listDatabaseCopies(w.ctx).length, 2);

    const other = world();
    await copyDatabase(other.ctx, 'manual', NIGHT);
    assert.equal((await databaseCopyIfDue(other.ctx, NIGHT + 60_000))?.kind, 'auto');
  });

  it('shares one copy between calls that overlap', async () => {
    const w = world();
    const [a, b] = await Promise.all([copyDatabase(w.ctx, 'auto', NIGHT), copyDatabase(w.ctx, 'manual', NIGHT)]);
    assert.equal(a, b);
    assert.deepEqual(readdirSync(w.dir), ['ordis-db-2026-11-13-030012-auto.db.gz']);
    // And the next call makes its own again.
    assert.equal((await copyDatabase(w.ctx, 'manual', NIGHT + 1000)).kind, 'manual');
  });

  it('tells the staff once a night when the copy fails, and leaves no half copy', async () => {
    const w = world();
    w.store.updateSettings(G, { statusChannelId: 'c-logs' });
    w.store.copyTo = async (path: string) => {
      writeFileSync(path, 'half a database');
      throw new Error('database or disk is full');
    };
    await assert.rejects(databaseCopyIfDue(w.ctx, NIGHT), /disk is full/);
    assert.equal(w.notices.length, 1);
    assert.equal(w.notices[0]!.channel, 'c-logs');
    assert.equal(w.notices[0]!.title, '⚠️ The nightly database copy failed');
    assert.match(w.notices[0]!.description, /could not copy his database: database or disk is full/);
    assert.match(w.notices[0]!.description, /There is no copy yet\./);
    assert.deepEqual(readdirSync(w.dir), []);

    await assert.rejects(databaseCopyIfDue(w.ctx, NIGHT + HOUR), /disk is full/, 'it is tried again every hour');
    assert.equal(w.notices.length, 1, 'but said once');
    await assert.rejects(databaseCopyIfDue(w.ctx, NIGHT + 24 * HOUR), /disk is full/);
    assert.equal(w.notices.length, 2, 'and again the next night');
  });

  it('refuses a copy that is not a sound database', async () => {
    const w = world();
    w.store.copyTo = async (path: string) => {
      writeFileSync(path, 'this is not a database, however long it goes on. '.repeat(200));
      return 1;
    };
    await assert.rejects(copyDatabase(w.ctx, 'manual', NIGHT));
    assert.deepEqual(readdirSync(w.dir), [], 'nothing is kept under a name the listing knows');
    assert.deepEqual(listDatabaseCopies(w.ctx), []);
  });
});
