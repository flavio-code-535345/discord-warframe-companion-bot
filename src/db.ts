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
  /** Verification: the panel's channel and message, the role it grants, and the minimum account age in days. */
  verifyChannelId: string | null;
  verifyPanelMessageId: string | null;
  verifyRoleId: string | null;
  verifyMinAccountAgeDays: number | null;
  /** Honeypot: anyone without moderator powers who posts here is removed. Action is 'ban', 'softban' or 'kick'. */
  honeypotChannelId: string | null;
  honeypotAction: string | null;
  /** Category for auto-created squad voice channels (/lfg); null leaves squads without voice. */
  lfgVoiceCategoryId: string | null;
  /** Minutes a squad waits for its host to be in voice before closing (default 5). */
  lfgVoiceGraceMinutes: number | null;
  /** Join-to-create: joining this voice channel makes a personal room for the member. */
  autoVcHubChannelId: string | null;
  /** Screenshot roles: members post their profile card here to get the roles it earns. */
  ssRolesChannelId: string | null;
  /** Leveling is on unless this is 1. */
  levelingOff: number | null;
  /** Where level-ups are announced; null announces in the channel the member was talking in. */
  levelChannelId: string | null;
}

/** One member's XP. The level is derived from it (see leveling/xp.ts). */
export interface MemberXp {
  userId: string;
  xp: number;
  messages: number;
  lastXpAt: number;
}

/** A message Ordis keeps at the bottom of a channel by deleting and reposting it after anyone else talks. */
export interface Sticky {
  channelId: string;
  guildId: string;
  title: string | null;
  content: string;
  /** The bot's current copy, so it can be deleted when the next one is posted. */
  messageId: string | null;
  /** Clean mode: everything other members post here is deleted, so the sticky is all that is ever in the channel. */
  deleteOthers: boolean;
  /** A picture shown under the text (an https URL). */
  imageUrl: string | null;
  createdBy: string;
  updatedAt: number;
}

export interface TempVoice {
  channelId: string;
  guildId: string;
  ownerId: string;
  createdAt: number;
}

/** GuildSettings field → guild_settings column. Adding a setting means a migration plus one line here. */
const SETTINGS_COLUMNS: [Exclude<keyof GuildSettings, 'guildId'>, string][] = [
  ['alertsChannelId', 'alerts_channel_id'],
  ['alertsRoleId', 'alerts_role_id'],
  ['announcementsChannelId', 'announcements_channel_id'],
  ['welcomeChannelId', 'welcome_channel_id'],
  ['chatChannelId', 'chat_channel_id'],
  ['modLogChannelId', 'mod_log_channel_id'],
  ['verifyChannelId', 'verify_channel_id'],
  ['verifyPanelMessageId', 'verify_panel_message_id'],
  ['verifyRoleId', 'verify_role_id'],
  ['verifyMinAccountAgeDays', 'verify_min_account_age_days'],
  ['honeypotChannelId', 'honeypot_channel_id'],
  ['honeypotAction', 'honeypot_action'],
  ['lfgVoiceCategoryId', 'lfg_voice_category_id'],
  ['lfgVoiceGraceMinutes', 'lfg_voice_grace_minutes'],
  ['autoVcHubChannelId', 'auto_vc_hub_channel_id'],
  ['ssRolesChannelId', 'ss_roles_channel_id'],
  ['levelingOff', 'leveling_off'],
  ['levelChannelId', 'level_channel_id'],
];
const NUMERIC_SETTINGS = new Set(['verifyMinAccountAgeDays', 'lfgVoiceGraceMinutes', 'levelingOff']);

export interface Warning {
  id: number;
  guildId: string;
  userId: string;
  moderatorId: string;
  reason: string;
  createdAt: number;
}

export interface StoredBackup {
  id: number;
  guildId: string;
  createdAt: number;
  label: string | null;
  auto: boolean;
  /** JSON of BackupSummary (counts and size), so listings don't load the full snapshot. */
  summary: string;
}

