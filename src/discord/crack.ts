import type { ContainerBuilder } from 'discord.js';
import { relicsOf, sharesRelics } from '../alecaframe/access.js';
import { type CrackRelic, type CrackTier, DEFAULT_CRACK_PLAT, DEFAULT_CRACK_QUIET_HOURS, crackPlan } from '../alecaframe/crack.js';
import type { AppContext } from '../context.js';
import type { Store } from '../db.js';
import { withTimeout } from '../timeout.js';
import { type TrackerSpec, parseSpec } from '../trackers.js';
import { quickFissures } from '../warframe/fissures.js';
import { type RelicBook, loadRelicBook } from '../warframe/relics.js';
import type { WorldState } from '../warframe/worldstate.js';
import { sendDm } from './dm.js';
import { e, tierEmoji } from './emoji.js';
import { DIVIDER, type Part, card, section } from './feeds/parts.js';
import { brandIcon } from './identity.js';
import { platText } from './lookup-embeds.js';
import { fissureLine } from './now.js';
import { COLORS } from './style.js';

/**
 * "Crack now": for a member who linked AlecaFrame and asked for it (`/track crack`, or the fissure board's menu), a DM when a quick
 * fissure is open for relics they own that are worth opening, with the fissure and their best relics per tier. Some quick fissure is
 * open most of the day, so what paces it is the member's quiet time: at most one DM every so many hours. The `/now` card shows the
 * same reckoning to the member who asked (`personalLines`).
 */

export type CrackSpec = Extract<TrackerSpec, { kind: 'crack' }>;

/** A fissure must stay open this long to be worth a DM: the member has to see it, start the game and get there. */
const MIN_LEFT_MS = 20 * 60_000;
/** After a look that found nothing to say, the member's relics are left alone this long (AlecaFrame is asked no more than twice an hour). */
const RECHECK_MS = 30 * 60_000;
const STATE = 'crack_state';
/** Relics named per tier; the rest are counted. */
const NAMED = 3;

const minPlatOf = (spec: CrackSpec): number => (Number.isFinite(spec.minPlat) && spec.minPlat >= 1 ? spec.minPlat : DEFAULT_CRACK_PLAT);
const quietHoursOf = (spec: CrackSpec): number => (Number.isFinite(spec.quietHours) && spec.quietHours >= 1 ? Math.min(spec.quietHours, 168) : DEFAULT_CRACK_QUIET_HOURS);

/** Why a member cannot have "crack now" yet, in words they can act on; null when their AlecaFrame link shares their relics. */
export function crackLinkProblem(store: Pick<Store, 'getAlecaLink'>, userId: string): string | null {
  const link = store.getAlecaLink(userId);
  if (!link) return '"Crack now" works from your own relics: link AlecaFrame first with `/alecaframe link` (tick **Relics** when you create the public link), then set it again.';
  if (!sharesRelics(link)) return 'Your AlecaFrame link does not share your relics. Create a new public link in AlecaFrame with **Relics** ticked, link it with `/alecaframe link`, then set this again.';
  return null;
}

/** A member's "crack now" notification, if they have one (there is at most one each). */
export function crackTrackerOf(store: Pick<Store, 'listTrackers'>, guildId: string, userId: string): { id: number; spec: CrackSpec } | null {
  for (const t of store.listTrackers(guildId, userId)) {
    const spec = parseSpec(t.spec);
    if (spec?.kind === 'crack') return { id: t.id, spec };
  }
  return null;
}

const relicText = (r: CrackRelic): string => `${r.name}${r.refinement === 'Intact' ? '' : ` ${r.refinement}`} ×${r.count} ≈ ${platText(r.solo)}`;
const relicCount = (n: number): string => `${n} ${n === 1 ? 'relic' : 'relics'}`;

function tierBlock(t: CrackTier): string {
  const more = t.relics.length - NAMED;
  return [
    `${tierEmoji(t.tier)} **${t.tier}** · ${relicCount(t.copies)} · about **${platText(t.value)}** opened alone`,
    fissureLine(t.fissure),
    `-# ${t.relics.slice(0, NAMED).map(relicText).join(' · ')}${more > 0 ? ` · +${more} more` : ''}`,
  ].join('\n');
}

/** The DM (pure): per relic tier what the member owns that is worth opening, and the quick fissure to open it in. */
export function crackDm(plan: CrackTier[], opts: { minPlat: number; quietHours: number; trackerId: number }, avatar: string | null): ContainerBuilder {
  return card(COLORS.void, [
    section(`### ${e('bolt')} A good moment to crack relics\nYou own relics expected to pay **${opts.minPlat}p or more** a run, and a quick fissure for them is open.`, avatar),
    ...plan.flatMap((t): Part[] => [DIVIDER, tierBlock(t)]),
    DIVIDER,
    [
      "-# Your relics as AlecaFrame last saw them · a run's worth is every reward's average price (WFInfo) times its chance.",
      `-# Tracker #${opts.trackerId}: at most one of these every ${opts.quietHours} hours. Change it with /track crack, stop it with /track remove or "My notifications".`,
    ].join('\n'),
  ]);
}

