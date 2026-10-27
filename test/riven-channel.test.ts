import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Collection } from 'discord.js';
import type { AppContext } from "../src/context.js";
import { PNG } from 'pngjs';
import { rivenCompactEmbed } from '../src/discord/riven-embeds.js';
import { Store } from '../src/db.js';
import { screenshotQueue } from '../src/queue.js';
import { handleRivenMessage, scanLog, scanTotals } from '../src/rivens/channel.js';
import { resetRivenFilter, resetRivenLists } from '../src/rivens/market.js';
import { scanCard } from '../src/rivens/scan.js';
import type { OcrLine } from '../src/ssroles/parse.js';
import { api } from '../src/warframe/fetch.js';

const attrs = ['critical_chance', 'critical_damage', 'multishot', 'zoom'].map((slug) => ({ slug, name: slug.split('_').map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') }));
const card = (...texts: string[]): OcrLine[] => texts.map((text, i) => ({ text, x0: 10, y0: 20 + i * 30, x1: 300, y1: 40 + i * 30, confidence: 90 }));
const picture = (() => {
  const p = new PNG({ width: 40, height: 40 });
  p.data.fill(255);
  return PNG.sync.write(p);
})();

const realFetch = globalThis.fetch;
const json = (data: unknown) => new Response(JSON.stringify(data));
const listings = () => [
  ...Array.from({ length: 10 }, () => ({ price: 1500, stats: [['critical_chance', true], ['critical_damage', true], ['multishot', true], ['zoom', false]] as [string, boolean][] })),
  ...Array.from({ length: 10 }, () => ({ price: 60, stats: [['zoom', true], ['multishot', true]] as [string, boolean][] })),
];

beforeEach(() => {
  api.reset();
  api.configure({ limits: { minIntervalMs: 0 } });
  resetRivenLists();
  resetRivenFilter();
  globalThis.fetch = (async (url: string) => {
    const u = new URL(String(url));
    if (u.hostname === 'cdn.test') return new Response(picture);
    if (u.pathname === '/v2/riven/weapons') return json({ data: [{ slug: 'kuva_bramma', i18n: { en: { name: 'Kuva Bramma' } } }] });
    if (u.pathname === '/v2/riven/attributes') return json({ data: attrs.map((a) => ({ slug: a.slug, i18n: { en: { name: a.name } } })) });
    if (u.pathname === '/v1/auctions/search') {
      const want = u.searchParams.get('positive_stats')?.split(',');
      const rows = listings().filter((l) => !want || want.every((w) => l.stats.some(([s, p]) => p && s === w)));
      return json({ payload: { auctions: rows.map((l, i) => ({ id: `a${i}`, buyout_price: l.price, item: { type: 'riven', polarity: 'madurai', re_rolls: 2, attributes: l.stats.map(([url_name, positive]) => ({ url_name, value: 100, positive })) } })) } });
    }
    return new Response('?', { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup(files: { name: string; type: string }[], channelId = 'c') {
  const store = new Store(':memory:');
  store.updateSettings('g', { rivenChannelId: 'c' });
  const replies: { content?: string; embeds?: { data: { title?: string; description?: string } }[]; files?: { name: string; attachment: unknown }[] }[] = [];
  const reactions: string[] = [];
  const message = {
    inGuild: () => true,
    guildId: 'g',
    channelId,
    author: { id: 'u1', username: 'rat', bot: false },
    attachments: new Collection(files.map((f, i) => [String(i), { url: `https://cdn.test/${f.name}`, contentType: f.type, size: 1000 }])),
    reactions: { cache: new Map() },
    react: async (e: string) => void reactions.push(e),
    reply: async (p: (typeof replies)[number]) => void replies.push(p),
  };
  const ctx = { config: { DISCORD_GUILD_ID: 'g', RIVEN_HIGH_PRICE: 1000 }, store, client: { user: { id: 'bot' } } };
  return { ctx, message, replies, reactions };
}

const reads = (...texts: string[]) => (c: AppContext, b: Uint8Array, m: string) => scanCard(c, b, m, async () => card(...texts));

describe('riven channel', () => {
  it('answers a riven screenshot with one short grade card and does not touch the message', async () => {
    const t = setup([{ name: 'a.png', type: 'image/png' }]);
    const before = scanTotals().scans;
    const handled = await handleRivenMessage(t.message as never, t.ctx as never, reads('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage', '+95.3% Multishot', '-42.1% Zoom'));
    assert.equal(handled, true);
    assert.equal(t.replies.length, 1);
    assert.deepEqual(t.replies[0]!.embeds, [], 'the answer is the picture, not an embed');
    const files = t.replies[0]!.files!;
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, 'riven-1.png');
    const png = PNG.sync.read(files[0]!.attachment as Buffer);
    assert.ok(png.width > 400 && png.height > 200, 'the card and the stat panel are drawn side by side');
    assert.equal(t.replies[0]!.content, undefined, 'no chatter around the card');
    assert.deepEqual(screenshotQueue.snapshot(), { running: 0, waiting: 0 });
    assert.equal(scanTotals().scans, before + 1);
    assert.equal(scanLog()[0]!.letter, 'S');
  });

  it('gives a single plain line when the card cannot be read', async () => {
    const t = setup([{ name: 'a.png', type: 'image/png' }]);
    await handleRivenMessage(t.message as never, t.ctx as never, reads('Inventory', 'Mods'));
    const d = t.replies[0]!.embeds![0]!.data.description!;
    assert.match(d, /^❌ Couldn't find the weapon name/);
    assert.ok(d.split('\n').length === 1);
  });

  it('grades a card with one smudged stat line anyway, and marks the interpreted stat with a ?', async () => {
    const t = setup([{ name: 'a.png', type: 'image/png' }]);
    await handleRivenMessage(t.message as never, t.ctx as never, reads('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Cr#t?cal Dam#ge', '+95.3% Multishot'));
    assert.equal(t.replies[0]!.files!.length, 1, 'it is graded (drawn), not refused');
    const r = await scanCard(t.ctx as never, picture, 'image/png', async () => card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Cr#t?cal Dam#ge', '+95.3% Multishot'));
    const d = rivenCompactEmbed(r).data.description!;
    assert.match(d, /\+Critical Damage 112\.5\?/);
    assert.doesNotMatch(d, /Critical Chance 168\.7\?/, 'only the interpreted stat carries the mark');
  });

  it('answers each picture of a message, in one reply', async () => {
    const t = setup([{ name: 'a.png', type: 'image/png' }, { name: 'b.png', type: 'image/png' }]);
    await handleRivenMessage(t.message as never, t.ctx as never, reads('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage'));
    assert.equal(t.replies.length, 1);
    assert.equal(t.replies[0]!.files!.length, 2, 'one picture per riven');
  });

  it('also reads a WebP picture', async () => {
    const t = setup([{ name: 'a.webp', type: 'image/webp' }]);
    const mimes: string[] = [];
    const scan = (ctx: AppContext, bytes: Uint8Array, mime: string) => (mimes.push(mime), reads('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage')(ctx, bytes, 'image/png'));
    assert.equal(await handleRivenMessage(t.message as never, t.ctx as never, scan), true);
    assert.deepEqual(mimes, ['image/webp'], 'the handler hands the WebP to the scanner, which converts it');
    assert.equal(t.replies[0]!.files!.length, 1);
  });

  it('ignores other channels, bots and messages without a PNG/JPEG picture', async () => {
    const other = setup([{ name: 'a.png', type: 'image/png' }], 'elsewhere');
    assert.equal(await handleRivenMessage(other.message as never, other.ctx as never, reads('x')), false);
    const text = setup([{ name: 'a.gif', type: 'image/gif' }]);
    assert.equal(await handleRivenMessage(text.message as never, text.ctx as never, reads('x')), false);
    const none = setup([]);
    assert.equal(await handleRivenMessage(none.message as never, none.ctx as never, reads('x')), false);
    const bot = setup([{ name: 'a.png', type: 'image/png' }]);
    (bot.message.author as { bot: boolean }).bot = true;
    assert.equal(await handleRivenMessage(bot.message as never, bot.ctx as never, reads('x')), false);
    const off = setup([{ name: 'a.png', type: 'image/png' }]);
    off.ctx.store.updateSettings('g', { rivenChannelId: null });
    assert.equal(await handleRivenMessage(off.message as never, off.ctx as never, reads('x')), false);
    assert.equal(other.replies.length + text.replies.length + none.replies.length + bot.replies.length + off.replies.length, 0);
  });

  it('tells a member whose rivens are already waiting, without reading anything', async () => {
    const t = setup([{ name: 'a.png', type: 'image/png' }]);
    const held = [screenshotQueue.join('u1'), screenshotQueue.join('u1')];
    await handleRivenMessage(t.message as never, t.ctx as never, reads('x'));
    assert.match(t.replies[0]!.content!, /already waiting/);
    held.forEach((h) => h.release());
  });
});

describe('compact riven card', () => {
  it('says there are too few listings instead of inventing a grade', async () => {
    const r = await scanCard({ store: new Store(':memory:'), config: { RIVEN_HIGH_PRICE: 1000 } } as never, picture, 'image/png', async () => card('Kuva Bramma Crita-lexitis', '+168.7% Critical Chance', '+112.5% Critical Damage'));
    const embed = rivenCompactEmbed({ ...r, report: r.report && { ...r.report, grade: null } });
    assert.match(embed.data.description!, /Not enough listings to grade/);
  });
});
