import type { AppContext } from '../context.js';
import type { StoredBackup } from '../db.js';
import { type BackupSummary, createSnapshot, summarize } from './snapshot.js';

export const AUTO_BACKUP_INTERVAL_MS = 24 * 3_600_000;
export const KEEP_AUTO_BACKUPS = 14;
const CHECK_INTERVAL_MS = 3_600_000;

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

/** Takes an automatic backup whenever the newest one is older than a day; checks hourly. */
export class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private readonly ctx: AppContext) {}

  start(): void {
    this.stop();
    // Give the gateway a minute to settle before the first check.
    this.first = setTimeout(() => void this.check(), 60_000);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = null;
  }

  private async check(): Promise<void> {
    const latest = this.ctx.store.listBackups(this.ctx.config.DISCORD_GUILD_ID).find((b) => b.auto);
    if (latest && Date.now() - latest.createdAt < AUTO_BACKUP_INTERVAL_MS) return;
    await takeBackup(this.ctx, null, true).catch((err) => console.error('[backup] automatic backup failed:', err));
  }
}
