import { ActionRowBuilder, type ContainerBuilder, type MessageActionRowComponentBuilder, MessageFlags, StringSelectMenuBuilder, type StringSelectMenuInteraction } from 'discord.js';
import { type RelicAccess, relicsOf } from '../alecaframe/access.js';
import type { AppContext } from '../context.js';
import type { Wish } from '../db.js';
import { sendDm } from '../discord/dm.js';
import { e } from '../discord/emoji.js';
import { DIVIDER, type Part, type Row, card, section } from '../discord/feeds/parts.js';
import { brandIcon } from '../discord/identity.js';
import { platText } from '../discord/lookup-embeds.js';
import { COLORS } from '../discord/style.js';
import { UserError } from '../errors.js';
import { discordTime } from '../time.js';
import { withTimeout } from '../timeout.js';
import { type BookSet, type RelicBook, findSet, loadRelicBook } from '../warframe/relics.js';
import { type WorldState, getWorldState, worldStateEnabled } from '../warframe/worldstate.js';
import { MAX_WISHES, type VarziaOffer, type WishPart, type WishPlan, type WishRelic, inRelics, varziaOffer, wishPlan } from './plan.js';

/**
 * The prime wishlist (`/wishlist`): a member lists the prime sets they are collecting and ticks the parts they already have. For each
 * set Ordis shows what the missing parts trade for, which relics hold them (the ones that still drop first), which of those relics
 * the member owns (their AlecaFrame link) and whether Varzia sells the set; and DMs them when Varzia starts selling it and when it
 * leaves or re-enters the drop tables. Everything a member sees here is ephemeral.
 */

/** Relics named per part; the rest are counted. */
const RELICS_PER_PART = 8;
const OWNED_PER_PART = 6;

