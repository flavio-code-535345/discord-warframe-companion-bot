import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { AppContext } from '../context.js';
import { readWikiPage, readWikiSource } from '../warframe/wiki.js';
import { cleanWikitext } from '../wiki/clean.js';
import { COLORS } from './embeds.js';
import { brandIcon } from './identity.js';
import { editLive, postLive, readLive } from './live-message.js';

/**
 * The promo codes channel (/setup promos): one message listing the codes the wiki's "Promo Codes" page has under Active Codes, refreshed
 * once a day from the page's raw wikitext (one cached wiki request, which keeps the rewards of one cell apart), else from the local wiki
 * copy. bot_meta: `promo_panel` is the message, `promo_updated` the day and channel
 * of the last update, `promo_try` the last failed try. A page that can't be read or parsed leaves the message as it is, so a changed page
 * layout never blanks the channel. Table `promo_codes_seen`: when Ordis first read each code (the added date of a row with no start date).
 */

const PAGE = 'Promo Codes';
const PANEL_META = 'promo_panel';
const DONE_META = 'promo_updated';
const TRY_META = 'promo_try';
/** After a failure the next try is this much later, not on the next minute's tick. */
const RETRY_MS = 3_600_000;
const REDEEM_URL = 'https://warframe.com/promocode';
/** Part of the daily stamp: bump it when the message's wording or layout changes, so the live message is updated at once. */
const PANEL_VERSION = 5;
const DESCRIPTION_MAX = 4000;
/** The longest reward text or summary shown for one code. */
const REWARD_MAX = 200;

export interface PromoCode {
  code: string;
  /** The rewards joined with ", " (cut to REWARD_MAX). */
  reward: string;
  /** The rewards one by one, as the wiki lists them in the cell (for summarizeRewards). */
  items: string[];
  /** The first day of the row's "Dates Active" (YYYY-MM-DD), when the wiki gives one. */
  start?: string;
  /** The last day (YYYY-MM-DD), 'none' for an open end ("Indefinite"), absent when unknown ("?" or no date at all). */
  end?: string;
}

/** A code with the dates the message shows. */
export interface DatedPromoCode extends PromoCode {
  /** Epoch ms: the wiki's start day, else when Ordis first read the code, else null (unknown). */
  added: number | null;
  /** Epoch ms of the last day, 'none' for an open end, null when unknown. */
  expires: number | 'none' | null;
}

/** What a table row starts with when its code cell is empty: then there is no code to show. */
const TYPE_WORD = /^(glyphs?|decorations?|boosters?|displays?|cosmetics?|items?|weapons?|sigils?|stuff|posters?)$/i;
const CODE = /^[A-Za-z0-9-]{3,40}$/;
const DATE = /\d{4}-\d{2}-\d{2}/;
const OPEN_END = /\bto\s+(indefinite|permanent|never|ongoing|forever)\b/i;

/**
 * A YYYY-MM-DD day as epoch ms at 12:00 UTC, so a Discord date stamp shows the same day in nearly every time zone. Anything that isn't a
 * real calendar day (2026-02-30, junk, undefined) is null. Pure.
 */
export function dayToMs(day: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d, 12);
  const back = new Date(ms);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : null;
}

/** The start and end of a "Dates Active" cell ("2026-07-01 to 2027-05-31", "2026-10-01 to Indefinite", "2026-11-02 to ?", "2025-12-25"). Pure. */
export function parseDates(cell: string): Pick<PromoCode, 'start' | 'end'> {
  const start = /^\s*(\d{4}-\d{2}-\d{2})\b/.exec(cell)?.[1];
  const until = /\bto\s+(\d{4}-\d{2}-\d{2})\b/.exec(cell)?.[1];
  const end = until && dayToMs(until) !== null ? until : OPEN_END.test(cell) ? 'none' : undefined;
  return { ...(start && dayToMs(start) !== null ? { start } : {}), ...(end ? { end } : {}) };
}

/** Adds the dates and sorts newest added first; codes with no known date go last, in the wiki's order. Pure. */
export function datePromoCodes(codes: PromoCode[], firstSeen: ReadonlyMap<string, number | null> = new Map()): DatedPromoCode[] {
  return codes
    .map((c, i) => {
      const seen = firstSeen.get(c.code);
      const dated: DatedPromoCode = {
        ...c,
        added: dayToMs(c.start) ?? (typeof seen === 'number' && Number.isFinite(seen) ? seen : null),
        expires: c.end === 'none' ? 'none' : dayToMs(c.end),
      };
      return { dated, i };
    })
    .sort((a, b) => (b.dated.added ?? -Infinity) - (a.dated.added ?? -Infinity) || a.i - b.i)
    .map(({ dated }) => dated);
}

