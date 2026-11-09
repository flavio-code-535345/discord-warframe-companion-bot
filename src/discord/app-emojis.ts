import type { AppContext } from '../context.js';
import { cycleIcon, omniaIcon, tierBadge } from '../imaging/badges.js';
import type { ArbyTier } from '../warframe/arbitrations.js';
import { apiFetch } from '../warframe/fetch.js';
import { loadEmojis } from './emoji.js';
import { TIER_COLOR } from './feeds/arbitrations.js';

/** A wiki file name, or a picture Ordis draws itself (src/imaging/badges.ts) when the wiki has none. */
export type EmojiSource = string | (() => Promise<Buffer>);

const badge = (tier: ArbyTier) => () => tierBadge(tier, `#${TIER_COLOR[tier].toString(16).padStart(6, '0')}`);

/**
 * Ordis's own emojis: application emojis (up to 2000, usable in every channel and DM, and not counted against the clan server's
 * 50 slots), from the Warframe wiki's icons or drawn by Ordis. Each one is uploaded once; one that fails (an icon the wiki doesn't have)
 * is tried again a day later, and until then src/discord/emoji.ts shows its Unicode stand-in.
 */
export const APP_EMOJIS: Record<string, EmojiSource> = {
  wf_grineer: 'IconGrineerOn(xWhite).png',
  wf_corpus: 'IconCorpusOn(xWhite).png',
  wf_infested: 'IconInfestedOn(xWhite).png',
  wf_orokin: 'IconOrokinOn(xWhite).png',
  wf_sentient: 'SentientFactionIcon(xWhite).png',
  wf_narmer: 'IconNarmer(xWhite).png',
  wf_murmur: 'MurmurIcon(xWhite).png',
  wf_scaldra: 'ScaldraIcon(xWhite).png',
  wf_techrot: 'TechrotIcon(xWhite).png',
  wf_anarchs: 'IconAnarchs(xWhite).png',
  wf_railjack: 'IconRailjack(xWhite).png',
  wf_invasion: 'InvasionIcon(xWhite).png',
  wf_nightwave: 'NightwaveSyndicate(xLight).png',
  wf_bounty: 'BountiesPoE(xWhite).png',
  wf_lotus: 'LotusEmoji.png',
  wf_steel_essence: 'SteelEssence.png',
  wf_catalyst: 'OrokinCatalyst.png',
  wf_reactor: 'OrokinReactor.png',
  wf_forma: 'Forma.png',
  wf_exilus: 'ExilusWarframeAdapter.png',
  wf_nitain: 'NitainExtract.png',
  wf_aya: 'Aya.png',
  wf_regal_aya: 'RegalAya.png',
  wf_requiem: 'RequiemRelicIntact.png',
  wf_baro: 'BaroEmoji.png',
  wf_darvo: 'Darvo.png',
  wf_teshin: 'Teshin.png',
  wf_varzia: 'Varzia.png',
  // Drawn: the wiki has no Arbitration tier badges, no Omnia fissure icon and no plain day/night icon.
  wf_tier_s: badge('S'),
  wf_tier_a: badge('A'),
  wf_tier_b: badge('B'),
  wf_tier_c: badge('C'),
  wf_tier_d: badge('D'),
  wf_tier_f: badge('F'),
  wf_omnia: omniaIcon,
  wf_cycle: cycleIcon,
};

const WIKI_API = 'https://wiki.warframe.com/api.php';
/** Discord refuses emoji images over 256 KB. */
const MAX_BYTES = 256 * 1024;
const RETRY_MS = 24 * 3_600_000;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

export interface EmojiLike {
  id: string;
  name: string | null;
  animated?: boolean | null;
}

/** The application's emoji list as the sync needs it (the real one is client.application.emojis). */
export interface AppEmojiTarget {
  list(): Promise<EmojiLike[]>;
  create(name: string, image: Buffer): Promise<EmojiLike>;
}

type Fetcher = (url: string) => Promise<Response>;
const background: Fetcher = (url) => apiFetch(url, {}, { background: true });

interface WikiImagePage {
  title: string;
  missing?: boolean;
  imageinfo?: { url?: string; thumburl?: string; mime?: string; size?: number }[];
}

/** When each emoji was last tried and failed, so a missing wiki file is not looked up every half hour. */
const failedAt = new Map<string, number>();

export interface SyncResult {
  created: string[];
  failed: { name: string; reason: string }[];
  /** Every application emoji after the sync. */
  emojis: EmojiLike[];
}