/** The lines about a member's own relics on their `/now` card (pure); none when nothing of theirs is worth opening right now. */
export function crackLines(plan: CrackTier[], minPlat: number): string[] {
  if (!plan.length) return [];
  return [
    '**Your relics** · worth cracking in a quick fissure right now',
    ...plan.map((t) => `${tierEmoji(t.tier)} **${t.tier}** · ${relicCount(t.copies)} · about ${platText(t.value)} · best: ${relicText(t.relics[0]!)}`),
    `-# Relics of yours expected to pay ${minPlat}p or more a run (AlecaFrame's inventory, WFInfo's prices).`,
  ];
}

/**
 * What the `/now` card may add for the member who asked: their relics worth opening in the quick fissures that are open. Empty when
 * they have no AlecaFrame link that shares relics, when nothing qualifies, or when it cannot be worked out within `waitMs` (the card
 * must not wait for AlecaFrame; the read goes on, so the next `/now` has it).
 */
export function personalLines(ctx: Pick<AppContext, 'store' | 'config'>, userId: string, ws: WorldState | null, now: number, opts: { waitMs: number; book?: RelicBook }): Promise<string[]> {
  const quick = quickFissures(ws, now);
  if (!quick.some((f) => !f.isHard)) return Promise.resolve([]);
  const work = (async () => {
    const { owned } = await relicsOf(ctx.store, userId);
    if (!owned?.length) return [];
    const own = crackTrackerOf(ctx.store, ctx.config.DISCORD_GUILD_ID, userId);
    const minPlat = own ? minPlatOf(own.spec) : DEFAULT_CRACK_PLAT;
    return crackLines(crackPlan(owned, opts.book ?? (await loadRelicBook()), quick, minPlat), minPlat);
  })();
  return withTimeout(work, opts.waitMs, () => new Error('still reading')).catch(() => []);
}

interface Mark {
  /** When the member was last told. */
  lastAt: number;
  /** Not before this time are their relics looked at again. */
  checkAt: number;
}

function readMarks(store: Pick<Store, 'getMeta'>): Record<string, Mark> {
  try {
    const raw = JSON.parse(store.getMeta(STATE) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, Mark> = {};
    for (const [id, m] of Object.entries(raw as Record<string, Partial<Mark> | null>)) {
      if (m && typeof m.checkAt === 'number') out[id] = { lastAt: typeof m.lastAt === 'number' ? m.lastAt : 0, checkAt: m.checkAt };
    }
    return out;
  } catch {
    return {};
  }
}

/** When each "crack now" notification last spoke and when it looks next, by tracker id (for get_bot_health and the tests). */
export const crackState = (store: Pick<Store, 'getMeta'>): Record<string, Mark> => readMarks(store);

/**
 * One round (the `world-state` job): every member whose quiet time is over gets a DM when a quick fissure is open for relics of
 * theirs worth opening. Returns how many DMs went out. Nothing is read from AlecaFrame while no quick fissure is open, and a member
 * whose relics could not be read, or hold nothing worth opening, is looked at again half an hour later.
 */
export async function notifyCrack(ctx: AppContext, ws: WorldState | null, now = Date.now(), opts: { book?: RelicBook } = {}): Promise<number> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const trackers = ctx.store.listTrackers(guildId).flatMap((t) => {
    const spec = parseSpec(t.spec);
    return spec?.kind === 'crack' ? [{ t, spec }] : [];
  });
  const before = ctx.store.getMeta(STATE);
  if (!trackers.length) {
    if (before && before !== '{}') ctx.store.setMeta(STATE, '{}');
    return 0;
  }
  const marks = readMarks(ctx.store);
  // The marks of notifications that were removed go with them.
  const kept: Record<string, Mark> = {};
  for (const { t } of trackers) if (marks[t.id]) kept[t.id] = marks[t.id]!;

  const quick = quickFissures(ws, now, { minLeftMs: MIN_LEFT_MS }).filter((f) => !f.isHard);
  const due = quick.length ? trackers.filter(({ t }) => (kept[t.id]?.checkAt ?? 0) <= now) : [];
  let sent = 0;
  let book: RelicBook | null = opts.book ?? null;
  const avatar = due.length ? (brandIcon(ctx) ?? null) : null;
  for (const { t, spec } of due) {
    const last = kept[t.id]?.lastAt ?? 0;
    const { owned } = await relicsOf(ctx.store, t.userId);
    let plan: CrackTier[] = [];
    if (owned?.length) {
      book ??= await loadRelicBook({ background: true }).catch(() => null);
      if (book) plan = crackPlan(owned, book, quick, minPlatOf(spec));
    }
    if (!plan.length) {
      kept[t.id] = { lastAt: last, checkAt: now + RECHECK_MS };
      continue;
    }
    const quietHours = quietHoursOf(spec);
    const reached = await sendDm(ctx, t.userId, crackDm(plan, { minPlat: minPlatOf(spec), quietHours, trackerId: t.id }, avatar), 'a crack-now note');
    if (reached) sent++;
    // A member whose DMs are closed is not tried every half hour either.
    kept[t.id] = { lastAt: reached ? now : last, checkAt: now + quietHours * 3_600_000 };
  }
  const after = JSON.stringify(kept);
  if (after !== (before ?? '{}')) ctx.store.setMeta(STATE, after);
  return sent;
}