export interface PanelAdmin {
  userId: string;
  addedBy: string;
  addedAt: number;
  note: string | null;
}

export interface PanelSession {
  id: string;
  userId: string;
  username: string;
  avatar: string | null;
  csrf: string;
  expiresAt: number;
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
  /** The squad's auto-created voice channel, until it is deleted. */
  voiceChannelId: string | null;
  /** When the squad ends by itself (epoch ms), or null for no limit. */
  expiresAt: number | null;
  /** Since when the host has been out of the squad's voice channel; null while they are in it. */
  hostAbsentSince: number | null;
}

/** An activity people can run; carries the picture on its LFG posts and optional pings/channel. */
export interface Activity {
  name: string;
  imageUrl: string | null;
  roleId: string | null;
  channelId: string | null;
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
  `
  CREATE TABLE backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    label TEXT,
    auto INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX backups_guild ON backups (guild_id, created_at);
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN verify_channel_id TEXT;
  ALTER TABLE guild_settings ADD COLUMN verify_panel_message_id TEXT;
  ALTER TABLE guild_settings ADD COLUMN verify_role_id TEXT;
  ALTER TABLE guild_settings ADD COLUMN verify_min_account_age_days INTEGER;
  `,
  `
  CREATE TABLE panel_admins (
    user_id TEXT PRIMARY KEY,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    note TEXT
  );
  CREATE TABLE panel_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar TEXT,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN honeypot_channel_id TEXT;
  ALTER TABLE guild_settings ADD COLUMN honeypot_action TEXT;
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN lfg_voice_category_id TEXT;
  ALTER TABLE guild_settings ADD COLUMN lfg_voice_grace_minutes INTEGER;
  ALTER TABLE lfg_posts ADD COLUMN voice_channel_id TEXT;
  ALTER TABLE lfg_posts ADD COLUMN expires_at INTEGER;
  ALTER TABLE lfg_posts ADD COLUMN host_absent_since INTEGER;
  CREATE TABLE activities (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    image_url TEXT,
    role_id TEXT,
    channel_id TEXT
  );
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN auto_vc_hub_channel_id TEXT;
  CREATE TABLE temp_voice (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE guild_settings ADD COLUMN ss_roles_channel_id TEXT;
  CREATE TABLE ss_reference (
    guild_id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    image BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE ss_claims (
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    user_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, kind, key)
  );
  `,
  `
  -- Screenshots are never stored: the reference is a 256-byte thumbnail fingerprint of the clan emblem plus the clan's name line.
  DELETE FROM ss_reference;
  ALTER TABLE ss_reference ADD COLUMN fingerprint BLOB;
  ALTER TABLE ss_reference ADD COLUMN clan_text TEXT;
  `,
  `
  CREATE TABLE stickies (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    message_id TEXT,
    created_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  ALTER TABLE stickies ADD COLUMN delete_others INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE stickies ADD COLUMN image_url TEXT;
  `,
  `
  CREATE TABLE member_xp (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    messages INTEGER NOT NULL DEFAULT 0,
    last_xp_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX member_xp_rank ON member_xp (guild_id, xp DESC);
  CREATE TABLE xp_ignored_channels (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
  ALTER TABLE guild_settings ADD COLUMN leveling_off INTEGER;
  ALTER TABLE guild_settings ADD COLUMN level_channel_id TEXT;
  `,
];

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toSticky(r: Row): Sticky {
  return {
    channelId: String(r.channel_id),
    guildId: String(r.guild_id),
    title: str(r.title),
    content: String(r.content),
    messageId: str(r.message_id),
    deleteOthers: Number(r.delete_others) === 1,
    imageUrl: str(r.image_url),
    createdBy: String(r.created_by),
    updatedAt: Number(r.updated_at),
  };
}

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
    voiceChannelId: str(r.voice_channel_id),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    hostAbsentSince: r.host_absent_since === null || r.host_absent_since === undefined ? null : Number(r.host_absent_since),
  };
}

