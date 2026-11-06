import { EmbedBuilder } from 'discord.js';
import type { AppContext } from '../context.js';
import { getSendableChannel } from '../services/clan.js';
import { toMs } from '../time.js';
import { apiJson } from '../warframe/fetch.js';
import type { WorldState } from '../warframe/worldstate.js';
import { COLORS, footer } from './style.js';

/**
 * The game news channel (/setup news): new posts from the game's own news (what the in-game news panel shows: updates, hotfixes,
 * Prime Access, Devstreams, read from the world state, no request of its own) and from Warframe's official Steam announcements
 * (Steam's public news API). Each post goes out once (`seen_worldstate` keys `news:...`); a post older than MAX_AGE_MS is never
 * announced, and a new channel (or a source read for the first time) only records what exists, so nothing floods the channel.
 */

const STEAM_APP = 230410;
const STEAM_URL = `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${STEAM_APP}&count=12&maxlength=600&format=json`;
/** Steam is asked at most this often. */
const STEAM_EVERY_MS = 30 * 60_000;
const MAX_AGE_MS = 7 * 86_400_000;
/** Most posts sent in one round; the rest follow on the next minute. */
const MAX_PER_ROUND = 5;
const SEEDED = 'news_seeded';
const STEAM_TRY = 'news_steam_try';

export interface NewsItem {
  key: string;
  source: 'game' | 'steam';
  title: string;
  url: string;
  text: string;
  image: string | null;
  date: number;
  /** Label with its emoji, e.g. "🛠️ Update". */
  tag: string;
}

interface SteamItem {
  gid?: string;
  title?: string;
  url?: string;
  contents?: string;
  date?: number;
  feedname?: string;
}

const normalized = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Steam posts are BBCode: tags and image placeholders come out, whitespace is squeezed, and a tag cut off by the length limit goes too. Pure. */
export function steamText(raw: string, max = 350): string {
  const text = raw
    .replace(/\{STEAM_CLAN_IMAGE\}\S*/g, '')
    .replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, ' ')
    .replace(/\[[^\]]*$/, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const isUpdate = (title: string): boolean => /\b(update|hotfix|patch|hotfixes)\b/i.test(title);

/** The in-game news as items: mobile-only posts are left out. Pure. */
export function gameNews(ws: WorldState | null, now: number): NewsItem[] {
  const out: NewsItem[] = [];
  for (const n of ws?.news ?? []) {
    const date = toMs(n.date);
    const title = n.message?.trim();
    if (!title || !date || n.mobileOnly || now - date > MAX_AGE_MS) continue;
    const url = n.link?.trim() || 'https://www.warframe.com/news';
    out.push({
      key: `news:game:${n.id || url}`,
      source: 'game',
      title,
      url,
      text: '',
      image: n.imageLink && !/placeholder/i.test(n.imageLink) ? n.imageLink : null,
      date,
      tag: n.stream ? '🎬 Devstream' : n.primeAccess ? '💎 Prime Access' : n.update || isUpdate(title) ? '🛠️ Update' : '📰 News',
    });
  }
  return out;
}

/** Warframe's own Steam announcements (not the press articles Steam also lists) as items. Pure. */
export function steamNews(items: SteamItem[], now: number): NewsItem[] {
  const out: NewsItem[] = [];
  for (const s of items) {
    const date = (s.date ?? 0) * 1000;
    const title = s.title?.trim();
    if (!title || !s.url || !date || now - date > MAX_AGE_MS) continue;
    if (s.feedname && s.feedname !== 'steam_community_announcements') continue;
    out.push({
      key: `news:steam:${s.gid ?? s.url}`,
      source: 'steam',
      title,
      url: s.url,
      text: steamText(s.contents ?? ''),
      image: null,
      date,
      tag: isUpdate(title) ? '🛠️ Update (Steam)' : '🕹️ Steam',
    });
  }
  return out;
}

/** A Steam post with the same title as an in-game one is the same news: the in-game one is kept. Pure. */
export function withoutDuplicates(game: NewsItem[], steam: NewsItem[]): NewsItem[] {
  const titles = new Set(game.map((g) => normalized(g.title)));
  return [...game, ...steam.filter((s) => !titles.has(normalized(s.title)))];
}

export function newsEmbed(item: NewsItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(item.tag.startsWith('🎬') ? COLORS.warn : item.tag.startsWith('💎') ? COLORS.success : COLORS.brand)
    .setAuthor({ name: item.tag })
    .setTitle(item.title.slice(0, 256))
    .setURL(item.url)
    .setTimestamp(item.date)
    .setFooter(footer(item.source === 'steam' ? 'Steam announcements' : 'In-game news'));
  if (item.text) embed.setDescription(item.text);
  if (item.image) embed.setImage(item.image);
  return embed;
}

/** Asks Steam for the newest announcements, at most every STEAM_EVERY_MS (or at once with `force`); null when not due or unreadable. */
async function readSteam(ctx: AppContext, now: number, force: boolean): Promise<SteamItem[] | null> {
  if (!force && now - (Number(ctx.store.getMeta(STEAM_TRY)) || 0) < STEAM_EVERY_MS) return null;
  ctx.store.setMeta(STEAM_TRY, String(now));
  try {
    const r = await apiJson<{ appnews?: { newsitems?: SteamItem[] } }>(STEAM_URL, { kind: 'live', ttlMs: STEAM_EVERY_MS - 60_000, background: true });
    return r.data?.appnews?.newsitems ?? null;
  } catch (err) {
    console.warn('[news] could not read the Steam announcements:', (err as Error).message);
    return null;
  }
}

/**
 * Called every minute by the notifier with the world state (null when it is off or unreadable). A source read for the first time for
 * this channel is only recorded; after that every new post is sent once, oldest first.
 */
export async function postNews(ctx: AppContext, ws: WorldState | null, now = Date.now()): Promise<void> {
  const channelId = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).newsChannelId;
  if (!channelId) return;
  const seeded = (source: string): boolean => ctx.store.getMeta(`${SEEDED}:${source}`) === channelId;
  const steamRaw = await readSteam(ctx, now, !seeded('steam'));
  const lists: Record<'game' | 'steam', NewsItem[]> = { game: [], steam: [] };
  for (const [source, items] of [
    ['game', ws ? gameNews(ws, now) : null],
    ['steam', steamRaw ? steamNews(steamRaw, now) : null],
  ] as const) {
    if (!items) continue;
    if (!seeded(source)) {
      for (const i of items) ctx.store.markSeen(i.key);
      ctx.store.setMeta(`${SEEDED}:${source}`, channelId);
      continue;
    }
    lists[source] = items;
  }
  // Marked seen only when sent, so a post beyond MAX_PER_ROUND waits for the next minute instead of being lost.
  const due = withoutDuplicates(lists.game, lists.steam)
    .filter((i) => !ctx.store.hasSeen(i.key))
    .sort((a, b) => a.date - b.date)
    .slice(0, MAX_PER_ROUND);
  if (!due.length) return;
  const channel = await getSendableChannel(ctx, channelId);
  for (const item of due) {
    ctx.store.markSeen(item.key);
    await channel.send({ embeds: [newsEmbed(item)], allowedMentions: { parse: [] } });
  }
}
