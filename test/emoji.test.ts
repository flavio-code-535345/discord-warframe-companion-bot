import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { type EmojiLike, resetEmojiFailures, syncAppEmojis } from '../src/discord/app-emojis.js';
import { e, emojiFor, emojiReport, factionEmoji, loadEmojis, rewardEmoji, shardEmoji, tierEmoji } from '../src/discord/emoji.js';

describe('emoji registry', () => {
  afterEach(() => loadEmojis([]));

  it('writes the custom emoji when it exists and its Unicode stand-in when not', () => {
    loadEmojis([]);
    assert.equal(e('arbitration'), '⚖️');
    assert.deepEqual(emojiFor('arbitration'), { name: '⚖️' });
    loadEmojis([
      { id: '1569033455591891074', name: 'Arbitration', animated: false },
      { id: '1569034853708734535', name: 'IconEnergy', animated: true },
    ]);
    assert.equal(e('arbitration'), '<:Arbitration:1569033455591891074>');
    assert.equal(e('energy'), '<a:IconEnergy:1569034853708734535>');
    assert.deepEqual(emojiFor('arbitration'), { id: '1569033455591891074', name: 'Arbitration', animated: false });
    assert.equal(emojiReport().find((r) => r.name === 'arbitration')!.custom, 'Arbitration');
  });

  it('finds factions, relic tiers, shards and rewards by their names in the world state', () => {
    loadEmojis([
      { id: '1', name: 'wf_grineer' },
      { id: '2', name: 'T4Fissure' },
      { id: '3', name: 'tauemerald' },
      { id: '4', name: 'wf_forma' },
      { id: '5', name: 'kuva' },
    ]);
    assert.equal(factionEmoji('Grineer'), '<:wf_grineer:1>');
    assert.equal(factionEmoji('Corrupted'), '🟡');
    assert.equal(factionEmoji('Crossfire'), '');
    assert.equal(tierEmoji('Axi'), '<:T4Fissure:2>');
    assert.equal(tierEmoji('Omnia'), '🌐');
    assert.equal(shardEmoji('Emerald'), '<:tauemerald:3>');
    assert.equal(rewardEmoji('Forma Blueprint'), '<:wf_forma:4>');
    assert.equal(rewardEmoji('200,000 Kuva'), '<:kuva:5>');
    assert.equal(rewardEmoji('Mutagen Mass'), '');
  });
});

describe('application emoji upload', () => {
  afterEach(() => resetEmojiFailures());

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  function fakeWiki(files: Record<string, string>) {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.includes('api.php')) {
        const titles = new URL(url).searchParams.get('titles')!.split('|');
        // The wiki normalises underscores to spaces and reports it, like the real one does.
        const normalized = titles.filter((t) => t.includes('_')).map((t) => ({ from: t, to: t.replaceAll('_', ' ') }));
        const pages = titles.map((t) => {
          const title = t.replaceAll('_', ' ');
          const thumb = files[title.slice('File:'.length)];
          return thumb ? { title, imageinfo: [{ thumburl: thumb, mime: 'image/png', size: png.length }] } : { title, missing: true };
        });
        return new Response(JSON.stringify({ query: { pages, normalized } }), { headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('.html')) return new Response('<html>', { headers: { 'content-type': 'text/html' } });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    };
    return { fetcher, calls };
  }

  function fakeApp(existing: string[]) {
    const emojis: EmojiLike[] = existing.map((name, i) => ({ id: `e${i}`, name }));
    const created: { name: string; size: number }[] = [];
    return {
      created,
      target: {
        list: async () => [...emojis],
        create: async (name: string, image: Buffer) => {
          created.push({ name, size: image.length });
          const made = { id: `n${created.length}`, name };
          emojis.push(made);
          return made;
        },
      },
    };
  }

  it('uploads only the missing ones, maps normalised titles back, and refuses what is not an image', async () => {
    const wiki = fakeWiki({ 'Forma.png': 'https://wiki/forma.png', 'Icon Grineer.png': 'https://wiki/grineer.png', 'Broken.png': 'https://wiki/broken.html' });
    const app = fakeApp(['wf_aya']);
    const manifest = { wf_aya: 'Aya.png', wf_forma: 'Forma.png', wf_grineer: 'Icon_Grineer.png', wf_broken: 'Broken.png', wf_gone: 'Nothing.png' };
    const res = await syncAppEmojis(app.target, { fetcher: wiki.fetcher, manifest, now: 1 });
    assert.deepEqual(res.created.sort(), ['wf_forma', 'wf_grineer']);
    assert.deepEqual(app.created.map((c) => c.size), [png.length, png.length]);
    assert.deepEqual(res.failed.map((f) => f.name).sort(), ['wf_broken', 'wf_gone']);
    assert.match(res.failed.find((f) => f.name === 'wf_broken')!.reason, /not an image/);
    assert.equal(wiki.calls.filter((u) => u.includes('api.php')).length, 1, 'one lookup for all files');
    assert.equal(res.emojis.length, 3);

    // A failure is not retried within a day; the rest is already there.
    wiki.calls.length = 0;
    const again = await syncAppEmojis(app.target, { fetcher: wiki.fetcher, manifest, now: 2 });
    assert.deepEqual(again.created, []);
    assert.equal(wiki.calls.length, 0);
    const nextDay = await syncAppEmojis(app.target, { fetcher: wiki.fetcher, manifest, now: 2 + 24 * 3_600_000 });
    assert.deepEqual(nextDay.failed.map((f) => f.name).sort(), ['wf_broken', 'wf_gone']);
  });
});