function toTempVoice(r: Row): TempVoice {
  return { channelId: String(r.channel_id), guildId: String(r.guild_id), ownerId: String(r.owner_id), createdAt: Number(r.created_at) };
}

function toActivity(r: Row): Activity {
  return { name: String(r.name), imageUrl: str(r.image_url), roleId: str(r.role_id), channelId: str(r.channel_id) };
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
    const values = SETTINGS_COLUMNS.map(([key, col]) => {
      const v = r?.[col];
      return [key, NUMERIC_SETTINGS.has(key) ? (v === null || v === undefined ? null : Number(v)) : str(v)];
    });
    return { guildId, ...Object.fromEntries(values) } as GuildSettings;
  }

  updateSettings(guildId: string, patch: Partial<Omit<GuildSettings, 'guildId'>>): GuildSettings {
    const next = { ...this.getSettings(guildId), ...patch };
    const cols = SETTINGS_COLUMNS.map(([, col]) => col);
    this.db
      .prepare(
        `INSERT INTO guild_settings (guild_id, ${cols.join(', ')})
         VALUES (?, ${cols.map(() => '?').join(', ')})
         ON CONFLICT (guild_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`,
      )
      .run(guildId, ...SETTINGS_COLUMNS.map(([key]) => next[key]));
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

  /** Squads that may need voice upkeep: open ones with a voice channel or expiry, and closed ones whose voice channel still exists. */
  lfgForSweep(): LfgPost[] {
    const rows = this.db
      .prepare('SELECT * FROM lfg_posts WHERE voice_channel_id IS NOT NULL OR (closed = 0 AND expires_at IS NOT NULL)')
      .all() as Row[];
    return rows.map(toLfg);
  }

  /** The host's open squad that has a voice channel, if any. */
  openVoiceLfgByHost(guildId: string, hostId: string): LfgPost | null {
    const r = this.db
      .prepare('SELECT * FROM lfg_posts WHERE guild_id = ? AND host_id = ? AND closed = 0 AND voice_channel_id IS NOT NULL')
      .get(guildId, hostId) as Row | undefined;
    return r ? toLfg(r) : null;
  }

  setLfgVoice(id: number, voiceChannelId: string | null, hostAbsentSince: number | null = null): void {
    this.db.prepare('UPDATE lfg_posts SET voice_channel_id = ?, host_absent_since = ? WHERE id = ?').run(voiceChannelId, hostAbsentSince, id);
  }

  setLfgHostAbsent(id: number, since: number | null): void {
    this.db.prepare('UPDATE lfg_posts SET host_absent_since = ? WHERE id = ?').run(since, id);
  }

  setLfgExpiry(id: number, expiresAt: number | null): void {
    this.db.prepare('UPDATE lfg_posts SET expires_at = ? WHERE id = ?').run(expiresAt, id);
  }

  // --- leveling ---

  private toXp(r: Row): MemberXp {
    return { userId: String(r.user_id), xp: Number(r.xp), messages: Number(r.messages), lastXpAt: Number(r.last_xp_at) };
  }

  getMemberXp(guildId: string, userId: string): MemberXp | null {
    const r = this.db.prepare('SELECT * FROM member_xp WHERE guild_id = ? AND user_id = ?').get(guildId, userId) as Row | undefined;
    return r ? this.toXp(r) : null;
  }

  /** Adds XP (never below 0) and returns the total before and after. `countMessage` is false for voice XP. */
  addXp(guildId: string, userId: string, amount: number, now: number, countMessage = true): { before: number; after: number } {
    const existing = this.getMemberXp(guildId, userId);
    const before = existing?.xp ?? 0;
    const after = Math.max(0, before + amount);
    // Voice XP must not restart the message cooldown.
    const stamp = countMessage ? now : (existing?.lastXpAt ?? 0);
    this.db
      .prepare(
        `INSERT INTO member_xp (guild_id, user_id, xp, messages, last_xp_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp, messages = messages + ?, last_xp_at = excluded.last_xp_at`,
      )
      .run(guildId, userId, after, countMessage ? 1 : 0, stamp, countMessage ? 1 : 0);
    return { before, after };
  }

  setXp(guildId: string, userId: string, xp: number): void {
    this.db
      .prepare('INSERT INTO member_xp (guild_id, user_id, xp) VALUES (?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = excluded.xp')
      .run(guildId, userId, Math.max(0, xp));
  }

  resetXp(guildId: string, userId: string): boolean {
    return Number(this.db.prepare('DELETE FROM member_xp WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes) > 0;
  }

  /** 1-based position of a member by XP (ties share the better position). */
  xpPosition(guildId: string, userId: string): number | null {
    const mine = this.getMemberXp(guildId, userId);
    if (!mine) return null;
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM member_xp WHERE guild_id = ? AND xp > ?').get(guildId, mine.xp) as Row;
    return Number(r.n) + 1;
  }

  topXp(guildId: string, limit: number, offset = 0): MemberXp[] {
    return (this.db.prepare('SELECT * FROM member_xp WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id LIMIT ? OFFSET ?').all(guildId, limit, offset) as Row[]).map((r) => this.toXp(r));
  }

  countXpMembers(guildId: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM member_xp WHERE guild_id = ? AND xp > 0').get(guildId) as Row).n);
  }

  /** Turns XP gain off in a channel (or back on). Returns the new state: true = ignored. */
  toggleXpIgnored(guildId: string, channelId: string): boolean {
    const had = Number(this.db.prepare('DELETE FROM xp_ignored_channels WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId).changes) > 0;
    if (!had) this.db.prepare('INSERT INTO xp_ignored_channels (guild_id, channel_id) VALUES (?, ?)').run(guildId, channelId);
    return !had;
  }

  xpIgnoredChannels(guildId: string): string[] {
    return (this.db.prepare('SELECT channel_id FROM xp_ignored_channels WHERE guild_id = ?').all(guildId) as Row[]).map((r) => String(r.channel_id));
  }

  // --- join-to-create voice rooms ---

  // --- sticky messages ---

  setSticky(s: Omit<Sticky, 'messageId' | 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO stickies (channel_id, guild_id, title, content, message_id, created_by, updated_at, delete_others, image_url) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT (channel_id) DO UPDATE SET title = excluded.title, content = excluded.content, created_by = excluded.created_by, updated_at = excluded.updated_at, delete_others = excluded.delete_others, image_url = excluded.image_url`,
      )
      .run(s.channelId, s.guildId, s.title, s.content, s.createdBy, Date.now(), s.deleteOthers ? 1 : 0, s.imageUrl);
  }

  getSticky(channelId: string): Sticky | null {
    const r = this.db.prepare('SELECT * FROM stickies WHERE channel_id = ?').get(channelId) as Row | undefined;
    return r ? toSticky(r) : null;
  }

  listStickies(guildId: string): Sticky[] {
    return (this.db.prepare('SELECT * FROM stickies WHERE guild_id = ? ORDER BY updated_at').all(guildId) as Row[]).map(toSticky);
  }

  setStickyMessage(channelId: string, messageId: string | null): void {
    this.db.prepare('UPDATE stickies SET message_id = ? WHERE channel_id = ?').run(messageId, channelId);
  }

  removeSticky(channelId: string): boolean {
    return Number(this.db.prepare('DELETE FROM stickies WHERE channel_id = ?').run(channelId).changes) > 0;
  }

  // --- screenshot roles ---

  /** What a genuine clan card looks like: the emblem as a tiny grayscale fingerprint and the clan name line ("Name#043"). No image is kept. */
  setSsReference(guildId: string, fingerprint: Uint8Array, clanText: string): void {
    this.db
      .prepare("INSERT INTO ss_reference (guild_id, mime, image, updated_at, fingerprint, clan_text) VALUES (?, '', x'', ?, ?, ?) ON CONFLICT (guild_id) DO UPDATE SET fingerprint = excluded.fingerprint, clan_text = excluded.clan_text, updated_at = excluded.updated_at")
      .run(guildId, Date.now(), fingerprint, clanText);
  }

  getSsReference(guildId: string): { fingerprint: Uint8Array; clanText: string } | null {
    const r = this.db.prepare('SELECT fingerprint, clan_text FROM ss_reference WHERE guild_id = ?').get(guildId) as Row | undefined;
    return r?.fingerprint && r.clan_text ? { fingerprint: new Uint8Array(r.fingerprint as Uint8Array), clanText: String(r.clan_text) } : null;
  }

  /**
   * Binds something a screenshot proves (its in-game name, or the image itself) to the member who used it first.
   * Returns the other member's id when it already belongs to someone else, otherwise null (and keeps the claim).
   */
  claimSs(guildId: string, kind: 'ign' | 'image' | 'points', key: string, userId: string): string | null {
    const r = this.db.prepare('SELECT user_id FROM ss_claims WHERE guild_id = ? AND kind = ? AND key = ?').get(guildId, kind, key) as Row | undefined;
    if (r) return String(r.user_id) === userId ? null : String(r.user_id);
    this.db.prepare('INSERT INTO ss_claims (guild_id, kind, key, user_id, claimed_at) VALUES (?, ?, ?, ?, ?)').run(guildId, kind, key, userId, Date.now());
    return null;
  }

  addTempVoice(v: TempVoice): void {
    this.db
      .prepare('INSERT OR REPLACE INTO temp_voice (channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .run(v.channelId, v.guildId, v.ownerId, v.createdAt);
  }

  getTempVoice(channelId: string): TempVoice | null {
    const r = this.db.prepare('SELECT * FROM temp_voice WHERE channel_id = ?').get(channelId) as Row | undefined;
    return r ? toTempVoice(r) : null;
  }

  tempVoiceByOwner(guildId: string, ownerId: string): TempVoice | null {
    const r = this.db.prepare('SELECT * FROM temp_voice WHERE guild_id = ? AND owner_id = ?').get(guildId, ownerId) as Row | undefined;
    return r ? toTempVoice(r) : null;
  }

  listTempVoice(): TempVoice[] {
    return (this.db.prepare('SELECT * FROM temp_voice').all() as Row[]).map(toTempVoice);
  }

  removeTempVoice(channelId: string): void {
    this.db.prepare('DELETE FROM temp_voice WHERE channel_id = ?').run(channelId);
  }

  // --- activities ---

  listActivities(): Activity[] {
    return (this.db.prepare('SELECT * FROM activities ORDER BY name COLLATE NOCASE').all() as Row[]).map(toActivity);
  }

  getActivity(name: string): Activity | null {
    const r = this.db.prepare('SELECT * FROM activities WHERE name = ?').get(name) as Row | undefined;
    return r ? toActivity(r) : null;
  }

  /** Creates or replaces an activity (names are case-insensitive); `replacesName` renames an existing one. */
  saveActivity(a: Activity, replacesName?: string): void {
    if (replacesName && replacesName.toLowerCase() !== a.name.toLowerCase()) this.removeActivity(replacesName);
    this.db
      .prepare(
        'INSERT INTO activities (name, image_url, role_id, channel_id) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET name = excluded.name, image_url = excluded.image_url, role_id = excluded.role_id, channel_id = excluded.channel_id',
      )
      .run(a.name, a.imageUrl, a.roleId, a.channelId);
  }

  removeActivity(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM activities WHERE name = ?').run(name).changes) > 0;
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

  listAllWarnings(guildId: string): Warning[] {
    const rows = this.db.prepare('SELECT * FROM warnings WHERE guild_id = ? ORDER BY created_at DESC').all(guildId) as Row[];
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

  // --- server backups ---

  saveBackup(b: { guildId: string; label: string | null; auto: boolean; summary: string; data: string; createdAt?: number }): StoredBackup {
    const res = this.db
      .prepare('INSERT INTO backups (guild_id, created_at, label, auto, summary, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.guildId, b.createdAt ?? Date.now(), b.label, b.auto ? 1 : 0, b.summary, b.data);
    return this.listBackups(b.guildId).find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  /** Newest first, without the snapshot data. */
  listBackups(guildId: string): StoredBackup[] {
    const rows = this.db
      .prepare('SELECT id, guild_id, created_at, label, auto, summary FROM backups WHERE guild_id = ? ORDER BY created_at DESC, id DESC')
      .all(guildId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      guildId: String(r.guild_id),
      createdAt: Number(r.created_at),
      label: str(r.label),
      auto: Boolean(r.auto),
      summary: String(r.summary),
    }));
  }

  getBackupData(guildId: string, id: number): string | null {
    const r = this.db.prepare('SELECT data FROM backups WHERE guild_id = ? AND id = ?').get(guildId, id) as Row | undefined;
    return r ? String(r.data) : null;
  }

  deleteBackup(guildId: string, id: number): boolean {
    return this.db.prepare('DELETE FROM backups WHERE guild_id = ? AND id = ?').run(guildId, id).changes > 0;
  }

  /** Keeps the newest `keep` automatic backups; manual ones are never pruned. */
  pruneAutoBackups(guildId: string, keep: number): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM backups WHERE guild_id = ? AND auto = 1 AND id NOT IN (
             SELECT id FROM backups WHERE guild_id = ? AND auto = 1 ORDER BY created_at DESC, id DESC LIMIT ?
           )`,
        )
        .run(guildId, guildId, keep).changes,
    );
  }

  // --- web admin panel ---

  listPanelAdmins(): PanelAdmin[] {
    const rows = this.db.prepare('SELECT * FROM panel_admins ORDER BY added_at').all() as Row[];
    return rows.map((r) => ({ userId: String(r.user_id), addedBy: String(r.added_by), addedAt: Number(r.added_at), note: str(r.note) }));
  }

  isPanelAdmin(userId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM panel_admins WHERE user_id = ?').get(userId));
  }

  addPanelAdmin(userId: string, addedBy: string, note: string | null): void {
    this.db.prepare('INSERT OR IGNORE INTO panel_admins (user_id, added_by, added_at, note) VALUES (?, ?, ?, ?)').run(userId, addedBy, Date.now(), note);
  }

  /** Removes an admin and signs them out everywhere. */
  removePanelAdmin(userId: string): boolean {
    this.db.prepare('DELETE FROM panel_sessions WHERE user_id = ?').run(userId);
    return this.db.prepare('DELETE FROM panel_admins WHERE user_id = ?').run(userId).changes > 0;
  }

  createPanelSession(s: Omit<PanelSession, 'expiresAt'>, ttlMs: number): PanelSession {
    const now = Date.now();
    this.db.prepare('DELETE FROM panel_sessions WHERE expires_at < ?').run(now);
    this.db
      .prepare('INSERT INTO panel_sessions (id, user_id, username, avatar, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.userId, s.username, s.avatar, s.csrf, now, now + ttlMs);
    return { ...s, expiresAt: now + ttlMs };
  }

  getPanelSession(id: string, now = Date.now()): PanelSession | null {
    const r = this.db.prepare('SELECT * FROM panel_sessions WHERE id = ? AND expires_at > ?').get(id, now) as Row | undefined;
    return r ? { id: String(r.id), userId: String(r.user_id), username: String(r.username), avatar: str(r.avatar), csrf: String(r.csrf), expiresAt: Number(r.expires_at) } : null;
  }

  deletePanelSession(id: string): void {
    this.db.prepare('DELETE FROM panel_sessions WHERE id = ?').run(id);
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
