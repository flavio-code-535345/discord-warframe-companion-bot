import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type RsvpStatus = 'going' | 'maybe' | 'declined';

export interface GuildSettings {
  guildId: string;
  alertsChannelId: string | null;
  alertsRoleId: string | null;
  announcementsChannelId: string | null;
  welcomeChannelId: string | null;
  /** Channel where Ordis answers every message (needs the Message Content intent). */
  chatChannelId: string | null;
  /** Channel where moderation actions are logged. */
  modLogChannelId: string | null;
}

export interface Warning {
  id: number;
  guildId: string;
  userId: string;
  moderatorId: string;
  reason: string;
  createdAt: number;
}

/** What a channel's overwrite for one target said about sending before /lock, so /unlock can put it back. */
export type LockPrevious = 'allow' | 'deny' | 'neutral';

export interface Tracker {
  id: number;
  guildId: string;
  userId: string;
  spec: string;
  createdAt: number;
}

export interface Member {
  guildId: string;
  userId: string;
  ign: string;
  masteryRank: number | null;
  platform: string | null;
  registeredAt: number;
}

export interface ClanEvent {
  id: number;
  guildId: string;
  title: string;
  description: string | null;
  startsAt: number;
  createdBy: string;
  channelId: string | null;
  messageId: string | null;
  reminded: boolean;
  cancelled: boolean;
}

export interface LfgPost {
  id: number;
  guildId: string;
  channelId: string;
  messageId: string | null;
  hostId: string;
  activity: string;
  details: string | null;
  size: number;
  closed: boolean;
  createdAt: number;
}

type Row = Record<string, unknown>;

