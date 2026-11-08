import type { AppContext } from '../context.js';
import type { StoredBackup } from '../db.js';
import { type BackupSummary, createSnapshot, summarize } from './snapshot.js';

export const AUTO_BACKUP_INTERVAL_MS = 24 * 3_600_000;
export const KEEP_AUTO_BACKUPS = 14;
/** How often the backup job looks whether a day has passed since the last automatic backup. */
export const BACKUP_CHECK_MS = 3_600_000;

let running: Promise<StoredBackup> | null = null;

/** Snapshots the clan server into the database. Concurrent calls share one snapshot. */
export function takeBackup(ctx: AppContext, label: string | null, auto: boolean): Promise<StoredBackup> {
  running ??= (async () => {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const guild = await ctx.client.guilds.fetch(guildId);
    const snapshot = await createSnapshot(guild, ctx.store.getSettings(guildId));
    const data = JSON.stringify(snapshot);
    const stored = ctx.store.saveBackup({
      guildId,
      label,
      auto,
      summary: JSON.stringify(summarize(snapshot, Buffer.byteLength(data))),
      data,
      createdAt: snapshot.createdAt,
    });
    if (auto) ctx.store.pruneAutoBackups(guildId, KEEP_AUTO_BACKUPS);
    console.log(`[backup] ${auto ? 'automatic' : 'manual'} backup #${stored.id} saved (${Math.round(Buffer.byteLength(data) / 1024)} KB)`);
    return stored;
  })().finally(() => {
    running = null;
  });
  return running;
}

export const summaryOf = (b: StoredBackup) => JSON.parse(b.summary) as BackupSummary;

/** Takes an automatic backup when the newest one is older than a day (the hourly backup job, src/jobs.ts). */
export async function backupIfDue(ctx: AppContext): Promise<void> {
  const latest = ctx.store.listBackups(ctx.config.DISCORD_GUILD_ID).find((b) => b.auto);
  if (latest && Date.now() - latest.createdAt < AUTO_BACKUP_INTERVAL_MS) return;
  await takeBackup(ctx, null, true);
}