export interface WishView {
  plan: WishPlan;
  /** The wishlist entry, or null when the set is only being looked at. */
  wish: Wish | null;
  varzia: VarziaOffer | null;
  /** Whether the member's relics could be read, or why not. */
  access: RelicAccess;
  /** The price list came from the cache because its source could not be read. */
  stale: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** WFInfo's kinds are plurals ("Warframes", "Sentinels") or already fine ("Primary", "Melee"). */
const kindOf = (type: string): string => (/[^s]s$/.test(type) ? type.slice(0, -1) : type);

/** "Saryn Prime Single Pack, Nidus Saryn Prime Dual Pack · relics of the Nidus Saryn vault: Lith A · Meso A, B". */
export function offerText(items: readonly string[]): string {
  const other: string[] = [];
  const vaults = new Map<string, Map<string, string[]>>();
  for (const item of items) {
    const relic = /^(Lith|Meso|Neo|Axi) relic · (.+) ([A-Z])$/.exec(item);
    if (!relic) {
      other.push(item);
      continue;
    }
    const tiers = vaults.get(relic[2]!) ?? new Map<string, string[]>();
    tiers.set(relic[1]!, [...(tiers.get(relic[1]!) ?? []), relic[3]!]);
    vaults.set(relic[2]!, tiers);
  }
  const relics = [...vaults].map(([vault, tiers]) => `relics of the ${vault} vault: ${[...tiers].map(([tier, codes]) => `${tier} ${codes.sort().join(', ')}`).join(' · ')}`);
  return [other.join(', '), ...relics].filter(Boolean).join(' · ');
}

function relicsText(relics: readonly WishRelic[]): string {
  const shown = relics.slice(0, RELICS_PER_PART);
  const groups = (['Rare', 'Uncommon', 'Common'] as const)
    .map((rarity) => [rarity, shown.filter((r) => r.rarity === rarity)] as const)
    .filter(([, list]) => list.length)
    .map(([rarity, list]) => `${rarity} in ${list.map((r) => (r.vaulted ? `${r.name} 🔒` : `**${r.name}**`)).join(', ')}`);
  const more = relics.length - shown.length;
  return `${groups.join(' · ')}${more > 0 ? ` · +${more} more` : ''}`;
}

function ownedText(relics: readonly WishRelic[]): string | null {
  const mine = relics.flatMap((r) => r.owned.map((o) => `${r.name}${o.refinement === 'Intact' ? '' : ` ${o.refinement}`} ×${o.count}`));
  if (!mine.length) return null;
  const more = mine.length - OWNED_PER_PART;
  return `-# ${e('relic')} You own ${mine.slice(0, OWNED_PER_PART).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

function partBlock(p: WishPart): string {
  const price = p.plat !== null ? ` · ${platText(p.plat)}${p.count > 1 ? ' each' : ''}` : '';
  const title = `**${p.count > 1 ? `${p.count}× ` : ''}${p.name}**${price}${p.ducats ? ` · ${p.ducats} ${e('ducats')}` : ''}`;
  if (p.ownSet) return `${title}\n-# A weapon of its own, built from its own parts: \`/wishlist show item:${p.name}\``;
  if (!p.relics.length) return `${title}\n-# No relic holds it.`;
  return [title, `-# ${relicsText(p.relics)}`, ownedText(p.relics)].filter(Boolean).join('\n');
}

const ACCESS_NOTE: Record<Exclude<RelicAccess, 'ok'>, string> = {
  unlinked: '-# Link AlecaFrame with `/alecaframe link` (tick **Relics**) and Ordis marks the relics you own.',
  unshared: '-# Your AlecaFrame link does not share your relics, so Ordis cannot mark the ones you own.',
  unreadable: '-# AlecaFrame could not be read just now, so the relics you own are not marked.',
};

/** The menu that ticks the parts a member already has; its ID carries the wishlist entry. */
function haveMenu(wish: Wish, parts: readonly WishPart[]): Row | null {
  if (!parts.length) return null;
  const options = parts.slice(0, 25).map((p) => ({ label: `${p.count > 1 ? `${p.count}× ` : ''}${p.name}`.slice(0, 100), value: p.name.slice(0, 100), default: p.have }));
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(`wish:have:${wish.id}`).setPlaceholder('✅ Tick the parts you already have…').setMinValues(0).setMaxValues(options.length).addOptions(options),
  );
}

/** One set (pure): what is still missing, what it costs, where it drops and what the member owns of it. */
export function wishCard(v: WishView, note?: string): ContainerBuilder {
  const { plan, wish } = v;
  const { set, missing } = plan;
  const facts = [kindOf(set.type), set.vaulted ? '🔒 vaulted: its relics no longer drop' : 'its relics drop now', set.plat !== null ? `the set trades for about ${platText(set.plat)}` : null].filter(Boolean);
  const have = plan.parts.filter((p) => p.have);
  const cost = plan.missingPlat > 0 ? ` · about **${platText(plan.missingPlat)}** on the market${plan.unpriced ? ` (${plural(plan.unpriced, 'part')} without a price)` : ''}` : '';
  const footer = [
    v.access === 'ok' ? (missing.length && plan.ownedRelics === 0 ? '-# You own none of the relics that hold a missing part.' : null) : ACCESS_NOTE[v.access],
    `-# Prices are WFInfo's averages from warframe.market${v.stale ? ' (cached)' : ''} · 🔒 no longer drops.${wish ? ' Ordis DMs you when Varzia sells this set and when it leaves or re-enters the drop tables.' : ''}`,
    wish ? null : '-# Not on your wishlist: `/wishlist add` puts it there.',
  ].filter(Boolean);
  return card(COLORS.void, [
    `## ${e('relic')} ${set.name}\n-# ${facts.join(' · ')}`,
    note ?? null,
    v.varzia ? `${e('varzia')} **Varzia sells it** until ${discordTime(v.varzia.until, 'D')} (${discordTime(v.varzia.until, 'R')}): ${offerText(v.varzia.items)}` : null,
    DIVIDER,
    missing.length
      ? `**Still needed** · ${missing.length} of ${plural(plan.parts.length, 'part')}${cost}`
      : '🎉 **You have every part.** Build it, then take it off the list with `/wishlist remove`.',
    ...missing.map(partBlock),
    have.length && missing.length ? `✅ **Already have:** ${have.map((p) => p.name).join(', ')}` : null,
    wish ? DIVIDER : null,
    wish ? haveMenu(wish, plan.parts) : null,
    DIVIDER,
    footer.join('\n'),
  ]);
}

