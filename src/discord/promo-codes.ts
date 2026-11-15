import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { AppContext } from '../context.js';
import { readWikiPage } from '../warframe/wiki.js';
import { COLORS } from './embeds.js';
import { brandIcon } from './identity.js';
import { editLive, postLive, readLive } from './live-message.js';

/**
 * The promo codes channel (/setup promos): one message listing the codes the wiki's "Promo Codes" page has under Active Codes, refreshed
 * once a day from the local wiki copy (no request of its own). bot_meta: `promo_panel` is the message, `promo_updated` the day and channel
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
const PANEL_VERSION = 3;
const DESCRIPTION_MAX = 4000;

export interface PromoCode {
  code: string;
  reward: string;
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
  const start = text.indexOf('== Active Codes ==');
  if (start < 0) return [];
  const end = text.indexOf('\n== ', start + 1);
  const today = new Date(now).toISOString().slice(0, 10);
  const out: PromoCode[] = [];
  for (const line of text.slice(start, end < 0 ? undefined : end).split('\n').slice(1)) {
    const cells = line.split(' · ').map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2 || cells[0] === 'Code') continue;
    const codes = cells[0]!.split(/\s+/);
    if (!codes.every((c) => CODE.test(c)) || TYPE_WORD.test(cells[0]!)) continue;
    const dated = cells.findIndex((c, i) => i > 0 && DATE.test(c));
    const dates = dated >= 0 ? parseDates(cells[dated]!) : {};
    // The wiki can lag behind: a code past its own end date is left out even while it still stands under Active Codes.
    if (dates.end && dates.end !== 'none' && dates.end < today) continue;
    const rewards = dated >= 0 ? cells.slice(dated + 1) : cells.slice(-1);
    const reward = (rewards.join(', ') || cells[1]!).replace(/^Adds\s+/i, '').slice(0, 200);
    for (const code of codes) out.push({ code, reward, ...dates });
  }
  return out;
}

const stamp = (ms: number, style: 'D' | 'R'): string => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** The dates line of one code. Pure. */
export function datesLine(c: DatedPromoCode): string {
  const added = c.added === null ? 'Added: date unknown' : `Added ${stamp(c.added, 'D')}`;
  const expires =
    c.expires === 'none' ? 'no end date' : c.expires === null ? 'no known expiry' : `expires ${stamp(c.expires, 'D')} (${stamp(c.expires, 'R')})`;
  return `${added} · ${expires}`;
}

/** The message: newest code first. Pure apart from the brand icon. */
export function promoPanel(ctx: AppContext, codes: DatedPromoCode[], now = Date.now()): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const intro = 'Free items. In the in-game Market, press **Redeem Code** and type in the code, or use the **Redeem** link here.\n';
  let description = intro;
  for (const c of codes) {
    const entry = `\n**${c.code}** · [Redeem](${REDEEM_URL}?code=${encodeURIComponent(c.code)})\n-# ${c.reward}\n-# ${datesLine(c)}`;
    // Whole entries only: a cut never leaves half a line or a broken timestamp.
    if (description.length + entry.length > DESCRIPTION_MAX) break;
    description += entry;
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
  const page = await readWikiPage(PAGE).catch(() => null);
  const codes = page ? parseActiveCodes(page.extract, now) : [];
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
