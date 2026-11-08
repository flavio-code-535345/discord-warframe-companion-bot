import { createHash } from 'node:crypto';
import { type ActionRowBuilder, type ContainerBuilder, MessageFlags, type MessageActionRowComponentBuilder } from 'discord.js';
import type { AppContext } from '../context.js';

/**
 * A board is the set of messages Ordis keeps current in one channel (the World State channels): Components V2 messages, each a
 * container of text, separators and buttons. A message is edited only when what it says changed (and not more often than
 * `minEditMs` unless forced, e.g. when something new appeared), a message someone deleted is posted again (with the rest of the
 * board, so the order stays), and the ids and fingerprints live in bot_meta, so a restart or deploy continues with the same messages.
 *
 * `render(stamp)` builds the messages; `stamp` is the time the board says it was updated (0 when only the fingerprint is wanted),
 * so the "updated" line never makes an unchanged board look changed.
 */

export type BoardComponent = ContainerBuilder | ActionRowBuilder<MessageActionRowComponentBuilder>;
export type BoardRender = (stamp: number) => BoardComponent[][];

/** The little of a text channel a board needs, so it can be tested without Discord. */
export interface BoardChannel {
  id: string;
  guildId: string;
  send(payload: { components: BoardComponent[]; flags: MessageFlags.IsComponentsV2; allowedMentions: { parse: [] } }): Promise<{ id: string }>;
  messages: {
    edit(messageId: string, payload: { components: BoardComponent[]; flags: MessageFlags.IsComponentsV2; allowedMentions: { parse: [] } }): Promise<unknown>;
    delete(messageId: string): Promise<unknown>;
    fetch(messageId: string): Promise<unknown>;
  };
}

interface BoardRecord {
  ids: string[];
  hashes: string[];
  /** When the board was last edited or posted. */
  at: number;
  /** When its messages were last seen to exist. */
  checked: number;
}

/** An unchanged board is not edited, so every so often it is checked that its messages are still there. */
export const BOARD_VERIFY_MS = 10 * 60_000;
/** The default pace: a changed board is edited at most this often unless forced. */
export const BOARD_MIN_EDIT_MS = 2 * 60_000;

export const boardKey = (boardId: string, channelId: string) => `board:${boardId}:${channelId}`;

function readRecord(raw: string | null): BoardRecord | null {
  try {
    const r = JSON.parse(raw || 'null') as Partial<BoardRecord> | null;
    if (!r || !Array.isArray(r.ids) || !Array.isArray(r.hashes) || r.ids.length !== r.hashes.length) return null;
    return { ids: r.ids.map(String), hashes: r.hashes.map(String), at: Number(r.at) || 0, checked: Number(r.checked) || Number(r.at) || 0 };
  } catch {
    return null;
  }
}

export const fingerprint = (components: BoardComponent[]): string => createHash('sha1').update(JSON.stringify(components.map((c) => c.toJSON()))).digest('hex');

/** 10008: the message is gone (someone deleted it). Anything else (no permission, Discord down) is for the caller. */
const isGone = (err: unknown) => (err as { code?: number }).code === 10008;

export interface BoardResult {
  /** Link to the first message of the board. */
  url: string;
  /** What happened this round. */
  action: 'unchanged' | 'waiting' | 'edited' | 'posted';
}

/**
 * Brings the board up to date. `version` is part of the fingerprint: bump it when the layout changes so every board is redrawn once.
 * Returns a link to its first message.
 */
