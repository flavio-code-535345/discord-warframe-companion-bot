import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import type { Store } from '../db.js';
import { getSendableChannel } from '../services/clan.js';
import { RELIC_TIERS, type RelicBook, loadRelicBook } from '../warframe/relics.js';
import { COLORS, footer } from './style.js';

/**
 * The vault watch (the hourly `vault-watch` job): a post in the game news channel when prime sets and their relics leave the drop
 * tables (vaulted), come back, or are new. It compares the relic book (WFInfo's table, read every 6 hours anyway, so this asks
 * nothing of its own) with what it looked like at the last change, kept in bot_meta. The first look only records.
 */

export const VAULT_CHECK_MS = 3_600_000;
const STATE = 'vault_watch';
/** A table with fewer relics than this is a broken answer, not WFInfo's list. */
const MIN_RELICS = 100;
/** More relics changing at once than this is the data being rebuilt, not a vaulting: it is recorded without a post. */
const MAX_FLIPS = 120;

/** Name → vaulted. */
export interface VaultSnapshot {
  relics: Map<string, boolean>;
  sets: Map<string, boolean>;
}

export interface VaultChanges {
  vaultedSets: string[];
  openedSets: string[];
  newSets: string[];
  vaultedRelics: string[];
  openedRelics: string[];
  newRelics: string[];
}

