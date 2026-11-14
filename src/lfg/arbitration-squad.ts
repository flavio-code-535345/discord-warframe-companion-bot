import type { AppContext } from '../context.js';
import type { LfgPost, Store } from '../db.js';
import { UserError } from '../errors.js';
import { discordTime } from '../time.js';
import { type ArbitrationSlot, type ArbitrationView, arbitrationView, lastArbitrations } from '../warframe/arbitrations.js';
import { getWorldState, worldStateEnabled } from '../warframe/worldstate.js';
import { createSquad, joinSquad } from './squads.js';

/**
 * "Squad up" on the Arbitration board (`feeds:squad`): one tap and the member is in a squad for the Arbitration, with its voice
 * channel when squad voice is set up. The first tap of an hour starts the squad (through `createSquad`, like `/lfg`), the next ones
 * join it; a full or closed squad makes room for a new one. The squad ends with the Arbitration.
 */

/** The activity the squads are posted as: the one `/lfg` suggests, so its picture, its channel and the DMs for it apply. */
export const ARBITRATION_ACTIVITY = 'Arbitrations';
/** With less than this left of the hour, a squad is for the next Arbitration. */
export const TOO_LATE_MS = 15 * 60_000;
const META = 'arby_squads';
/** A squad is remembered this long after its Arbitration started. */
const REMEMBER_MS = 3 * 3_600_000;

/** Which Arbitration a squad started now is for (pure): the one running, or the next when this one is nearly over. */
export function squadSlot(view: Pick<ArbitrationView, 'current' | 'upcoming' | 'scheduleTrusted'>, now: number): ArbitrationSlot | null {
  const current = view.current && view.current.end > now ? view.current : null;
  const next = view.scheduleTrusted ? (view.upcoming.find((s) => s.start > now) ?? null) : null;
  if (current && current.end - now >= TOO_LATE_MS) return current;
  return next ?? current;
}

/** "S tier · Casta, Ceres · Defense · Grineer", then when it starts or ends. */
export function slotDetails(slot: ArbitrationSlot, now: number): string {
  const where = [`${slot.name}${slot.planet ? `, ${slot.planet}` : ''}`, slot.mission, slot.faction].filter(Boolean).join(' · ');
  const when = slot.start > now ? `starts ${discordTime(slot.start)}` : `ends ${discordTime(slot.end)}`;
  // A slot from the world state alone has no node key and so no real tier.
  return `${slot.nodeKey ? `${slot.tier} tier · ` : ''}${where} · ${when}`;
}

interface Remembered {
  start: number;
  postId: number;
}

function remembered(store: Store): Remembered[] {
  try {
    const list = JSON.parse(store.getMeta(META) ?? '[]') as unknown;
    return Array.isArray(list) ? list.filter((r): r is Remembered => Boolean(r) && typeof (r as Remembered).start === 'number' && typeof (r as Remembered).postId === 'number') : [];
  } catch {
    return [];
  }
}

/** The open squad of an Arbitration hour, if the board started one. */
function squadOf(ctx: AppContext, slot: ArbitrationSlot): LfgPost | null {
  const entry = remembered(ctx.store).find((r) => r.start === slot.start);
  const post = entry ? ctx.store.getLfg(entry.postId) : null;
  return post && !post.closed && post.guildId === ctx.config.DISCORD_GUILD_ID ? post : null;
}

function remember(store: Store, slot: ArbitrationSlot, postId: number, now: number): void {
  const kept = remembered(store).filter((r) => r.start !== slot.start && r.start > now - REMEMBER_MS);
  store.setMeta(META, JSON.stringify([...kept, { start: slot.start, postId }]));
}

export interface SquadUp {
  kind: 'created' | 'joined' | 'already';
  post: LfgPost;
  slot: ArbitrationSlot;
  url: string;
  /** True when this join filled the squad. */
  full: boolean;
}

const urlOf = (post: LfgPost): string => `https://discord.com/channels/${post.guildId}/${post.channelId}/${post.messageId ?? ''}`;

async function squadUp(ctx: AppContext, member: { id: string; name: string }, opts: { now?: number; view?: ArbitrationView }): Promise<SquadUp> {
  const now = opts.now ?? Date.now();
  const view = opts.view ?? arbitrationView(lastArbitrations(), worldStateEnabled() ? await getWorldState().catch(() => null) : null, now, { hours: 3, bestDays: 0 });
  const slot = squadSlot(view, now);
  if (!slot) throw new UserError('No Arbitration is known right now, so there is nothing to squad up for. Try again in a few minutes.');

  const open = squadOf(ctx, slot);
  if (open) {
    const members = ctx.store.lfgMembers(open.id);
    if (members.includes(member.id)) return { kind: 'already', post: open, slot, url: urlOf(open), full: members.length >= open.size };
    if (members.length < open.size) {
      const joined = await joinSquad(ctx, open.id, member.id);
      return { kind: 'joined', post: joined.post, slot, url: urlOf(joined.post), full: joined.full };
    }
    // Full: this member starts the next squad for the same hour.
  }
  const squad = await createSquad(ctx, { hostId: member.id, hostName: member.name, activity: ARBITRATION_ACTIVITY, details: slotDetails(slot, now), size: 4, expiresAt: slot.end });
  remember(ctx.store, slot, squad.post.id, now);
  return { kind: 'created', post: squad.post, slot, url: squad.url, full: false };
}

/** One tap at a time: two members tapping in the same second get one squad, not two. */
let line: Promise<unknown> = Promise.resolve();

export function squadUpForArbitration(ctx: AppContext, member: { id: string; name: string }, opts: { now?: number; view?: ArbitrationView } = {}): Promise<SquadUp> {
  const run = line.then(() => squadUp(ctx, member, opts));
  line = run.catch(() => {});
  return run;
}
