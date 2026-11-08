import type { ContainerBuilder } from 'discord.js';
import type { AppContext } from '../../context.js';
import type { GuildSettings } from '../../db.js';
import { getSendableChannel } from '../../services/clan.js';
import type { ArbitrationData, ArbitrationView } from '../../warframe/arbitrations.js';
import { type WorldState, worldStateStaleNote } from '../../warframe/worldstate.js';
import { type BoardChannel, type NoteChannel, boardMessageIds, clearBoard, expireNote, postNote, syncBoard } from '../board.js';
import { alertBoard, alertPings } from './alerts.js';
import { arbitrationBoard, arbitrationPings } from './arbitrations.js';
import { cycleBoard } from './cycles.js';
import { fissureBoard } from './fissures.js';
import { invasionBoard, invasionPings } from './invasions.js';
import { messageStats } from './parts.js';
import { sortieBoard } from './sortie.js';
import { traderBoard, traderPings } from './traders.js';
import type { FeedId, FeedInput, FeedPing } from './types.js';

/**
 * The World State channels: one board per channel (discord/board.ts keeps its messages current), drawn from one snapshot of the
 * world state and the Arbitration schedule per round. A feed with a role pings it for what is new (a notable alert or invasion, an
 * S or A tier Arbitration, Baro's arrival) with one short note under its board, which the next note replaces.
 *
 * The first round of a feed in a channel only records what is there, so a new channel isn't a wall of pings. Moving a feed to
 * another channel, or switching it off, removes its board from the old one.
 */

type ChannelKey = 'alertsChannelId' | 'arbitrationsChannelId' | 'fissuresChannelId' | 'sortieChannelId' | 'cyclesChannelId' | 'tradersChannelId' | 'invasionsChannelId';
type RoleKey = 'alertsRoleId' | 'arbitrationsRoleId' | 'baroRoleId';

export interface FeedDef {
  id: FeedId;
  /** What the channel shows, for /setup and the panel. */
  label: string;
  channel: ChannelKey;
  /** The role its pings mention; without one the feed only keeps its board. */
  role: RoleKey | null;
  /** Bump when the layout changes, so every board of this feed is redrawn once. */
  version: string;
  /** False for the one board that is drawn without the world state (the Arbitration schedule is its own source). */
  needsWorldState: boolean;
  render(input: FeedInput): ContainerBuilder[][];
  pings?(input: FeedInput): FeedPing[];
}

export const FEEDS: readonly FeedDef[] = [
  { id: 'alerts', label: 'Alerts, events and Nightwave', channel: 'alertsChannelId', role: 'alertsRoleId', version: '1', needsWorldState: true, render: alertBoard, pings: alertPings },
  { id: 'arbitrations', label: 'Arbitrations (schedule and tiers)', channel: 'arbitrationsChannelId', role: 'arbitrationsRoleId', version: '1', needsWorldState: false, render: arbitrationBoard, pings: arbitrationPings },
  { id: 'fissures', label: 'Void fissures', channel: 'fissuresChannelId', role: null, version: '1', needsWorldState: true, render: fissureBoard },
  { id: 'sortie', label: 'Sortie, Archon Hunt and Archimedea', channel: 'sortieChannelId', role: null, version: '1', needsWorldState: true, render: sortieBoard },
  { id: 'cycles', label: 'Open world cycles, Duviri and bounties', channel: 'cyclesChannelId', role: null, version: '1', needsWorldState: true, render: cycleBoard },
  { id: 'traders', label: "Baro, Darvo, Varzia and Teshin", channel: 'tradersChannelId', role: 'baroRoleId', version: '1', needsWorldState: true, render: (i) => traderBoard(i), pings: traderPings },
  { id: 'invasions', label: 'Invasions', channel: 'invasionsChannelId', role: 'alertsRoleId', version: '1', needsWorldState: true, render: invasionBoard, pings: invasionPings },
];

export const feedDef = (id: string): FeedDef | undefined => FEEDS.find((f) => f.id === id);

/** The feed whose channel this is, if any (a channel holds one board). */
export const feedOfChannel = (settings: GuildSettings, channelId: string): FeedDef | undefined => FEEDS.find((f) => settings[f.channel] === channelId);

export interface FeedHealth {
  channelId: string | null;
  at: number | null;
  action: string | null;
  error: string | null;
  /** The longest message's text and component count (Discord: 4000 and 40). */
  maxText: number;
  maxComponents: number;
  pinged: number;
}

const health = new Map<FeedId, FeedHealth>();

/** What each board did last round, for get_bot_health. */
export const feedHealth = (): Record<string, FeedHealth> => Object.fromEntries(FEEDS.map((f) => [f.id, health.get(f.id) ?? { channelId: null, at: null, action: null, error: null, maxText: 0, maxComponents: 0, pinged: 0 }]));

/**
 * What each board message shows (message id → its components). A pick in a board's menu stays shown in that member's menu until the
 * message is edited, so the answer redraws the message as it is (handlers.ts) without waiting for the next round.
 */
const shown = new Map<string, ContainerBuilder[]>();
const shownIds = new Map<FeedId, string[]>();
export const shownComponents = (messageId: string): ContainerBuilder[] | null => shown.get(messageId) ?? null;
function forgetShown(id: FeedId): void {
  for (const messageId of shownIds.get(id) ?? []) shown.delete(messageId);
  shownIds.delete(id);
}