/** The codes under "Active Codes" in the cleaned page text, whose rows are cells joined with " · " (empty cells are left out). Pure. */
export function parseActiveCodes(text: string, now = Date.now()): PromoCode[] {
  const heading = /^==\s*Active Codes\s*==[ \t]*$/m.exec(text);
  if (!heading) return [];
  const body = text.slice(heading.index + heading[0].length);
  const next = /\n==[^=]/.exec(body);
  const today = new Date(now).toISOString().slice(0, 10);
  const out: PromoCode[] = [];
  for (const line of body.slice(0, next ? next.index : undefined).split('\n')) {
    // From the raw source a cell's items are joined with ", " (see promoTextFromSource), and one that ended a wiki line keeps its comma.
    const cells = line.split(' · ').map((c) => c.trim().replace(/^,\s*|\s*,$/g, '').trim()).filter(Boolean);
    if (cells.length < 2 || cells[0] === 'Code') continue;
    const codes = cells[0]!.split(/[\s,]+/).filter(Boolean);
    if (!codes.every((c) => CODE.test(c)) || TYPE_WORD.test(cells[0]!)) continue;
    const dated = cells.findIndex((c, i) => i > 0 && DATE.test(c));
    const dates = dated >= 0 ? parseDates(cells[dated]!) : {};
    // The wiki can lag behind: a code past its own end date is left out even while it still stands under Active Codes.
    if (dates.end && dates.end !== 'none' && dates.end < today) continue;
    const rewards = dated >= 0 ? cells.slice(dated + 1) : cells.slice(-1);
    const items = (rewards.length ? rewards : [cells[1]!])
      .flatMap((c) => c.split(/,\s+/))
      .map((i) => i.replace(/^Adds\s+/i, '').trim())
      .filter(Boolean);
    const reward = items.join(', ').slice(0, REWARD_MAX);
    for (const code of codes) out.push({ code, reward, items, ...dates });
  }
  return out;
}

/**
 * The page's raw wikitext as text for parseActiveCodes. The wiki puts several rewards (and codes) in one table cell with `<br>` between
 * them, which the wiki index's cleaner turns into a plain space; here each `<br>` becomes ", " first, so the items stay apart. Pure.
 */
export function promoTextFromSource(source: string): string {
  return cleanWikitext(source.replace(/<br\s*\/?>/gi, ', '));
}

const stamp = (ms: number, style: 'D' | 'R'): string => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** The kinds of reward summarizeRewards recognises, each by how an item's name ends. */
const KINDS: { kind: string; plural: string; re: RegExp }[] = [
  { kind: 'display', plural: 'displays', re: /\bdisplay(?:\s+frame)?$/i },
  { kind: 'glyph', plural: 'glyphs', re: /\bglyph$/i },
  { kind: 'decoration', plural: 'decorations', re: /\bdecoration$/i },
  { kind: 'sigil', plural: 'sigils', re: /\bsigil$/i },
  { kind: 'emblem', plural: 'emblems', re: /\bemblem$/i },
  { kind: 'booster', plural: 'boosters', re: /\bbooster$/i },
  { kind: 'skin', plural: 'skins', re: /\bskin$/i },
  { kind: 'syandana', plural: 'syandanas', re: /\bsyandana$/i },
  { kind: 'ephemera', plural: 'ephemeras', re: /\bephemera$/i },
  { kind: 'poster', plural: 'posters', re: /\bposter$/i },
  { kind: 'scene', plural: 'scenes', re: /\bscene$/i },
];
/** Words that name a kind (or are part of one, "Fusion Display", "Display Frame"), never part of the theme. */
const KIND_WORDS = new Set(['frame', 'fusion', ...KINDS.map((k) => k.kind)]);

/**
 * A short line for a code's rewards, by fixed rules (no model): one item is its name; several are counted by kind in the order the kinds
 * first appear, with the words every name shares (the theme, kind words left out) before the first kind: "4 Movember displays",
 * "Pride glyph and 2 displays", "3 Mistletoe Community glyphs". An item of a kind it doesn't know gives all the names joined with ", ".
 * Cut to REWARD_MAX. Pure.
 */