export async function syncBoard(
  ctx: Pick<AppContext, 'store'>,
  channel: BoardChannel,
  boardId: string,
  render: BoardRender,
  opts: { force?: boolean; now?: number; minEditMs?: number; version?: string } = {},
): Promise<BoardResult> {
  const now = opts.now ?? Date.now();
  const key = boardKey(boardId, channel.id);
  const link = (id: string) => `https://discord.com/channels/${channel.guildId}/${channel.id}/${id}`;
  const v = opts.version ?? '1';
  const hashes = render(0).map((m) => `${fingerprint(m)}:${v}`);
  const saved = readRecord(ctx.store.getMeta(key));
  const save = (r: BoardRecord) => ctx.store.setMeta(key, JSON.stringify(r));
  const payload = (components: BoardComponent[]) => ({ components, flags: MessageFlags.IsComponentsV2 as const, allowedMentions: { parse: [] as [] } });

  let missing = !saved || saved.ids.length !== hashes.length;
  const same = !missing && saved!.hashes.every((h, i) => h === hashes[i]);

  if (saved && !missing && same) {
    if (now - saved.checked < BOARD_VERIFY_MS) return { url: link(saved.ids[0]!), action: 'unchanged' };
    for (const id of saved.ids) {
      try {
        await channel.messages.fetch(id);
      } catch (err) {
        if (!isGone(err)) throw err;
        missing = true;
        break;
      }
    }
    if (!missing) {
      save({ ...saved, checked: now });
      return { url: link(saved.ids[0]!), action: 'unchanged' };
    }
  }

  if (saved && !missing && !opts.force && now - saved.at < (opts.minEditMs ?? BOARD_MIN_EDIT_MS)) {
    return { url: link(saved.ids[0]!), action: 'waiting' };
  }

  const messages = render(now);
  if (saved && !missing) {
    try {
      const last = messages.length - 1;
      for (const [i, components] of messages.entries()) {
        // A changed message is edited; the last one also carries the "updated" time, so it is edited whenever anything changed.
        if (saved.hashes[i] === hashes[i] && i !== last) continue;
        await channel.messages.edit(saved.ids[i]!, payload(components));
      }
      save({ ids: saved.ids, hashes, at: now, checked: now });
      return { url: link(saved.ids[0]!), action: 'edited' };
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  }

  // Posted fresh, all of it, so the messages stay in order; what is left of the old board goes.
  for (const id of saved?.ids ?? []) await channel.messages.delete(id).catch(() => {});
  const ids: string[] = [];
  for (const components of messages) ids.push((await channel.send(payload(components))).id);
  save({ ids, hashes, at: now, checked: now });
  return { url: link(ids[0]!), action: 'posted' };
}

/** Removes a board's messages and forgets it (its channel was switched off or moved). */
export async function clearBoard(ctx: Pick<AppContext, 'store'>, channel: Pick<BoardChannel, 'id' | 'messages'>, boardId: string): Promise<void> {
  const key = boardKey(boardId, channel.id);
  const saved = readRecord(ctx.store.getMeta(key));
  for (const id of saved?.ids ?? []) await channel.messages.delete(id).catch(() => {});
  ctx.store.setMeta(key, '');
}

/**
 * A ping note: the one short plain message under a board that pings a role (an edit can't ping anyone). The next note replaces it and
 * it is removed after its time, so a board channel holds the board plus at most one note. Kept in bot_meta `note:<channelId>`.
 */
export interface NoteChannel {
  id: string;
  send(payload: { content: string; allowedMentions: { roles: string[] } }): Promise<{ id: string }>;
  messages: { delete(messageId: string): Promise<unknown> };
}

export const noteKey = (channelId: string) => `note:${channelId}`;

function readNote(raw: string | null): { messageId: string; until: number } | null {
  try {
    const r = JSON.parse(raw || 'null') as { messageId?: unknown; until?: unknown } | null;
    return r && typeof r.messageId === 'string' ? { messageId: r.messageId, until: Number(r.until) || 0 } : null;
  } catch {
    return null;
  }
}

/** Posts a note that pings `roleId` and lives until `until`; the previous note of the channel goes. */
export async function postNote(ctx: Pick<AppContext, 'store'>, channel: NoteChannel, content: string, roleId: string, until: number): Promise<void> {
  const previous = readNote(ctx.store.getMeta(noteKey(channel.id)));
  const sent = await channel.send({ content: `<@&${roleId}> ${content}`, allowedMentions: { roles: [roleId] } });
  ctx.store.setMeta(noteKey(channel.id), JSON.stringify({ messageId: sent.id, until }));
  if (previous) await channel.messages.delete(previous.messageId).catch(() => {});
}

/** Removes the channel's note once its time is over, or at once with `now: Infinity` (the role was unset). */
export async function expireNote(ctx: Pick<AppContext, 'store'>, channel: Pick<NoteChannel, 'id' | 'messages'>, now = Date.now()): Promise<void> {
  const saved = readNote(ctx.store.getMeta(noteKey(channel.id)));
  if (!saved || now < saved.until) return;
  await channel.messages.delete(saved.messageId).catch(() => {});
  ctx.store.setMeta(noteKey(channel.id), '');
}