export function snapshotOf(book: RelicBook): VaultSnapshot {
  return {
    relics: new Map([...book.relics.values()].map((r) => [r.name, r.vaulted])),
    // A set no relic holds (a part of a paired weapon aside) is neither in the vault nor out of it.
    sets: new Map([...book.sets.values()].filter((s) => s.parts.some((p) => p.relics.length)).map((s) => [s.name, s.vaulted])),
  };
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** What is different between two looks at the table (pure). Something new only counts while it can be farmed. */
export function vaultChanges(before: VaultSnapshot, after: VaultSnapshot): VaultChanges {
  const diff = (was: Map<string, boolean>, now: Map<string, boolean>) => {
    const vaulted: string[] = [];
    const opened: string[] = [];
    const fresh: string[] = [];
    for (const [name, isVaulted] of now) {
      const old = was.get(name);
      if (old === undefined) {
        if (!isVaulted) fresh.push(name);
      } else if (old !== isVaulted) (isVaulted ? vaulted : opened).push(name);
    }
    return [vaulted.sort(byName), opened.sort(byName), fresh.sort(byName)] as const;
  };
  const [vaultedSets, openedSets, newSets] = diff(before.sets, after.sets);
  const [vaultedRelics, openedRelics, newRelics] = diff(before.relics, after.relics);
  return { vaultedSets, openedSets, newSets, vaultedRelics, openedRelics, newRelics };
}

const total = (c: VaultChanges) => c.vaultedSets.length + c.openedSets.length + c.newSets.length + c.vaultedRelics.length + c.openedRelics.length + c.newRelics.length;

/** "A", "A and B", "A, B and 3 more". */
function few(names: string[], max = 3): string {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
  return `${names.slice(0, max - 1).join(', ')} and ${names.length - (max - 1)} more`;
}

/** "**Lith** S14, T9 · **Meso** N16", in the game's tier order; past `max` relics the rest is counted. */
export function relicList(names: string[], max = 36): string {
  const tiers = new Map<string, string[]>();
  for (const name of names.slice(0, max)) {
    const cut = name.lastIndexOf(' ');
    const tier = cut > 0 ? name.slice(0, cut) : name;
    const codes = tiers.get(tier) ?? [];
    codes.push(cut > 0 ? name.slice(cut + 1) : '');
    tiers.set(tier, codes);
  }
  const order = (tier: string) => {
    const at = (RELIC_TIERS as readonly string[]).indexOf(tier);
    return at < 0 ? RELIC_TIERS.length : at;
  };
  const text = [...tiers]
    .sort((a, b) => order(a[0]) - order(b[0]) || byName(a[0], b[0]))
    .map(([tier, codes]) => `**${tier}** ${codes.sort(byName).join(', ')}`.trim())
    .join(' · ');
  return names.length > max ? `${text} and ${names.length - max} more` : text;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The post for the game news channel (pure). */
export function vaultEmbed(c: VaultChanges): EmbedBuilder {
  const title = c.vaultedSets.length
    ? `${few(c.vaultedSets)} ${c.vaultedSets.length === 1 ? 'is' : 'are'} now vaulted`
    : c.newSets.length
      ? `New in the relics: ${few(c.newSets)}`
      : c.openedSets.length
        ? `${few(c.openedSets)} ${c.openedSets.length === 1 ? 'is' : 'are'} back in the drop tables`
        : c.vaultedRelics.length
          ? `${plural(c.vaultedRelics.length, 'relic')} left the drop tables`
          : c.openedRelics.length
            ? `${plural(c.openedRelics.length, 'relic')} back in the drop tables`
            : `${plural(c.newRelics.length, 'new relic')}`;
  const parts: string[] = [];
  if (c.vaultedSets.length || c.vaultedRelics.length) {
    parts.push(
      [
        '🔒 **Vaulted**: these no longer drop. A relic you already own can still be opened and traded.',
        c.vaultedSets.length ? c.vaultedSets.join(', ') : '',
        c.vaultedRelics.length ? `Relics: ${relicList(c.vaultedRelics)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (c.newSets.length || c.newRelics.length) {
    parts.push(['✨ **New**', c.newSets.length ? c.newSets.join(', ') : '', c.newRelics.length ? `Relics: ${relicList(c.newRelics)}` : ''].filter(Boolean).join('\n'));
  }
  if (c.openedSets.length || c.openedRelics.length) {
    parts.push(
      ['🔓 **Back in the drop tables**', c.openedSets.length ? c.openedSets.join(', ') : '', c.openedRelics.length ? `Relics: ${relicList(c.openedRelics)}` : ''].filter(Boolean).join('\n'),
    );
  }
  parts.push('`/relics` shows what relics are worth, `/item` what a relic holds.');
  return new EmbedBuilder()
    .setColor(c.vaultedSets.length || c.vaultedRelics.length ? COLORS.void : COLORS.success)
    .setAuthor({ name: '🔒 Prime Vault' })
    .setTitle(title.slice(0, 256))
    .setDescription(parts.join('\n\n').slice(0, 4000))
    .setTimestamp()
    .setFooter(footer('WFInfo relic data'));
}

interface StoredState {
  at: number;
  changedAt: number | null;
  relics: { open: string[]; vaulted: string[] };
  sets: { open: string[]; vaulted: string[] };
}

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []);

function readState(store: Store): (VaultSnapshot & { at: number; changedAt: number | null }) | null {
  const raw = store.getMeta(STATE);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<StoredState> | null;
    if (!s || typeof s !== 'object' || !s.relics || !s.sets) return null;
    const read = (part: { open?: unknown; vaulted?: unknown }) => new Map<string, boolean>([...names(part.open).map((n) => [n, false] as const), ...names(part.vaulted).map((n) => [n, true] as const)]);
    const relics = read(s.relics);
    if (!relics.size) return null;
    return { relics, sets: read(s.sets), at: Number(s.at) || 0, changedAt: typeof s.changedAt === 'number' ? s.changedAt : null };
  } catch {
    return null;
  }
}

function writeState(store: Store, snap: VaultSnapshot, at: number, changedAt: number | null): void {
  const split = (map: Map<string, boolean>) => ({ open: [...map].filter(([, v]) => !v).map(([n]) => n), vaulted: [...map].filter(([, v]) => v).map(([n]) => n) });
  store.setMeta(STATE, JSON.stringify({ at, changedAt, relics: split(snap.relics), sets: split(snap.sets) } satisfies StoredState));
}

/** What the watch holds, for get_bot_health; null before its first look. */
export function vaultWatchState(store: Store): { relics: number; vaultedRelics: number; sets: number; vaultedSets: number; recordedAt: number; lastChangeAt: number | null } | null {
  const s = readState(store);
  if (!s) return null;
  const vaulted = (map: Map<string, boolean>) => [...map.values()].filter(Boolean).length;
  return { relics: s.relics.size, vaultedRelics: vaulted(s.relics), sets: s.sets.size, vaultedSets: vaulted(s.sets), recordedAt: s.at, lastChangeAt: s.changedAt };
}

const KINDS = [
  ['vaultedSets', 'set', 'v'],
  ['openedSets', 'set', 'o'],
  ['newSets', 'set', 'n'],
  ['vaultedRelics', 'relic', 'v'],
  ['openedRelics', 'relic', 'o'],
  ['newRelics', 'relic', 'n'],
] as const;
const seenKey = (what: string, change: string, name: string) => `vault:${what}:${change}:${name.toLowerCase()}`;

/**
 * One look at the table. Returns what was posted, or null. A stale or broken table is left alone; a change already announced in the
 * last weeks (a flag that flips back and forth in the data) is not announced again.
 */
export async function watchVault(ctx: AppContext, opts: { now?: number; book?: RelicBook } = {}): Promise<VaultChanges | null> {
  const now = opts.now ?? Date.now();
  const book = opts.book ?? (await loadRelicBook({ background: true }));
  if (book.stale || book.relics.size < MIN_RELICS) return null;
  const after = snapshotOf(book);
  const before = readState(ctx.store);
  if (!before) {
    writeState(ctx.store, after, now, null);
    return null;
  }
  // Relics never leave the table, so a table that lost a fifth of them is not a newer one.
  let missing = 0;
  for (const name of before.relics.keys()) if (!after.relics.has(name)) missing++;
  if (missing > before.relics.size / 5) {
    console.warn(`[vault] the relic table lost ${missing} of ${before.relics.size} relics; left alone`);
    return null;
  }
  const all = vaultChanges(before, after);
  if (!total(all)) return null;
  const record = () => writeState(ctx.store, after, now, now);
  if (all.vaultedRelics.length + all.openedRelics.length > MAX_FLIPS) {
    console.warn(`[vault] ${all.vaultedRelics.length + all.openedRelics.length} relics changed at once: recorded without a post`);
    record();
    return null;
  }
  const fresh: VaultChanges = { vaultedSets: [], openedSets: [], newSets: [], vaultedRelics: [], openedRelics: [], newRelics: [] };
  for (const [list, what, change] of KINDS) fresh[list] = all[list].filter((name) => !ctx.store.hasSeen(seenKey(what, change, name)));
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).newsChannelId;
  if (!total(fresh) || !channelId) {
    record();
    return null;
  }
  // Recorded only once the post is out: a channel that cannot be posted in today gets the news when it can.
  const channel = await getSendableChannel(ctx, channelId);
  await channel.send({ embeds: [vaultEmbed(fresh)], allowedMentions: { parse: [] } });
  for (const [list, what, change] of KINDS) for (const name of fresh[list]) ctx.store.markSeen(seenKey(what, change, name));
  record();
  return fresh;
}