function listEntry(v: WishView): string {
  const { plan } = v;
  const state = plan.missing.length ? `${plan.missing.length} of ${plural(plan.parts.length, 'part')} missing${plan.missingPlat > 0 ? ` · about ${platText(plan.missingPlat)}` : ''}` : '🎉 complete';
  const notes = [
    plan.missing.length && plan.ownedRelics ? `you own ${plural(plan.ownedRelics, 'relic')} that ${plan.ownedRelics === 1 ? 'holds' : 'hold'} a missing part` : null,
    v.varzia ? `${e('varzia')} Varzia sells it until ${discordTime(v.varzia.until, 'R')}` : null,
  ].filter(Boolean);
  return `**${plan.set.name}** · ${plan.set.vaulted ? '🔒 vaulted' : 'drops now'} · ${state}${notes.length ? `\n-# ${notes.join(' · ')}` : ''}`;
}

/** A member's whole wishlist (pure). `gone`: wished sets the relic tables no longer know. */
export function wishListCard(views: readonly WishView[], gone: readonly string[] = []): ContainerBuilder {
  const total = views.length + gone.length;
  const access = views[0]?.access ?? 'ok';
  return card(COLORS.void, [
    `## ${e('relic')} Your prime wishlist · ${total}/${MAX_WISHES}`,
    DIVIDER,
    total ? null : 'Nothing on it yet. `/wishlist add` takes a prime set, such as Saryn Prime or Strun Prime.',
    ...views.map(listEntry),
    ...gone.map((name) => `**${name}** · not in the relic tables right now`),
    DIVIDER,
    [
      total ? '-# `/wishlist show` lists a set\'s missing parts, their prices and the relics that hold them; there you tick the parts you have.' : null,
      access !== 'ok' && total ? ACCESS_NOTE[access] : null,
      '-# Ordis DMs you when Varzia sells a set on your list and when one leaves or re-enters the drop tables.',
    ]
      .filter(Boolean)
      .join('\n'),
  ]);
}

async function bookOrThrow(): Promise<RelicBook> {
  return loadRelicBook().catch(() => {
    throw new UserError('The relic tables could not be read right now. Try again in a few minutes.');
  });
}

/** The world state for the Varzia line, when it is switched on and can be had. */
async function worldNow(waitMs?: number): Promise<WorldState | null> {
  if (!worldStateEnabled()) return null;
  const read = getWorldState().catch(() => null);
  return waitMs ? withTimeout(read, waitMs, () => new Error('slow')).catch(() => null) : read;
}

/** A prime set by name that can be collected from relics, or an error the member can act on. */
function setOrThrow(book: RelicBook, name: string): BookSet {
  const set = findSet(book, name);
  if (!set) throw new UserError(`No prime set is called "${name.slice(0, 80)}". Pick one from the list that appears while you type, such as Saryn Prime.`);
  if (!inRelics(set)) throw new UserError(`${set.name} does not come from relics, so there is nothing to collect.`);
  return set;
}

/** Everything one set's card needs. `waitMs` bounds the outside reads, for an answer that cannot be deferred. */
async function viewOf(ctx: AppContext, userId: string, book: RelicBook, set: BookSet, wish: Wish | null, opts: { waitMs?: number; now?: number } = {}): Promise<WishView> {
  const [relics, ws] = await Promise.all([relicsOf(ctx.store, userId, opts), worldNow(opts.waitMs)]);
  return { plan: wishPlan(book, set, wish?.have ?? [], relics.owned), wish, varzia: varziaOffer(set.name, ws, opts.now ?? Date.now()), access: relics.access, stale: book.stale };
}

