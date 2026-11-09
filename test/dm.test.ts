import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { itemLines, priceDm, trackableEmoji, trackerDm } from '../src/discord/dm.js';
import { loadEmojis } from '../src/discord/emoji.js';
import { messageStats } from '../src/discord/feeds/parts.js';
import type { Trackable } from '../src/trackers.js';

const HOUR = 3_600_000;
const arbitration: Trackable = {
  key: 'arbitration:1',
  kind: 'arbitration',
  source: 'arbitration',
  title: 'Arbitration: Defense on Hydron',
  detail: 'Hydron (Sedna) · Grineer',
  expiry: Date.now() + HOUR,
  arbitration: { type: 'Defense', tier: 'S' },
};
const alert: Trackable = {
  key: 'alert:1',
  kind: 'reward',
  source: 'alert',
  title: 'Alert: Survival on Ophelia',
  rewards: ['Forma Blueprint'],
  detail: 'Ophelia (Uranus) · level 20-30',
  expiry: Date.now() + 2 * HOUR,
};
const night: Trackable = { key: 'cycle:cetus', kind: 'cycle', source: 'cycle', title: 'Cetus: Night', detail: 'Cetus is now night', cycle: { cycle: 'cetus', state: 'night' } };

/** Everything a container shows, as one string (the text displays' content and the buttons' labels and links). */
const shown = (c: { toJSON(): unknown }) => JSON.stringify(c.toJSON());

describe('tracker DMs', () => {
  it('lists each tracker with its items, an icon per item and when they end', () => {
    const dm = trackerDm(
      [
        { label: 'Arbitration, S tier · #3', items: [{ item: arbitration, hits: [] }] },
        { label: 'Reward containing "forma" · #4', items: [{ item: alert, hits: ['Forma Blueprint'] }] },
      ],
      'https://cdn.discordapp.com/avatars/1/a.png',
    );
    const text = shown(dm);
    for (const part of ['#3', '#4', 'Arbitration: Defense on Hydron', 'Hydron (Sedna)', 'Forma Blueprint', '`S`', 'cdn.discordapp.com/avatars/1/a.png', '/track list']) {
      assert.ok(text.includes(part), `the DM shows ${part}`);
    }
    assert.match(text, /ends <t:\d+:R>/, 'each item says when it ends');
    const stats = messageStats([dm]);
    assert.ok(stats.text <= 4000 && stats.components <= 40, `inside Discord's limits: ${JSON.stringify(stats)}`);
  });

  it('cuts a keyword that matches a whole stock to six rewards and a count', () => {
    const hits = Array.from({ length: 9 }, (_, i) => `Prime Part ${i + 1}`);
    const lines = itemLines({ ...alert, rewards: hits }, hits);
    assert.ok(lines.includes('Prime Part 6') && !lines.includes('Prime Part 7'));
    assert.ok(lines.includes('+3 more'));
  });

  it('a big round still fits one message', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      label: `Reward containing "prime" · #${i + 1}`,
      items: Array.from({ length: 8 }, (_, j) => ({ item: { ...alert, key: `a${i}:${j}`, title: `Alert ${j} with a long title that goes on`.repeat(2) }, hits: ['Forma Blueprint'] })),
    }));
    const stats = messageStats([trackerDm(many, null)]);
    assert.ok(stats.text <= 4000 && stats.components <= 40, `inside Discord's limits: ${JSON.stringify(stats)}`);
  });

  it('a price alert links to warframe.market with a link button', () => {
    const dm = priceDm({ name: 'Rhino Prime Set', price: 45, below: 50, seller: 'Tenno', url: 'https://warframe.market/items/rhino_prime_set', trackerId: 7 }, null);
    const json = dm.toJSON() as { components: { type: number; components?: { type: number; style?: number; url?: string }[] }[] };
    const button = json.components.flatMap((c) => c.components ?? []).find((c) => c.type === 2);
    assert.equal(button?.style, 5, 'a link button (no interaction needed, so it works in a DM)');
    assert.equal(button?.url, 'https://warframe.market/items/rhino_prime_set');
    const text = shown(dm);
    assert.ok(text.includes('Rhino Prime Set is at 45p') && text.includes('**50p**') && text.includes('Tenno') && text.includes('#7'));
  });

  it('takes the icons from the registry once the emojis are loaded', () => {
    assert.equal(trackableEmoji(night), '🌙');
    assert.equal(trackableEmoji({ ...arbitration, arbitration: { type: 'Defense', tier: null } }), '⚖️', 'no tier: the Arbitration icon');
    loadEmojis([{ id: '111', name: 'wf_tier_s' }, { id: '222', name: 'Arbitration' }]);
    try {
      assert.equal(trackableEmoji(arbitration), '<:wf_tier_s:111>');
      assert.equal(trackableEmoji({ ...arbitration, arbitration: { type: 'Defense', tier: null } }), '<:Arbitration:222>');
    } finally {
      loadEmojis([]);
    }
  });
});