const channelMeta = (id: FeedId) => `feed_channel:${id}`;
const seededMeta = (id: FeedId) => `feed_seeded:${id}`;
const boardId = (id: FeedId) => `feed:${id}`;
/** The longest a note says: what is new, a line each. */
const NOTE_LIMIT = 1800;

/** Builds what every board of this round is drawn from. */
export function feedInput(ctx: AppContext, round: { ws: WorldState | null; arbyData: ArbitrationData | null; arby: ArbitrationView; now: number }): FeedInput {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  return {
    now: round.now,
    ws: round.ws,
    arby: round.arby,
    arbyData: round.arbyData,
    stale: round.ws ? worldStateStaleNote(round.now) !== null : false,
    settings: ctx.store.getSettings(guildId),
    selfRoles: new Set(ctx.store.listSelfRoles(guildId).map((r) => r.roleId)),
  };
}

/** The old single summary of the alerts channel and its note, removed once when the boards take over. */
async function removeOldSummary(ctx: AppContext, channel: BoardChannel): Promise<void> {
  for (const key of [`alerts_summary:${channel.id}`, `alerts_note:${channel.id}`]) {
    const raw = ctx.store.getMeta(key);
    if (!raw) continue;
    try {
      const id = (JSON.parse(raw) as { messageId?: unknown }).messageId;
      if (typeof id === 'string') await channel.messages.delete(id).catch(() => {});
    } catch {
      // Unreadable: nothing to delete.
    }
    ctx.store.setMeta(key, '');
  }
}

/** One round: every board brought up to date, and the pings of what is new. `wsFailed`: the world state could not be read. */
export async function syncFeeds(ctx: AppContext, input: FeedInput, opts: { wsFailed?: boolean } = {}): Promise<void> {
  for (const def of FEEDS) {
    const channelId = input.settings[def.channel];
    const h: FeedHealth = { channelId, at: input.now, action: null, error: null, maxText: 0, maxComponents: 0, pinged: 0 };
    try {
      // A feed that moved or was switched off: its board leaves the old channel.
      const previous = ctx.store.getMeta(channelMeta(def.id)) || null;
      if (previous && previous !== channelId) {
        const old = await getSendableChannel(ctx, previous).catch(() => null);
        if (old) {
          await clearBoard(ctx, old as unknown as BoardChannel, boardId(def.id));
          await expireNote(ctx, old as unknown as NoteChannel, Infinity);
        }
        forgetShown(def.id);
        ctx.store.setMeta(seededMeta(def.id), '');
      }
      if (previous !== channelId) ctx.store.setMeta(channelMeta(def.id), channelId ?? '');
      if (!channelId) {
        health.set(def.id, h);
        continue;
      }
      // A read that failed (nothing cached either) leaves the boards as they are rather than blanking them.
      if (def.needsWorldState && !input.ws && opts.wsFailed) {
        health.set(def.id, { ...h, action: 'skipped' });
        continue;
      }

      const channel = (await getSendableChannel(ctx, channelId)) as unknown as BoardChannel & NoteChannel;
      if (def.id === 'alerts') await removeOldSummary(ctx, channel);

      // What is new this round. Everything is remembered even without a role, so a role set later doesn't ping old news.
      const seeded = ctx.store.getMeta(seededMeta(def.id)) === channelId;
      const pings = def.pings?.(input) ?? [];
      const fresh = pings.filter((p) => ctx.store.markSeen(`ping:${def.id}:${p.key}`));
      if (!seeded) ctx.store.setMeta(seededMeta(def.id), channelId);
      const announce = seeded ? fresh : [];

      const messages = def.render(input);
      for (const m of messages) {
        const s = messageStats(m);
        h.maxText = Math.max(h.maxText, s.text);
        h.maxComponents = Math.max(h.maxComponents, s.components);
      }
      // The board shows the news before anyone is pinged for it.
      const result = await syncBoard(ctx, channel, boardId(def.id), () => messages, { force: announce.length > 0 || !seeded, now: input.now, version: def.version });
      h.action = result.action;
      // A board that is waiting to be edited still shows the last version, so that is what a menu answer redraws.
      if (result.action !== 'waiting') {
        forgetShown(def.id);
        const ids = boardMessageIds(ctx, boardId(def.id), channelId);
        ids.forEach((id, i) => messages[i] && shown.set(id, messages[i]));
        shownIds.set(def.id, ids);
      }

      const roleId = def.role ? input.settings[def.role] : null;
      if (announce.length && roleId) {
        let text = '';
        for (const p of announce) {
          if (text.length + p.text.length + 1 > NOTE_LIMIT) break;
          text += (text ? '\n' : '') + p.text;
        }
        await postNote(ctx, channel, text, roleId, Math.max(...announce.map((p) => p.until)));
        h.pinged = announce.length;
      } else await expireNote(ctx, channel, roleId ? input.now : Infinity);
    } catch (err) {
      h.error = err instanceof Error ? err.message : String(err);
      console.error(`[feeds] the ${def.id} board in ${channelId} failed:`, err);
    }
    health.set(def.id, h);
  }
}