const seenKey = (wish: Wish, offer: VarziaOffer) => `wish:${wish.id}:varzia:${offer.until}`;

/** The member's entry for a set, by its exact name or the way a member would type it. */
function wishFor(ctx: AppContext, userId: string, book: RelicBook | null, name: string): Wish | null {
  const wishes = ctx.store.listWishes(ctx.config.DISCORD_GUILD_ID, userId);
  const typed = name.trim().toLowerCase();
  const known = (book && findSet(book, name)?.name.toLowerCase()) || typed;
  return wishes.find((w) => w.item.toLowerCase() === typed || w.item.toLowerCase() === known) ?? null;
}

/** `/wishlist add`: puts a set on the member's list and returns its card. */
export async function addWish(ctx: AppContext, userId: string, name: string, now = Date.now()): Promise<ContainerBuilder> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const book = await bookOrThrow();
  const set = setOrThrow(book, name);
  const mine = ctx.store.listWishes(guildId, userId);
  const had = mine.find((w) => w.item.toLowerCase() === set.name.toLowerCase());
  if (!had && mine.length >= MAX_WISHES) throw new UserError(`Your wishlist holds ${MAX_WISHES} sets, the most allowed. Take one off with \`/wishlist remove\` first.`);
  const wish = had ?? ctx.store.addWish(guildId, userId, set.name, now);
  const view = await viewOf(ctx, userId, book, set, wish, { now });
  // What the card says here is not said again in a DM a minute later.
  if (view.varzia) ctx.store.markSeen(seenKey(wish, view.varzia));
  return wishCard(view, had ? 'Already on your wishlist.' : `✅ Added to your wishlist (${mine.length + 1}/${MAX_WISHES}).`);
}

/** `/wishlist show`: one set's card; any prime set can be looked at, on the list or not. */
export async function showWish(ctx: AppContext, userId: string, name: string, now = Date.now()): Promise<ContainerBuilder> {
  const book = await bookOrThrow();
  const set = setOrThrow(book, name);
  return wishCard(await viewOf(ctx, userId, book, set, wishFor(ctx, userId, book, set.name), { now }));
}

/** `/wishlist list`: every set on the member's list in a line or two. */
export async function listWishes(ctx: AppContext, userId: string, now = Date.now()): Promise<ContainerBuilder> {
  const wishes = ctx.store.listWishes(ctx.config.DISCORD_GUILD_ID, userId);
  if (!wishes.length) return wishListCard([]);
  const book = await bookOrThrow();
  const [relics, ws] = await Promise.all([relicsOf(ctx.store, userId), worldNow()]);
  const views: WishView[] = [];
  const gone: string[] = [];
  for (const wish of wishes) {
    const set = findSet(book, wish.item);
    if (!set) gone.push(wish.item);
    else views.push({ plan: wishPlan(book, set, wish.have, relics.owned), wish, varzia: varziaOffer(set.name, ws, now), access: relics.access, stale: book.stale });
  }
  return wishListCard(views, gone);
}

/** `/wishlist remove`: takes a set off the member's list; returns its name. */
export async function removeWish(ctx: AppContext, userId: string, name: string): Promise<string> {
  // The book only helps to read a name typed loosely ("saryn"); the list can be emptied without it, and is not kept waiting for it.
  const wish = wishFor(ctx, userId, await withTimeout(loadRelicBook(), 1500, () => new Error('slow')).catch(() => null), name);
  if (!wish || !ctx.store.removeWish(ctx.config.DISCORD_GUILD_ID, userId, wish.id)) throw new UserError(`"${name.slice(0, 80)}" is not on your wishlist. \`/wishlist list\` shows what is.`);
  return wish.item;
}