export function summarizeRewards(items: readonly string[]): string {
  const names = items.map((i) => i.trim()).filter(Boolean);
  const cut = (s: string) => s.slice(0, REWARD_MAX);
  if (names.length <= 1) return cut(names[0] ?? '');
  const kinds = names.map((n) => KINDS.find((k) => k.re.test(n)));
  if (kinds.some((k) => !k)) return cut(names.join(', '));
  const counts = new Map<(typeof KINDS)[number], number>();
  for (const k of kinds) counts.set(k!, (counts.get(k!) ?? 0) + 1);
  const words = names.map((n) => new Set(n.toLowerCase().split(/\s+/)));
  const theme = [...new Set(names[0]!.split(/\s+/))]
    .filter((w) => !KIND_WORDS.has(w.toLowerCase()) && words.every((set) => set.has(w.toLowerCase())))
    .join(' ');
  const parts = [...counts].map(([k, n], i) => [n > 1 ? String(n) : '', i === 0 ? theme : '', n > 1 ? k.plural : k.kind].filter(Boolean).join(' '));
  return cut(parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`);
}

/** The expiry part of a code's dates line. Pure. */
export function expiryText(c: DatedPromoCode): string {
  return c.expires === 'none' ? 'no end date' : c.expires === null ? 'expiry unknown' : `ends ${stamp(c.expires, 'D')} (${stamp(c.expires, 'R')})`;
}

/** The dates line under a dated code. Pure. */
export function datesLine(c: DatedPromoCode): string {
  return `📅 ${c.added === null ? 'date unknown' : stamp(c.added, 'D')} · ${expiryText(c)}`;
}

/** A code as a bold link that fills it in on warframe.com, then its rewards. Pure. */
const codeLine = (c: DatedPromoCode): string =>
  `**[${c.code}](${REDEEM_URL}?code=${encodeURIComponent(c.code)})** · ${summarizeRewards(c.items)}`;

/**
 * The message: the dated codes newest first, each with its dates line, then the codes with no known added date under "Older codes",
 * one line each. Pure apart from the brand icon.
 */
export function promoPanel(ctx: AppContext, codes: DatedPromoCode[], now = Date.now()): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  let description = 'Free items: tap a code to redeem it on warframe.com, or enter it in-game under **Market › Redeem Code**.';
  // Whole entries only: a cut never leaves half a line, a broken timestamp or the heading with nothing under it.
  const add = (text: string): boolean => {
    if (description.length + text.length > DESCRIPTION_MAX) return false;
    description += text;
    return true;
  };
  let full = false;
  for (const c of codes.filter((c) => c.added !== null)) {
    if (!add(`\n\n${codeLine(c)}\n-# ${datesLine(c)}`)) {
      full = true;
      break;
    }
  }
  let heading = '\n\n**Older codes**';
  for (const c of full ? [] : codes.filter((c) => c.added === null)) {
    const ends = typeof c.expires === 'number' ? ` · ends ${stamp(c.expires, 'D')}` : '';
    if (!add(`${heading}\n${codeLine(c)}${ends}`)) break;
    heading = '';
  }
  const icon = brandIcon(ctx);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🎟️ Promo codes')
    .setDescription(description)
    .setFooter({ text: `From the Warframe wiki, checked daily · newest first · ${ctx.config.CLAN_NAME}`, ...(icon ? { iconURL: icon } : {}) })
    .setTimestamp(now);
  if (icon) embed.setThumbnail(icon);
  return { embeds: [embed], components: [] };
}

/** Called every minute by the notifier; does its work once a day, or at once when the channel changed. */
export async function updatePromoCodes(ctx: AppContext, now = Date.now()): Promise<void> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).promoChannelId;
  if (!channelId) return;
  const done = `${new Date(now).toISOString().slice(0, 10)}:${channelId}:v${PANEL_VERSION}`;
  if (ctx.store.getMeta(DONE_META) === done || now - (Number(ctx.store.getMeta(TRY_META)) || 0) < RETRY_MS) return;
  // The raw source first (it keeps the items of one cell apart), the local wiki copy when that fails.
  const source = await readWikiSource(PAGE).catch(() => null);
  let codes = source ? parseActiveCodes(promoTextFromSource(source), now) : [];
  if (!codes.length) {
    const page = await readWikiPage(PAGE).catch(() => null);
    codes = page ? parseActiveCodes(page.extract, now) : [];
  }
  if (!codes.length) {
    ctx.store.setMeta(TRY_META, String(now));
    console.warn('[promo] no active codes read from the wiki page; the message stays as it is');
    return;
  }
  const firstSeen = ctx.store.promoFirstSeen(codes.map((c) => c.code), now);
  const payload = promoPanel(ctx, datePromoCodes(codes, firstSeen), now);
  const edited = readLive(ctx, PANEL_META)?.channelId === channelId && (await editLive(ctx, PANEL_META, payload));
  if (!edited) await postLive(ctx, PANEL_META, channelId, payload);
  ctx.store.setMeta(DONE_META, done);
}