/** Uploads the manifest's emojis that the application doesn't have yet. */
export async function syncAppEmojis(
  target: AppEmojiTarget,
  opts: { fetcher?: Fetcher; manifest?: Record<string, EmojiSource>; now?: number; existing?: EmojiLike[] } = {},
): Promise<SyncResult> {
  const fetcher = opts.fetcher ?? background;
  const manifest = opts.manifest ?? APP_EMOJIS;
  const now = opts.now ?? Date.now();
  const emojis = [...(opts.existing ?? (await target.list()))];
  const have = new Set(emojis.map((e) => e.name));
  const wanted = Object.entries(manifest).filter(([name]) => !have.has(name) && now - (failedAt.get(name) ?? -Infinity) >= RETRY_MS);
  const result: SyncResult = { created: [], failed: [], emojis };
  if (!wanted.length) return result;
  const fail = (name: string, reason: string) => {
    failedAt.set(name, now);
    result.failed.push({ name, reason });
  };
  const upload = async (name: string, image: Buffer) => {
    if (image.length > MAX_BYTES) throw new Error(`${Math.round(image.length / 1024)} KB is over Discord's 256 KB`);
    result.emojis.push(await target.create(name, image));
    result.created.push(name);
  };
  const fromWiki = wanted.filter((w): w is [string, string] => typeof w[1] === 'string');

  // One request finds the thumbnails of up to 50 files; the wiki answers with normalised titles, mapped back here.
  const urls = new Map<string, string>();
  for (let i = 0; i < fromWiki.length; i += 50) {
    const batch = fromWiki.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      redirects: '1',
      prop: 'imageinfo',
      iiprop: 'url|mime|size',
      iiurlwidth: '128',
      titles: batch.map(([, file]) => `File:${file}`).join('|'),
    });
    try {
      const res = await fetcher(`${WIKI_API}?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { query?: { pages?: WikiImagePage[]; normalized?: { from: string; to: string }[]; redirects?: { from: string; to: string }[] } };
      const rename = new Map<string, string>();
      for (const n of [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])]) rename.set(n.from, n.to);
      const final = (title: string) => {
        let t = title;
        for (let hops = 0; rename.has(t) && hops < 3; hops++) t = rename.get(t)!;
        return t;
      };
      const byTitle = new Map((data.query?.pages ?? []).map((p) => [p.title, p]));
      for (const [name, file] of batch) {
        const info = byTitle.get(final(`File:${file}`))?.imageinfo?.[0];
        const url = info?.thumburl ?? info?.url;
        if (url) urls.set(name, url);
        else fail(name, `the wiki has no file ${file}`);
      }
    } catch (err) {
      for (const [name] of batch) fail(name, `wiki lookup failed: ${(err as Error).message}`);
    }
  }

  for (const [name, url] of urls) {
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (!IMAGE_TYPES.test(type)) throw new Error(`not an image (${type || 'no type'})`);
      await upload(name, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      fail(name, (err as Error).message);
    }
  }
  for (const [name, source] of wanted) {
    if (typeof source === 'string') continue;
    try {
      await upload(name, await source());
    } catch (err) {
      fail(name, `drawing or upload failed: ${(err as Error).message}`);
    }
  }
  return result;
}

/** What the last refresh found, for the health check. */
let lastRefresh: { at: number; known: number; created: string[]; failed: { name: string; reason: string }[] } | null = null;
export const emojiStatus = () => lastRefresh;

/** Uploads what is missing, then reloads the registry from the clan server's and the application's emojis. */
export async function refreshEmojis(ctx: AppContext): Promise<void> {
  const app = ctx.client.application;
  const guild = ctx.client.guilds.cache.get(ctx.config.DISCORD_GUILD_ID);
  const plain = (e: EmojiLike): EmojiLike => ({ id: e.id, name: e.name, animated: e.animated });
  const guildEmojis = guild ? [...(await guild.emojis.fetch()).values()].map(plain) : [];
  const target: AppEmojiTarget | null = app
    ? {
        list: async () => [...(await app.emojis.fetch()).values()].map(plain),
        create: async (name, image) => plain(await app.emojis.create({ attachment: image, name })),
      }
    : null;
  const existing = target ? await target.list() : [];
  // The server's own emojis win (staff chose them). The registry is filled before anything is uploaded, so what is drawn meanwhile
  // already uses every emoji that exists.
  loadEmojis([...existing, ...guildEmojis]);
  let sync: SyncResult = { created: [], failed: [], emojis: existing };
  if (target) {
    sync = await syncAppEmojis(target, { existing });
    if (sync.created.length) console.log(`[emoji] uploaded ${sync.created.length} application emojis: ${sync.created.join(', ')}`);
    for (const f of sync.failed) console.warn(`[emoji] could not upload ${f.name}: ${f.reason}`);
  }
  const known = loadEmojis([...sync.emojis, ...guildEmojis]);
  lastRefresh = { at: Date.now(), known, created: sync.created, failed: sync.failed };
}

/** Test hook: forget earlier failures. */
export const resetEmojiFailures = () => failedAt.clear();