/**
 * The names a member may pick while typing: their own entries (`mine`, to take one off), the prime sets that come from relics and
 * are not on their list yet (`new`, to add one), or all of them with their own first (`all`, to look one up).
 */
export async function wishChoices(ctx: AppContext, userId: string, typed: string, which: 'mine' | 'new' | 'all'): Promise<string[]> {
  const q = typed.trim().toLowerCase();
  const mine = ctx.store.listWishes(ctx.config.DISCORD_GUILD_ID, userId).map((w) => w.item);
  const rank = (names: string[]) => names.filter((n) => n.toLowerCase().includes(q)).sort((a, b) => Number(b.toLowerCase().startsWith(q)) - Number(a.toLowerCase().startsWith(q)) || a.localeCompare(b));
  if (which === 'mine') return rank(mine).slice(0, 25);
  // Discord waits three seconds for suggestions: a book that has to be read first is not waited for.
  const book = await withTimeout(loadRelicBook(), 2000, () => new Error('slow')).catch(() => null);
  const own = new Set(mine.map((n) => n.toLowerCase()));
  const others = rank(book ? [...book.sets.values()].filter(inRelics).map((s) => s.name) : []).filter((n) => !own.has(n.toLowerCase()));
  return (which === 'new' ? others : [...rank(mine), ...others]).slice(0, 25);
}