// Each entry upgrades the schema by one version; never edit a shipped migration, append a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY,
    alerts_channel_id TEXT,
    alerts_role_id TEXT,
    announcements_channel_id TEXT,
    welcome_channel_id TEXT
  );
  CREATE TABLE members (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    ign TEXT NOT NULL,
    mastery_rank INTEGER,
    platform TEXT,
    registered_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE UNIQUE INDEX members_ign ON members (guild_id, lower(ign));
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    starts_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    channel_id TEXT,
    message_id TEXT,
    reminded INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE event_rsvps (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('going', 'maybe', 'declined')),
    PRIMARY KEY (event_id, user_id)
  );
  CREATE TABLE lfg_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    host_id TEXT NOT NULL,
    activity TEXT NOT NULL,
    details TEXT,
    size INTEGER NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE lfg_members (
    post_id INTEGER NOT NULL REFERENCES lfg_posts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE TABLE seen_worldstate (
    key TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE bot_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN chat_channel_id TEXT;
  CREATE TABLE trackers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    spec TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX trackers_user ON trackers (guild_id, user_id);
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN mod_log_channel_id TEXT;
  CREATE TABLE warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX warnings_user ON warnings (guild_id, user_id);
  CREATE TABLE channel_locks (
    channel_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    previous TEXT NOT NULL CHECK (previous IN ('allow', 'deny', 'neutral')),
    PRIMARY KEY (channel_id, target_id)
  );
  `,
];

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toEvent(r: Row): ClanEvent {
  return {
    id: Number(r.id),
    guildId: String(r.guild_id),
    title: String(r.title),
    description: str(r.description),
    startsAt: Number(r.starts_at),
    createdBy: String(r.created_by),
    channelId: str(r.channel_id),
    messageId: str(r.message_id),
    reminded: Boolean(r.reminded),
    cancelled: Boolean(r.cancelled),
  };
}

function toMember(r: Row): Member {
  return {
    guildId: String(r.guild_id),
    userId: String(r.user_id),
    ign: String(r.ign),
    masteryRank: r.mastery_rank === null ? null : Number(r.mastery_rank),
    platform: str(r.platform),
    registeredAt: Number(r.registered_at),
  };
}

function toLfg(r: Row): LfgPost {
  return {
    id: Number(r.id),
    guildId: String(r.guild_id),
    channelId: String(r.channel_id),
    messageId: str(r.message_id),
    hostId: String(r.host_id),
    activity: String(r.activity),
    details: str(r.details),
    size: Number(r.size),
    closed: Boolean(r.closed),
    createdAt: Number(r.created_at),
  };
}

export class Store {
  readonly db: DatabaseSync;

  /** Pass ':memory:' for an ephemeral database (used by tests). */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // --- guild settings ---

  getSettings(guildId: string): GuildSettings {
    const r = this.db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(guildId) as Row | undefined;
    return {
      guildId,
      alertsChannelId: str(r?.alerts_channel_id),
      alertsRoleId: str(r?.alerts_role_id),
      announcementsChannelId: str(r?.announcements_channel_id),
      welcomeChannelId: str(r?.welcome_channel_id),
      chatChannelId: str(r?.chat_channel_id),
      modLogChannelId: str(r?.mod_log_channel_id),
    };
  }

  updateSettings(guildId: string, patch: Partial<Omit<GuildSettings, 'guildId'>>): GuildSettings {
    const next = { ...this.getSettings(guildId), ...patch };
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, alerts_channel_id, alerts_role_id, announcements_channel_id, welcome_channel_id, chat_channel_id, mod_log_channel_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET
           alerts_channel_id = excluded.alerts_channel_id,
           alerts_role_id = excluded.alerts_role_id,
           announcements_channel_id = excluded.announcements_channel_id,
           welcome_channel_id = excluded.welcome_channel_id,
           chat_channel_id = excluded.chat_channel_id,
           mod_log_channel_id = excluded.mod_log_channel_id`,
      )
      .run(
        guildId,
        next.alertsChannelId,
        next.alertsRoleId,
        next.announcementsChannelId,
        next.welcomeChannelId,
        next.chatChannelId,
        next.modLogChannelId,
      );
    return next;
  }

  allSettings(): GuildSettings[] {
    const rows = this.db.prepare('SELECT guild_id FROM guild_settings').all() as Row[];
    return rows.map((r) => this.getSettings(String(r.guild_id)));
  }

  // --- members ---

  /** Inserts or updates a member. Throws if the IGN is already registered to someone else in this guild. */
  upsertMember(m: Omit<Member, 'registeredAt'>): Member {
    const clash = this.db
      .prepare('SELECT user_id FROM members WHERE guild_id = ? AND lower(ign) = lower(?) AND user_id <> ?')
      .get(m.guildId, m.ign, m.userId) as Row | undefined;
    if (clash) throw new Error(`The in-game name "${m.ign}" is already registered to <@${String(clash.user_id)}>.`);
    this.db
      .prepare(
        `INSERT INTO members (guild_id, user_id, ign, mastery_rank, platform, registered_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET
           ign = excluded.ign, mastery_rank = excluded.mastery_rank, platform = excluded.platform`,
      )
      .run(m.guildId, m.userId, m.ign, m.masteryRank, m.platform, Date.now());
    return this.getMember(m.guildId, m.userId)!;
  }

  getMember(guildId: string, userId: string): Member | null {
    const r = this.db.prepare('SELECT * FROM members WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as Row | undefined;
    return r ? toMember(r) : null;
  }

  findMemberByIgn(guildId: string, ign: string): Member | null {
    const r = this.db.prepare('SELECT * FROM members WHERE guild_id = ? AND lower(ign) = lower(?)').get(guildId, ign) as
      | Row
      | undefined;
    return r ? toMember(r) : null;
  }

  removeMember(guildId: string, userId: string): boolean {
    return this.db.prepare('DELETE FROM members WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes > 0;
  }

  listMembers(guildId: string): Member[] {
    const rows = this.db.prepare('SELECT * FROM members WHERE guild_id = ? ORDER BY lower(ign)').all(guildId) as Row[];
    return rows.map(toMember);
  }

  // --- events ---

  createEvent(e: Pick<ClanEvent, 'guildId' | 'title' | 'description' | 'startsAt' | 'createdBy'>): ClanEvent {
    const res = this.db
      .prepare('INSERT INTO events (guild_id, title, description, starts_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(e.guildId, e.title, e.description, e.startsAt, e.createdBy);
    return this.getEvent(Number(res.lastInsertRowid))!;
  }

  getEvent(id: number): ClanEvent | null {
    const r = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return r ? toEvent(r) : null;
  }

  setEventMessage(id: number, channelId: string, messageId: string): void {
    this.db.prepare('UPDATE events SET channel_id = ?, message_id = ? WHERE id = ?').run(channelId, messageId, id);
  }

  cancelEvent(id: number): void {
    this.db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(id);
  }

  markEventReminded(id: number): void {
    this.db.prepare('UPDATE events SET reminded = 1 WHERE id = ?').run(id);
  }

  /** Active (not cancelled) events that start after `since`, soonest first. */
  upcomingEvents(guildId: string, since = Date.now()): ClanEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE guild_id = ? AND cancelled = 0 AND starts_at >= ? ORDER BY starts_at')
      .all(guildId, since) as Row[];
    return rows.map(toEvent);
  }

  /** Events starting within the next `windowMs` that have not had their reminder sent yet. */
  eventsDueForReminder(now: number, windowMs: number): ClanEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE cancelled = 0 AND reminded = 0 AND starts_at > ? AND starts_at <= ?')
      .all(now, now + windowMs) as Row[];
    return rows.map(toEvent);
  }

  setRsvp(eventId: number, userId: string, status: RsvpStatus): void {
    this.db
      .prepare(
        `INSERT INTO event_rsvps (event_id, user_id, status) VALUES (?, ?, ?)
         ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status`,
      )
      .run(eventId, userId, status);
  }

  getRsvps(eventId: number): Record<RsvpStatus, string[]> {
    const rows = this.db.prepare('SELECT user_id, status FROM event_rsvps WHERE event_id = ?').all(eventId) as Row[];
    const out: Record<RsvpStatus, string[]> = { going: [], maybe: [], declined: [] };
    for (const r of rows) out[r.status as RsvpStatus].push(String(r.user_id));
    return out;
  }

  // --- LFG ---

  createLfg(p: Pick<LfgPost, 'guildId' | 'channelId' | 'hostId' | 'activity' | 'details' | 'size'>): LfgPost {
    const res = this.db
      .prepare('INSERT INTO lfg_posts (guild_id, channel_id, host_id, activity, details, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.guildId, p.channelId, p.hostId, p.activity, p.details, p.size, Date.now());
    const id = Number(res.lastInsertRowid);
    this.joinLfg(id, p.hostId);
    return this.getLfg(id)!;
  }

  getLfg(id: number): LfgPost | null {
    const r = this.db.prepare('SELECT * FROM lfg_posts WHERE id = ?').get(id) as Row | undefined;
    return r ? toLfg(r) : null;
  }

  setLfgMessage(id: number, messageId: string): void {
    this.db.prepare('UPDATE lfg_posts SET message_id = ? WHERE id = ?').run(messageId, id);
  }

  closeLfg(id: number): void {
    this.db.prepare('UPDATE lfg_posts SET closed = 1 WHERE id = ?').run(id);
  }

  joinLfg(id: number, userId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO lfg_members (post_id, user_id) VALUES (?, ?)').run(id, userId);
  }

  leaveLfg(id: number, userId: string): void {
    this.db.prepare('DELETE FROM lfg_members WHERE post_id = ? AND user_id = ?').run(id, userId);
  }

  lfgMembers(id: number): string[] {
    const rows = this.db.prepare('SELECT user_id FROM lfg_members WHERE post_id = ? ORDER BY rowid').all(id) as Row[];
    return rows.map((r) => String(r.user_id));
  }

  // --- personal trackers ---

  createTracker(guildId: string, userId: string, spec: string): Tracker {
    const res = this.db
      .prepare('INSERT INTO trackers (guild_id, user_id, spec, created_at) VALUES (?, ?, ?, ?)')
      .run(guildId, userId, spec, Date.now());
    return this.listTrackers(guildId, userId).find((t) => t.id === Number(res.lastInsertRowid))!;
  }

  listTrackers(guildId: string, userId?: string): Tracker[] {
    const rows = (
      userId
        ? this.db.prepare('SELECT * FROM trackers WHERE guild_id = ? AND user_id = ? ORDER BY id').all(guildId, userId)
        : this.db.prepare('SELECT * FROM trackers WHERE guild_id = ? ORDER BY id').all(guildId)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      guildId: String(r.guild_id),
      userId: String(r.user_id),
      spec: String(r.spec),
      createdAt: Number(r.created_at),
    }));
  }

  /** Deletes one of the user's own trackers. */
  deleteTracker(guildId: string, userId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM trackers WHERE guild_id = ? AND user_id = ? AND id = ?').run(guildId, userId, id).changes > 0;
  }

  // --- moderation ---

  addWarning(w: Omit<Warning, 'id' | 'createdAt'>): Warning {
    const res = this.db
      .prepare('INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(w.guildId, w.userId, w.moderatorId, w.reason, Date.now());
    return this.listWarnings(w.guildId, w.userId).find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  listWarnings(guildId: string, userId: string): Warning[] {
    const rows = this.db.prepare('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id').all(guildId, userId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      guildId: String(r.guild_id),
      userId: String(r.user_id),
      moderatorId: String(r.moderator_id),
      reason: String(r.reason),
      createdAt: Number(r.created_at),
    }));
  }

  clearWarnings(guildId: string, userId: string): number {
    return Number(this.db.prepare('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes);
  }

  saveLock(channelId: string, previous: Record<string, LockPrevious>): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO channel_locks (channel_id, target_id, previous) VALUES (?, ?, ?)');
    for (const [targetId, state] of Object.entries(previous)) insert.run(channelId, targetId, state);
  }

  /** The saved pre-lock states for a channel, removed from storage; empty when the channel isn't locked. */
  takeLock(channelId: string): Record<string, LockPrevious> {
    const rows = this.db.prepare('SELECT target_id, previous FROM channel_locks WHERE channel_id = ?').all(channelId) as Row[];
    this.db.prepare('DELETE FROM channel_locks WHERE channel_id = ?').run(channelId);
    return Object.fromEntries(rows.map((r) => [String(r.target_id), r.previous as LockPrevious]));
  }

  isLocked(channelId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM channel_locks WHERE channel_id = ? LIMIT 1').get(channelId));
  }

  // --- bot-wide key/value state ---

  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM bot_meta WHERE key = ?').get(key) as Row | undefined;
    return str(r?.value);
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO bot_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  // --- worldstate notification de-duplication ---

  /** Records `key` as seen. Returns true only the first time a key is seen. */
  markSeen(key: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO seen_worldstate (key, seen_at) VALUES (?, ?)').run(key, Date.now()).changes > 0;
  }

  seenCount(): number {
    return Number((this.db.prepare('SELECT count(*) AS n FROM seen_worldstate').get() as Row).n);
  }

  pruneSeen(olderThanMs: number): void {
    this.db.prepare('DELETE FROM seen_worldstate WHERE seen_at < ?').run(Date.now() - olderThanMs);
  }
}
