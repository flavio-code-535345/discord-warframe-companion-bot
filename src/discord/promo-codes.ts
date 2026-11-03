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
 * layout never blanks the channel.
 */

const PAGE = 'Promo Codes';
const PANEL_META = 'promo_panel';
const DONE_META = 'promo_updated';
const TRY_META = 'promo_try';
/** After a failure the next try is this much later, not on the next minute's tick. */
const RETRY_MS = 3_600_000;
const REDEEM_URL = 'https://warframe.com/promocode';
/** Part of the daily stamp: bump it when the message's wording or layout changes, so the live message is updated at once. */
const PANEL_VERSION = 2;

export interface PromoCode {
  code: string;
  reward: string;
}

/** What a table row starts with when its code cell is empty: then there is no code to show. */
const TYPE_WORD = /^(glyphs?|decorations?|boosters?|displays?|cosmetics?|items?|weapons?|sigils?|stuff|posters?)$/i;
const CODE = /^[A-Za-z0-9-]{3,40}$/;
const DATE = /\d{4}-\d{2}-\d{2}/;

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
    // The wiki can lag behind: a code past its own end date is left out even while it still stands under Active Codes.
    const until = dated >= 0 ? /\bto\s+(\d{4}-\d{2}-\d{2})/.exec(cells[dated]!)?.[1] : undefined;
    if (until && until < today) continue;
    const rewards = dated >= 0 ? cells.slice(dated + 1) : cells.slice(-1);
    const reward = (rewards.join(', ') || cells[1]!).replace(/^Adds\s+/i, '').slice(0, 200);
    for (const code of codes) out.push({ code, reward });
  }
  return out;
}

/** The message. Pure apart from the brand icon. */
export function promoPanel(ctx: AppContext, codes: PromoCode[], now = Date.now()): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const lines = codes.map((c) => `**${c.code}** · [Redeem](${REDEEM_URL}?code=${encodeURIComponent(c.code)})\n-# ${c.reward}`);
  const icon = brandIcon(ctx);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🎟️ Promo codes')
    .setDescription(`Free items. In the in-game Market, press **Redeem Code** and type in the code, or use the **Redeem** link here.\n\n${lines.join('\n')}`.slice(0, 4000))
    .setFooter({ text: `From the Warframe wiki, checked daily · ${ctx.config.CLAN_NAME}`, ...(icon ? { iconURL: icon } : {}) })
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
  const payload = promoPanel(ctx, codes, now);
  const edited = readLive(ctx, PANEL_META)?.channelId === channelId && (await editLive(ctx, PANEL_META, payload));
  if (!edited) await postLive(ctx, PANEL_META, channelId, payload);
  ctx.store.setMeta(DONE_META, done);
}