/** The `wish:have:<id>` menu: the member ticked the parts they already have; the card is redrawn in place. */
export async function handleWishSelect(interaction: StringSelectMenuInteraction, ctx: AppContext): Promise<void> {
  const [, action, rawId] = interaction.customId.split(':');
  if (action !== 'have') throw new UserError('Unknown menu.');
  const wish = ctx.store.getWish(Number(rawId));
  if (!wish || wish.userId !== interaction.user.id || wish.guildId !== ctx.config.DISCORD_GUILD_ID) throw new UserError('That set is no longer on your wishlist.');
  const book = await bookOrThrow();
  const set = findSet(book, wish.item);
  if (!set) throw new UserError(`${wish.item} is not in the relic tables right now. Try again later.`);
  const names = new Map(set.parts.map((p) => [p.name.slice(0, 100), p.name]));
  const have = interaction.values.flatMap((v) => (names.has(v) ? [names.get(v)!] : []));
  ctx.store.setWishHave(wish.id, have);
  // An update cannot be deferred into a new card, so what is read from outside gets a second and a half.
  const view = await viewOf(ctx, wish.userId, book, set, { ...wish, have }, { waitMs: 1500 });
  await interaction.update({ components: [wishCard(view)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
}

/** The DM when Varzia starts selling sets on a member's wishlist (pure). */
export function varziaDm(views: readonly WishView[], avatar: string | null): ContainerBuilder {
  const blocks = views.flatMap((v): Part[] => {
    if (!v.varzia) return [];
    const { plan } = v;
    // Without the relic tables (they could not be read) nothing is said about the parts.
    const left = !plan.parts.length
      ? null
      : plan.missing.length
        ? `-# ${plan.missing.length} of ${plural(plan.parts.length, 'part')} still missing${plan.missingPlat > 0 ? ` · about ${platText(plan.missingPlat)} on the market` : ''}`
        : '-# You have ticked every part of it.';
    return [DIVIDER, [`**${plan.set.name}** · until ${discordTime(v.varzia.until, 'D')} (${discordTime(v.varzia.until, 'R')})`, offerText(v.varzia.items), left].filter(Boolean).join('\n')];
  });
  return card(COLORS.void, [
    section(`### ${e('varzia')} Varzia has something from your wishlist`, avatar),
    ...blocks,
    DIVIDER,
    "-# From your /wishlist. Prime Resurgence is at Maroo's Bazaar on Mars: packs cost Regal Aya, relics cost Aya.",
  ]);
}

/**
 * One round (the `world-state` job): every member is told once per visit when Varzia sells a set on their wishlist, all of their
 * sets in one DM. Returns how many DMs went out.
 */
export async function notifyWishlistVarzia(ctx: AppContext, ws: WorldState | null, now = Date.now(), opts: { book?: RelicBook } = {}): Promise<number> {
  if (!ws?.vaultTrader?.inventory?.length) return 0;
  const wishes = ctx.store.listWishes(ctx.config.DISCORD_GUILD_ID);
  const fresh = new Map<string, { wish: Wish; offer: VarziaOffer }[]>();
  for (const wish of wishes) {
    const offer = varziaOffer(wish.item, ws, now);
    if (!offer || !ctx.store.markSeen(seenKey(wish, offer))) continue;
    fresh.set(wish.userId, [...(fresh.get(wish.userId) ?? []), { wish, offer }]);
  }
  if (!fresh.size) return 0;
  const book = opts.book ?? (await loadRelicBook({ background: true }).catch(() => null));
  const avatar = brandIcon(ctx) ?? null;
  let sent = 0;
  for (const [userId, list] of fresh) {
    const views = list.flatMap(({ wish, offer }): WishView[] => {
      const set = book ? findSet(book, wish.item) : null;
      // Without the relic tables the DM still names the set and what she sells.
      const plan = book && set ? wishPlan(book, set, wish.have, null) : { set: { name: wish.item, type: '', vaulted: true, plat: null, parts: [] }, parts: [], missing: [], missingPlat: 0, unpriced: 0, ownedRelics: null };
      return [{ plan, wish, varzia: offer, access: 'ok', stale: book?.stale ?? true }];
    });
    if (await sendDm(ctx, userId, varziaDm(views, avatar), 'a wishlist note about Varzia')) sent++;
  }
  return sent;
}

/** The DM when wished sets leave or re-enter the drop tables (pure). */
export function vaultDm(opened: readonly string[], vaulted: readonly string[], avatar: string | null): ContainerBuilder {
  return card(COLORS.void, [
    section(`### ${e('relic')} The Prime Vault moved something on your wishlist`, avatar),
    DIVIDER,
    [
      ...opened.map((name) => `🔓 **${name}** is back in the drop tables: its relics can be farmed again.`),
      ...vaulted.map((name) => `🔒 **${name}** is now vaulted: its relics no longer drop. The ones you own can still be opened and traded.`),
    ].join('\n'),
    DIVIDER,
    '-# From your /wishlist: `/wishlist show` lists the relics that hold each missing part.',
  ]);
}

/** Called by the vault watch with what changed: the members who wish for one of those sets are told. Never throws. */
export async function notifyWishlistVault(ctx: AppContext, changes: { openedSets: readonly string[]; vaultedSets: readonly string[] }): Promise<number> {
  const opened = new Map(changes.openedSets.map((n) => [n.toLowerCase(), n]));
  const vaulted = new Map(changes.vaultedSets.map((n) => [n.toLowerCase(), n]));
  if (!opened.size && !vaulted.size) return 0;
  const perUser = new Map<string, { opened: string[]; vaulted: string[] }>();
  for (const wish of ctx.store.listWishes(ctx.config.DISCORD_GUILD_ID)) {
    const key = wish.item.toLowerCase();
    if (!opened.has(key) && !vaulted.has(key)) continue;
    const mine = perUser.get(wish.userId) ?? { opened: [], vaulted: [] };
    if (opened.has(key)) mine.opened.push(opened.get(key)!);
    else mine.vaulted.push(vaulted.get(key)!);
    perUser.set(wish.userId, mine);
  }
  const avatar = perUser.size ? (brandIcon(ctx) ?? null) : null;
  let sent = 0;
  for (const [userId, mine] of perUser) if (await sendDm(ctx, userId, vaultDm(mine.opened, mine.vaulted, avatar), 'a wishlist note about the vault')) sent++;
  return sent;
}
