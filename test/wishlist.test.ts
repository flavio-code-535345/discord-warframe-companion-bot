import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { AutocompleteInteraction, ChatInputCommandInteraction, Client, StringSelectMenuInteraction } from 'discord.js';
import { SHARES, forgetToken } from '../src/alecaframe/api.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { wishlist } from '../src/discord/commands/wishlist.js';
import { EMOJI, loadEmojis } from '../src/discord/emoji.js';
import { componentText, messageStats } from '../src/discord/feeds/parts.js';
import { watchVault } from '../src/discord/vault-watch.js';
import { UserError } from '../src/errors.js';
import { api } from '../src/warframe/fetch.js';
import { type RelicBook, type WfinfoPrice, type WfinfoTable, buildRelicBook, findSet, resetRelicBook } from '../src/warframe/relics.js';
import { type WorldState, configureWorldState } from '../src/warframe/worldstate.js';
import { MAX_WISHES, inRelics, varziaOffer, wishPlan } from '../src/wishlist/plan.js';
import { type WishView, handleWishSelect, notifyWishlistVarzia, notifyWishlistVault, offerText, varziaDm, vaultDm, wishCard, wishChoices, wishListCard } from '../src/wishlist/service.js';

const GUILD = '111111111111111111';
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 12);
const UNTIL = Date.UTC(2026, 10, 26, 19);
const rel = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

/** WFInfo's tables, cut down to a Warframe whose relics are mostly vaulted, a weapon that drops, and a weapon made of two others. */
const TABLE: WfinfoTable = {
  relics: {
    Lith: {
      S14: { vaulted: false, rare1: 'Saryn Prime Neuroptics', uncommon1: 'Strun Prime Barrel', uncommon2: 'Forma Blueprint', common1: 'Bronco Prime Barrel', common2: 'Akbronco Prime Link', common3: 'Strun Prime Stock' },
      N9: { vaulted: true, rare1: 'Strun Prime Receiver', uncommon1: 'Saryn Prime Chassis', uncommon2: 'Forma Blueprint', common1: 'Bronco Prime Barrel', common2: 'Strun Prime Stock', common3: 'Forma Blueprint' },
    },
    Meso: {
      S3: { vaulted: true, rare1: 'Saryn Prime Systems', uncommon1: 'Saryn Prime Chassis', uncommon2: 'Forma Blueprint', common1: 'Bronco Prime Receiver', common2: 'Strun Prime Stock', common3: 'Forma Blueprint' },
    },
    Neo: {
      S5: { vaulted: false, rare1: 'Akbronco Prime Blueprint', uncommon1: 'Saryn Prime Chassis', uncommon2: 'Bronco Prime Receiver', common1: 'Saryn Prime Blueprint', common2: 'Strun Prime Stock', common3: 'Forma Blueprint' },
    },
    Axi: {
      S3: { vaulted: true, rare1: 'Saryn Prime Systems', uncommon1: 'Strun Prime Barrel', uncommon2: 'Forma Blueprint', common1: 'Bronco Prime Blueprint', common2: 'Strun Prime Stock', common3: 'Forma Blueprint' },
    },
  },
  eqmt: {
    'Saryn Prime': {
      type: 'Warframes',
      vaulted: true,
      parts: { 'Saryn Prime Blueprint': { count: 1, ducats: 15 }, 'Saryn Prime Chassis': { count: 1, ducats: 45 }, 'Saryn Prime Neuroptics': { count: 1, ducats: 100 }, 'Saryn Prime Systems': { count: 1, ducats: 100 } },
    },
    'Strun Prime': { type: 'Primary', vaulted: false, parts: { 'Strun Prime Barrel': { count: 1, ducats: 45 }, 'Strun Prime Receiver': { count: 1, ducats: 100 }, 'Strun Prime Stock': { count: 1, ducats: 15 } } },
    'Bronco Prime': { type: 'Secondary', vaulted: false, parts: { 'Bronco Prime Blueprint': { count: 1, ducats: 15 }, 'Bronco Prime Barrel': { count: 1, ducats: 15 }, 'Bronco Prime Receiver': { count: 1, ducats: 15 } } },
    'Akbronco Prime': { type: 'Secondary', vaulted: false, parts: { 'Akbronco Prime Blueprint': { count: 1, ducats: 100 }, 'Akbronco Prime Link': { count: 1, ducats: 15 }, 'Bronco Prime': { count: 2 } } },
    // Never in a relic: nothing to collect.
    'Excalibur Prime': { type: 'Warframes', vaulted: true, parts: { 'Excalibur Prime Blueprint': { count: 1 } } },
  },
  ignored_items: { 'Forma Blueprint': {} },
};

const PRICES: WfinfoPrice[] = [
  { name: 'Saryn Prime Set', custom_avg: 85 },
  { name: 'Saryn Prime Blueprint', custom_avg: 5 },
  { name: 'Saryn Prime Chassis Blueprint', custom_avg: 10 },
  { name: 'Saryn Prime Neuroptics Blueprint', custom_avg: 25 },
  { name: 'Saryn Prime Systems Blueprint', custom_avg: 40 },
  { name: 'Strun Prime Set', custom_avg: 30 },
  { name: 'Strun Prime Barrel', custom_avg: 4 },
  { name: 'Strun Prime Receiver', custom_avg: 12.5 },
  { name: 'Bronco Prime Set', custom_avg: 12 },
  { name: 'Bronco Prime Blueprint', custom_avg: 3 },
  { name: 'Bronco Prime Barrel', custom_avg: 2 },
  { name: 'Bronco Prime Receiver', custom_avg: 2 },
  { name: 'Akbronco Prime Set', custom_avg: 40 },
  { name: 'Akbronco Prime Blueprint', custom_avg: 15 },
  { name: 'Akbronco Prime Link', custom_avg: 6 },
];

const book: RelicBook = buildRelicBook(TABLE, PRICES, NOW, false);
const set = (name: string) => findSet(book, name)!;

/** Varzia's stock as the feed names it. */
const varzia = (over: Record<string, unknown> = {}) =>
  ({
    vaultTrader: {
      location: "Maroo's Bazaar (Mars)",
      activation: new Date(NOW - DAY).toISOString(),
      expiry: new Date(UNTIL).toISOString(),
      inventory: [
        'M P V Nidus Prime Single Pack',
        'M P V Nidus Saryn Prime Dual Pack',
        'M P V Saryn Prime Single Pack',
        'M P V Prime Strun Weapon',
        'M P V Prime Magnus Weapon',
        'M P V Saryn Prime Bobble Head',
        'M P V Prime Access Sigil Saryn',
        'T1 Void Projection Nidus Saryn Vault A Bronze',
        'T2 Void Projection Nidus Saryn Vault A Bronze',
        'T2 Void Projection Nidus Saryn Vault B Bronze',
        'T4 Void Projection Nidus Saryn Vault A Bronze',
      ].map((item) => ({ item, ducats: 1, credits: 0 })),
      ...over,
    },
  }) as unknown as WorldState;

const OWNED = [
  { tier: 'Neo', code: 'S5', refinement: 'Intact', count: 2 },
  { tier: 'Neo', code: 'S5', refinement: 'Radiant', count: 1 },
  { tier: 'Axi', code: 'S3', refinement: 'Flawless', count: 1 },
  { tier: 'Lith', code: 'B1', refinement: 'Intact', count: 4 },
  { tier: 'Requiem', code: 'IV', refinement: 'Intact', count: 3 },
] as const;

describe('a wished set, reckoned', () => {
  it('says what is missing, what it costs and which relics hold it, the ones that still drop first', () => {
    const plan = wishPlan(book, set('Saryn Prime'), ['saryn prime blueprint'], null);
    assert.deepEqual(plan.missing.map((p) => p.name), ['Saryn Prime Chassis', 'Saryn Prime Neuroptics', 'Saryn Prime Systems']);
    assert.equal(plan.missingPlat, 75);
    assert.equal(plan.unpriced, 0);
    assert.equal(plan.ownedRelics, null, 'nothing is said about relics that are not known');
    const chassis = plan.parts.find((p) => p.name === 'Saryn Prime Chassis')!;
    assert.deepEqual(chassis.relics.map((r) => `${r.name}${r.vaulted ? ' (vaulted)' : ''} ${r.rarity}`), ['Neo S5 Uncommon', 'Lith N9 (vaulted) Uncommon', 'Meso S3 (vaulted) Uncommon']);
    assert.equal(plan.parts.find((p) => p.name === 'Saryn Prime Blueprint')!.have, true);
    assert.equal(wishPlan(book, set('saryn'), [], null).missing.length, 4);
  });

  it('counts the relics a member owns that hold a part they still need', () => {
    const plan = wishPlan(book, set('Saryn Prime'), ['Saryn Prime Blueprint'], OWNED);
    assert.equal(plan.ownedRelics, 4, 'three Neo S5 for the chassis and one Axi S3 for the systems');
    const chassis = plan.parts.find((p) => p.name === 'Saryn Prime Chassis')!;
    assert.deepEqual(chassis.relics[0]!.owned, [{ refinement: 'Radiant', count: 1 }, { refinement: 'Intact', count: 2 }], 'the most refined first');
    assert.deepEqual(chassis.relics[1]!.owned, []);

    // With the chassis ticked, Neo S5 holds nothing they need any more.
    assert.equal(wishPlan(book, set('Saryn Prime'), ['Saryn Prime Blueprint', 'Saryn Prime Chassis'], OWNED).ownedRelics, 1);
    assert.equal(wishPlan(book, set('Saryn Prime'), [], []).ownedRelics, 0, 'an inventory without relics is known to hold none');
  });

  it('prices a part the set needs twice twice, and a weapon that is a part as that weapon', () => {
    const plan = wishPlan(book, set('Akbronco Prime'), [], null);
    const bronco = plan.parts.find((p) => p.name === 'Bronco Prime')!;
    assert.deepEqual({ count: bronco.count, plat: bronco.plat, ownSet: bronco.ownSet, relics: bronco.relics.length }, { count: 2, plat: 12, ownSet: true, relics: 0 });
    assert.equal(plan.missingPlat, 15 + 6 + 2 * 12);

    const strun = wishPlan(book, set('Strun Prime'), [], null);
    assert.equal(strun.missingPlat, 16.5);
    assert.equal(strun.unpriced, 1, 'the stock has no price');
    assert.ok(inRelics(set('Strun Prime')));
    assert.ok(!inRelics(set('Excalibur Prime')));
  });

  it('knows when Varzia sells the set: itself, a pack with it, the relics of its resurgence', () => {
    assert.deepEqual(varziaOffer('Saryn Prime', varzia(), NOW), {
      items: ['Nidus Saryn Prime Dual Pack', 'Saryn Prime Single Pack', 'Lith relic · Nidus Saryn A', 'Meso relic · Nidus Saryn A', 'Meso relic · Nidus Saryn B', 'Axi relic · Nidus Saryn A'],
      until: UNTIL,
    });
    assert.deepEqual(varziaOffer('Nidus Prime', varzia(), NOW)!.items.slice(0, 2), ['Nidus Prime Single Pack', 'Nidus Saryn Prime Dual Pack']);
    assert.deepEqual(varziaOffer('strun prime', varzia(), NOW)!.items, ['Strun Prime'], 'a weapon is sold under its own name');
    assert.equal(varziaOffer('Mag Prime', varzia(), NOW), null, 'Magnus Prime is not Mag Prime');
    assert.equal(varziaOffer('Bronco Prime', varzia(), NOW), null);
    assert.equal(varziaOffer('Saryn Prime', varzia(), UNTIL + 1), null, 'she has left');
    assert.equal(varziaOffer('Saryn Prime', varzia({ inventory: [] }), NOW), null);
    assert.equal(varziaOffer('Saryn Prime', null, NOW), null);
    assert.equal(varziaOffer('Saryn Prime', {} as WorldState, NOW), null);
    assert.equal(varziaOffer('Prime', varzia(), NOW), null, 'a name that is only "Prime" matches nothing');
    // A name with characters that mean something in a pattern is only a name.
    assert.equal(varziaOffer('Silva & Aegis (x) Prime', varzia(), NOW), null);

    assert.equal(offerText(varziaOffer('Saryn Prime', varzia(), NOW)!.items), 'Nidus Saryn Prime Dual Pack, Saryn Prime Single Pack · relics of the Nidus Saryn vault: Lith A · Meso A, B · Axi A');
    assert.equal(offerText(['Strun Prime']), 'Strun Prime');
  });
});

describe('the wishlist in the database', () => {
  it('keeps one entry per set and member, whatever the case, with the parts they have', () => {
    const store = new Store(':memory:');
    const first = store.addWish(GUILD, 'u1', 'Saryn Prime', NOW);
    assert.deepEqual(first, { id: first.id, guildId: GUILD, userId: 'u1', item: 'Saryn Prime', have: [], createdAt: NOW });
    assert.equal(store.addWish(GUILD, 'u1', 'saryn prime').id, first.id, 'the same set again is the same entry');
    const strun = store.addWish(GUILD, 'u1', 'Strun Prime');
    const other = store.addWish(GUILD, 'u2', 'Saryn Prime');
    assert.deepEqual(store.listWishes(GUILD, 'u1').map((w) => w.item), ['Saryn Prime', 'Strun Prime']);
    assert.equal(store.listWishes(GUILD).length, 3);
    assert.equal(store.listWishes('222222222222222222').length, 0);

    store.setWishHave(first.id, ['Saryn Prime Blueprint', 'Saryn Prime Chassis']);
    assert.deepEqual(store.getWish(first.id)!.have, ['Saryn Prime Blueprint', 'Saryn Prime Chassis']);
    store.db.prepare("UPDATE wishlist SET have = '{broken' WHERE id = ?").run(strun.id);
    assert.deepEqual(store.getWish(strun.id)!.have, [], 'a list that cannot be read is an empty one');

    assert.equal(store.removeWish(GUILD, 'u1', other.id), false, "someone else's entry stays");
    assert.equal(store.removeWish(GUILD, 'u2', other.id), true);
    assert.equal(store.getWish(other.id), null);
  });

  it('comes with migration 40 to a database from before', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ordis-wish-'));
    try {
      const path = join(dir, 'bot.db');
      const old = new Store(path, { migrateTo: 39 });
      assert.throws(() => old.listWishes(GUILD), /no such table/);
      old.createTracker(GUILD, 'u1', '{"kind":"baro"}');
      old.db.close();
      const store = new Store(path);
      assert.equal(store.addWish(GUILD, 'u1', 'Saryn Prime').item, 'Saryn Prime');
      assert.equal(store.listTrackers(GUILD, 'u1').length, 1, 'what was there stays');
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const view = (name: string, over: Partial<WishView> & { have?: string[]; owned?: typeof OWNED | null } = {}): WishView => {
  const { have = [], owned = null, ...rest } = over;
  const s = set(name);
  return {
    plan: wishPlan(book, s, have, owned),
    wish: { id: 7, guildId: GUILD, userId: 'u1', item: s.name, have, createdAt: NOW },
    varzia: null,
    access: owned ? 'ok' : 'unlinked',
    stale: false,
    ...rest,
  };
};
const text = (v: WishView, note?: string) => componentText([wishCard(v, note)]);

describe('the wishlist cards', () => {
  it('show a set: what is missing with prices and relics, what the member owns and has, and the menu to tick parts', () => {
    const t = text(view('Saryn Prime', { have: ['Saryn Prime Blueprint'], owned: OWNED, varzia: varziaOffer('Saryn Prime', varzia(), NOW) }), '✅ Added to your wishlist (1/20).');
    assert.match(t, /^## 🔮 Saryn Prime\n-# Warframe · 🔒 vaulted: its relics no longer drop · the set trades for about 85p\n✅ Added to your wishlist \(1\/20\)\.\n/);
    assert.ok(t.includes(`🏺 **Varzia sells it** until <t:${UNTIL / 1000}:D> (${rel(UNTIL)}): Nidus Saryn Prime Dual Pack, Saryn Prime Single Pack · relics of the Nidus Saryn vault: Lith A · Meso A, B · Axi A`), t);
    assert.ok(t.includes('**Still needed** · 3 of 4 parts · about **75p** on the market'));
    assert.ok(t.includes('**Saryn Prime Chassis** · 10p · 45 🪙\n-# Uncommon in **Neo S5**, Lith N9 🔒, Meso S3 🔒\n-# 🔮 You own Neo S5 Radiant ×1, Neo S5 ×2'), t);
    assert.ok(t.includes('**Saryn Prime Neuroptics** · 25p · 100 🪙\n-# Rare in **Lith S14**\n**Saryn Prime Systems**'), 'no "you own" line for a part whose relics the member lacks');
    assert.ok(t.includes('**Saryn Prime Systems** · 40p · 100 🪙\n-# Rare in Meso S3 🔒, Axi S3 🔒\n-# 🔮 You own Axi S3 Flawless ×1'));
    assert.ok(t.includes('✅ **Already have:** Saryn Prime Blueprint'));
    assert.ok(t.includes('[✅ Tick the parts you already have…]'));
    assert.match(t, /-# Prices are WFInfo's averages from warframe\.market · 🔒 no longer drops\. Ordis DMs you when Varzia sells this set and when it leaves or re-enters the drop tables\.$/);
    assert.ok(!t.includes('Link AlecaFrame') && !t.includes('Not on your wishlist'));

    const menu = JSON.stringify(wishCard(view('Saryn Prime', { have: ['Saryn Prime Blueprint'] })).toJSON());
    assert.ok(menu.includes('"custom_id":"wish:have:7"'), 'the menu carries the entry it changes');
    assert.ok(menu.includes('"min_values":0') && menu.includes('"max_values":4'), 'every part can be ticked, and none');
    assert.match(menu, /"label":"Saryn Prime Blueprint","value":"Saryn Prime Blueprint","default":true/);
    assert.match(menu, /"label":"Saryn Prime Chassis","value":"Saryn Prime Chassis","default":false/);
  });

  it('say why the relics a member owns are not marked', () => {
    assert.ok(text(view('Saryn Prime')).includes('-# Link AlecaFrame with `/alecaframe link` (tick **Relics**) and Ordis marks the relics you own.'));
    assert.ok(text(view('Saryn Prime', { access: 'unshared' })).includes('does not share your relics'));
    assert.ok(text(view('Saryn Prime', { access: 'unreadable' })).includes('could not be read just now'));
    assert.ok(text(view('Strun Prime', { owned: [{ tier: 'Lith', code: 'B1', refinement: 'Intact', count: 4 }] as never })).includes('-# You own none of the relics that hold a missing part.'));
    assert.ok(text(view('Saryn Prime', { stale: true })).includes("warframe.market (cached)"));
  });

  it('show a part that is a weapon of its own, a part without a price, and a set that is complete', () => {
    const ak = text(view('Akbronco Prime'));
    assert.ok(ak.includes('-# Secondary · its relics drop now · the set trades for about 40p'));
    assert.ok(ak.includes('**2× Bronco Prime** · 12p each\n-# A weapon of its own, built from its own parts: `/wishlist show item:Bronco Prime`'), ak);
    assert.ok(ak.includes('**Still needed** · 3 of 3 parts · about **45p** on the market'));

    const strun = text(view('Strun Prime'));
    assert.ok(strun.includes('about **17p** on the market (1 part without a price)'), strun);
    assert.ok(strun.includes('**Strun Prime Stock** · 15 🪙\n-# Common in **Lith S14**, **Neo S5**, Lith N9 🔒, Meso S3 🔒, Axi S3 🔒'), strun);

    const all = set('Saryn Prime').parts.map((p) => p.name);
    const done = text(view('Saryn Prime', { have: all }));
    assert.ok(done.includes('🎉 **You have every part.** Build it, then take it off the list with `/wishlist remove`.'));
    assert.ok(!done.includes('Still needed') && !done.includes('Already have'));
    assert.ok(done.includes('[✅ Tick the parts you already have…]'), 'a tick can still be taken back');
  });

  it('show a set that is only looked at without the menu', () => {
    const t = text(view('Strun Prime', { wish: null }));
    assert.ok(!t.includes('Tick the parts'));
    assert.match(t, /-# Not on your wishlist: `\/wishlist add` puts it there\.$/);
    assert.ok(!t.includes('Ordis DMs you'));
  });

  it('list a member\'s sets in a line or two each', () => {
    const t = componentText([
      wishListCard(
        [
          view('Saryn Prime', { have: ['Saryn Prime Blueprint'], owned: OWNED, varzia: varziaOffer('Saryn Prime', varzia(), NOW) }),
          view('Strun Prime', { owned: OWNED }),
          view('Bronco Prime', { owned: OWNED, have: set('Bronco Prime').parts.map((p) => p.name) }),
        ],
        ['Gone Prime'],
      ),
    ]);
    assert.match(t, /^## 🔮 Your prime wishlist · 4\/20\n/);
    assert.ok(t.includes(`**Saryn Prime** · 🔒 vaulted · 3 of 4 parts missing · about 75p\n-# you own 4 relics that hold a missing part · 🏺 Varzia sells it until ${rel(UNTIL)}`), t);
    assert.ok(t.includes('**Strun Prime** · drops now · 3 of 3 parts missing · about 17p\n-# you own 4 relics that hold a missing part'), t);
    assert.ok(t.includes('**Bronco Prime** · drops now · 🎉 complete\n**Gone Prime** · not in the relic tables right now'));
    assert.ok(t.includes('`/wishlist show` lists a set\'s missing parts'));

    const empty = componentText([wishListCard([])]);
    assert.match(empty, /Your prime wishlist · 0\/20\nNothing on it yet\. `\/wishlist add` takes a prime set/);
    assert.ok(componentText([wishListCard([view('Saryn Prime')])]).includes('Link AlecaFrame'));
  });

  describe('with every custom emoji in use', () => {
    const everyEmoji = () => [...new Set(Object.values(EMOJI).flatMap((d) => [...d.names]))].map((name, i) => ({ id: String(1_300_000_000_000_000_000n + BigInt(i)), name }));
    before(() => loadEmojis(everyEmoji()));
    after(() => loadEmojis([]));

    it('stay inside Discord limits for a set with many parts in many relics', () => {
      // Ten parts, each in thirty relics, and the member owns every one of them at two refinements.
      const parts = Array.from({ length: 10 }, (_, i) => `Bigset Prime Part Number ${i}`);
      const relics: Record<string, Record<string, unknown>> = {};
      for (let r = 0; r < 30; r++) {
        relics[`Z${r}`] = { vaulted: r % 2 === 0, rare1: parts[r % 10], uncommon1: parts[(r + 1) % 10], uncommon2: parts[(r + 2) % 10], common1: parts[(r + 3) % 10], common2: parts[(r + 4) % 10], common3: parts[(r + 5) % 10] };
      }
      const big = buildRelicBook(
        { relics: { Axi: relics }, eqmt: { 'Bigset Prime': { type: 'Warframes', vaulted: false, parts: Object.fromEntries(parts.map((p) => [p, { count: 2, ducats: 100 }])) } } },
        parts.map((name) => ({ name, custom_avg: 123 })),
      );
      const owned = Array.from({ length: 30 }, (_, r) => [
        { tier: 'Axi' as const, code: `Z${r}`, refinement: 'Radiant' as const, count: 12 },
        { tier: 'Axi' as const, code: `Z${r}`, refinement: 'Intact' as const, count: 99 },
      ]).flat();
      const s = findSet(big, 'Bigset Prime')!;
      const v: WishView = { plan: wishPlan(big, s, [], owned), wish: { id: 1, guildId: GUILD, userId: 'u1', item: s.name, have: [], createdAt: NOW }, varzia: varziaOffer('Saryn Prime', varzia(), NOW), access: 'ok', stale: true };
      for (const c of [wishCard(v, '✅ Added to your wishlist (20/20).'), wishListCard(Array.from({ length: MAX_WISHES }, () => v))]) {
        const stats = messageStats([c]);
        assert.ok(stats.text <= 4000, `${stats.text} characters of text`);
        assert.ok(stats.components <= 40, `${stats.components} components`);
      }
      const shown = componentText([wishCard(v)]);
      // Every part is in 18 relics, each owned at two refinements.
      assert.ok(shown.includes('+10 more'), 'a part names eight relics and counts the rest');
      assert.ok(shown.includes('and 30 more'), 'and six of the copies owned');
    });
  });
});

// --- The service, against a fake warframestat.us, AlecaFrame and Discord. ---

function inventory(entries: [tier: number, refinement: number, code: string, count: number][]): string {
  const buf = Buffer.alloc(4 + entries.length * 9);
  buf.writeUInt32LE(entries.length, 0);
  entries.forEach(([tier, refinement, code, count], i) => {
    const o = 4 + i * 9;
    buf[o] = tier;
    buf[o + 1] = refinement;
    buf.write(code.padEnd(3, '\0'), o + 2, 3, 'latin1');
    buf.writeUInt32LE(count, o + 5);
  });
  return buf.toString('base64');
}

describe('the wishlist commands', () => {
  const realFetch = globalThis.fetch;
  let requests: string[] = [];
  let alecaStatus = 200;
  let world: unknown = {};

  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0, hostIntervalMs: {} } });
    resetRelicBook();
    forgetToken();
    requests = [];
    alecaStatus = 200;
    // What the relay serves has to look like a world state: the cycles and the fissures are what it is recognised by.
    world = { ...varzia({ expiry: new Date(Date.now() + 12 * DAY).toISOString() }), timestamp: new Date().toISOString(), cetusCycle: { isDay: true, expiry: new Date(Date.now() + 3_600_000).toISOString() }, fissures: [] };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url.replace(/\?.*$/, ''));
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.endsWith('/wfinfo/filtered_items')) return json(TABLE);
      if (url.endsWith('/wfinfo/prices')) return json(PRICES);
      if (url.startsWith('http://relay.test/')) return json(world);
      // Neo S5 twice intact and once radiant, one Axi S3 flawless.
      if (url.includes('/getRelicInventory')) return alecaStatus === 200 ? json(inventory([[2, 0, 'S5', 2], [2, 3, 'S5', 1], [3, 2, 'S3', 1]])) : json({ detail: 'Invalid token' }, alecaStatus);
      return json({ error: 'not found' }, 404);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    configureWorldState({ enabled: false });
    resetRelicBook();
  });

  function server(opts: { worldState?: boolean } = {}) {
    const dms: { to: string; text: string }[] = [];
    const store = new Store(':memory:');
    const ctx: AppContext = {
      config: loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }),
      store,
      client: {
        user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' },
        users: { fetch: async (id: string) => (id === 'closed' ? Promise.reject(new Error('Cannot send messages to this user')) : { send: async (o: { components: { toJSON(): unknown }[] }) => void dms.push({ to: id, text: componentText(o.components) }) }) },
      } as unknown as Client,
    };
    if (opts.worldState) configureWorldState({ enabled: true, intervalSeconds: 600, url: `http://relay.test/${Math.random()}`, store: new Store(':memory:') });
    else configureWorldState({ enabled: false });
    return { ctx, store, dms };
  }

  type Sent = { kind: string; text: string; flags?: number; content?: string };
  function command(sub: string, item: string | null, userId = 'u1') {
    const sent: Sent[] = [];
    const record = (kind: string) => async (o: { components?: { toJSON(): unknown }[]; flags?: number; content?: string } = {}) => void sent.push({ kind, text: componentText(o.components ?? []), flags: o.flags, content: o.content });
    const interaction = {
      user: { id: userId },
      options: { getSubcommand: () => sub, getString: () => item, getFocused: () => item ?? '' },
      reply: record('reply'),
      deferReply: record('deferReply'),
      editReply: record('editReply'),
    } as unknown as ChatInputCommandInteraction;
    return { interaction, sent };
  }
  const run = async (ctx: AppContext, sub: string, item: string | null, userId = 'u1') => {
    const c = command(sub, item, userId);
    await wishlist.execute(c.interaction, ctx);
    return c.sent;
  };
  const suggest = async (ctx: AppContext, sub: string, typed: string, userId = 'u1') => {
    let names: string[] = [];
    const interaction = { user: { id: userId }, options: { getSubcommand: () => sub, getFocused: () => typed }, respond: async (list: { name: string }[]) => void (names = list.map((c) => c.name)) } as unknown as AutocompleteInteraction;
    await wishlist.autocomplete!(interaction, ctx);
    return names;
  };

  it('add a set by any spelling, show it and say so when it is already there', async () => {
    const { ctx, store } = server();
    const sent = await run(ctx, 'add', 'saryn');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.kind, 'reply');
    assert.match(sent[0]!.text, /^## 🔮 Saryn Prime\n.*\n✅ Added to your wishlist \(1\/20\)\./);
    assert.ok(sent[0]!.text.includes('Link AlecaFrame'), 'not linked: the relics owned are not known');
    assert.deepEqual(store.listWishes(GUILD, 'u1').map((w) => w.item), ['Saryn Prime'], 'stored under the name the tables use');

    const again = await run(ctx, 'add', 'Saryn Prime Set');
    assert.ok(again[0]!.text.includes('Already on your wishlist.'));
    assert.equal(store.listWishes(GUILD, 'u1').length, 1);

    await assert.rejects(run(ctx, 'add', 'Chroma Prime'), (err: unknown) => err instanceof UserError && /No prime set is called "Chroma Prime"/.test(err.message));
    await assert.rejects(run(ctx, 'add', 'Excalibur Prime'), /does not come from relics/);
    assert.deepEqual(requests.sort(), ['https://api.warframestat.us/wfinfo/filtered_items', 'https://api.warframestat.us/wfinfo/prices'], 'the two tables, read once; nothing is asked of AlecaFrame without a link');
  });

  it('mark the relics a linked member owns, and say when AlecaFrame does not answer', async () => {
    const { ctx, store } = server();
    store.setAlecaLink('u1', { token: 'goodtoken123', username: 'Rat', parts: SHARES.relics });
    const sent = await run(ctx, 'add', 'Saryn Prime');
    assert.ok(sent[0]!.text.includes('-# 🔮 You own Neo S5 Radiant ×1, Neo S5 ×2'), sent[0]!.text);
    assert.ok(!sent[0]!.text.includes('Link AlecaFrame'));

    forgetToken();
    alecaStatus = 500;
    const failed = await run(ctx, 'show', 'Saryn Prime');
    assert.ok(failed[0]!.text.includes('AlecaFrame could not be read just now'));
    assert.ok(failed[0]!.text.includes('Tick the parts'), 'the entry is still theirs');

    store.setAlecaLink('u2', { token: 'othertoken123', username: 'Mouse', parts: SHARES.platinum });
    assert.ok((await run(ctx, 'show', 'Saryn Prime', 'u2'))[0]!.text.includes('does not share your relics'));
    assert.ok((await run(ctx, 'show', 'Saryn Prime', 'u2'))[0]!.text.includes('Not on your wishlist'), 'anyone can look a set up');
  });

  it('list, and take a set off', async () => {
    const { ctx, store } = server();
    assert.match((await run(ctx, 'list', null))[0]!.text, /Nothing on it yet/);
    await run(ctx, 'add', 'Saryn Prime');
    await run(ctx, 'add', 'Strun Prime');
    store.addWish(GUILD, 'u1', 'Gone Prime');
    const list = (await run(ctx, 'list', null))[0]!.text;
    assert.match(list, /Your prime wishlist · 3\/20/);
    assert.ok(list.includes('**Saryn Prime** · 🔒 vaulted · 4 of 4 parts missing · about 80p'));
    assert.ok(list.includes('**Gone Prime** · not in the relic tables right now'));

    const removed = await run(ctx, 'remove', 'strun');
    assert.deepEqual(removed.map((s) => [s.kind, s.content]), [['reply', '🗑️ **Strun Prime** is off your wishlist.']]);
    assert.equal(removed[0]!.flags, 64, 'only the member sees it');
    await run(ctx, 'remove', 'Gone Prime');
    assert.deepEqual(store.listWishes(GUILD, 'u1').map((w) => w.item), ['Saryn Prime']);
    await assert.rejects(run(ctx, 'remove', 'Strun Prime'), /is not on your wishlist/);
    await assert.rejects(run(ctx, 'remove', 'Saryn Prime', 'u2'), /is not on your wishlist/, "someone else's list is not theirs to change");
  });

  it('stop at twenty sets', async () => {
    const { ctx, store } = server();
    for (let i = 0; i < MAX_WISHES; i++) store.addWish(GUILD, 'u1', `Set ${i} Prime`);
    await assert.rejects(run(ctx, 'add', 'Saryn Prime'), /holds 20 sets, the most allowed/);
    assert.equal(store.listWishes(GUILD, 'u1').length, MAX_WISHES);
    store.addWish(GUILD, 'u2', 'Strun Prime');
    assert.ok((await run(ctx, 'add', 'strun prime', 'u2'))[0]!.text.includes('Already on your wishlist.'), 'a set that is there can always be shown');
  });

  it('suggest sets while typing: new ones to add, the member\'s own to remove, their own first to show', async () => {
    const { ctx, store } = server();
    store.addWish(GUILD, 'u1', 'Strun Prime');
    assert.deepEqual(await suggest(ctx, 'add', ''), ['Akbronco Prime', 'Bronco Prime', 'Saryn Prime'], 'what comes from relics and is not on the list yet');
    assert.deepEqual(await suggest(ctx, 'add', 'bron'), ['Bronco Prime', 'Akbronco Prime'], 'a name that starts with what was typed comes first');
    assert.deepEqual(await suggest(ctx, 'remove', ''), ['Strun Prime']);
    assert.deepEqual(await suggest(ctx, 'remove', 'sar'), []);
    assert.deepEqual(await suggest(ctx, 'show', 'S'), ['Strun Prime', 'Saryn Prime']);
    assert.deepEqual(await wishChoices(ctx, 'u2', 'zzz', 'all'), []);
  });

  it('tick the parts a member has from the menu on the card', async () => {
    const { ctx, store } = server();
    await run(ctx, 'add', 'Saryn Prime');
    const wish = store.listWishes(GUILD, 'u1')[0]!;
    const pick = (values: string[], userId = 'u1', id = wish.id) => {
      const updates: string[] = [];
      const interaction = { customId: `wish:have:${id}`, values, user: { id: userId }, update: async (o: { components: { toJSON(): unknown }[]; flags: number }) => void updates.push(componentText(o.components)) } as unknown as StringSelectMenuInteraction;
      return { interaction, updates };
    };
    const first = pick(['Saryn Prime Blueprint', 'Saryn Prime Systems', 'Not A Part']);
    await handleWishSelect(first.interaction, ctx);
    assert.deepEqual(store.getWish(wish.id)!.have, ['Saryn Prime Blueprint', 'Saryn Prime Systems'], 'only parts of the set are kept');
    assert.equal(first.updates.length, 1);
    assert.ok(first.updates[0]!.includes('**Still needed** · 2 of 4 parts · about **35p** on the market'));
    assert.ok(first.updates[0]!.includes('✅ **Already have:** Saryn Prime Blueprint, Saryn Prime Systems'));

    const none = pick([]);
    await handleWishSelect(none.interaction, ctx);
    assert.deepEqual(store.getWish(wish.id)!.have, [], 'every tick can be taken back');

    await assert.rejects(handleWishSelect(pick(['Saryn Prime Blueprint'], 'u2').interaction, ctx), /no longer on your wishlist/);
    await assert.rejects(handleWishSelect(pick(['Saryn Prime Blueprint'], 'u1', 999).interaction, ctx), /no longer on your wishlist/);
    const odd = pick([]);
    (odd.interaction as { customId: string }).customId = 'wish:nope:1';
    await assert.rejects(handleWishSelect(odd.interaction, ctx), /Unknown menu/);
    assert.deepEqual(store.getWish(wish.id)!.have, []);
  });

  it('DM a member once per visit when Varzia sells sets on their list', async () => {
    const { ctx, store, dms } = server();
    const saryn = store.addWish(GUILD, 'u1', 'Saryn Prime');
    store.setWishHave(saryn.id, ['Saryn Prime Blueprint']);
    store.addWish(GUILD, 'u1', 'Strun Prime');
    store.addWish(GUILD, 'u1', 'Bronco Prime');
    store.addWish(GUILD, 'u2', 'Akbronco Prime');
    store.addWish(GUILD, 'closed', 'Saryn Prime');

    assert.equal(await notifyWishlistVarzia(ctx, varzia(), NOW, { book }), 1, 'one DM for the member reached, none for closed DMs');
    assert.deepEqual(dms.map((d) => d.to), ['u1']);
    const dm = dms[0]!.text;
    assert.match(dm, /^### 🏺 Varzia has something from your wishlist\n/);
    assert.ok(dm.includes(`**Saryn Prime** · until <t:${UNTIL / 1000}:D> (${rel(UNTIL)})\nNidus Saryn Prime Dual Pack, Saryn Prime Single Pack · relics of the Nidus Saryn vault: Lith A · Meso A, B · Axi A\n-# 3 of 4 parts still missing · about 75p on the market`), dm);
    assert.ok(dm.includes('**Strun Prime** · until'));
    assert.ok(!dm.includes('Bronco'), 'what she does not sell is not mentioned');

    assert.equal(await notifyWishlistVarzia(ctx, varzia(), NOW + 60_000, { book }), 0, 'the same visit is not told twice');
    assert.equal(dms.length, 1);
    const next = varzia({ expiry: new Date(UNTIL + 30 * DAY).toISOString() });
    assert.equal(await notifyWishlistVarzia(ctx, next, UNTIL + DAY, { book }), 1, 'her next visit is news again');

    assert.equal(await notifyWishlistVarzia(ctx, null, NOW), 0);
    assert.equal(await notifyWishlistVarzia(ctx, varzia({ inventory: [] }), NOW), 0);
  });

  it('do not DM what the card already said when the set was added', async () => {
    const { ctx, dms } = server({ worldState: true });
    const sent = await run(ctx, 'add', 'Saryn Prime');
    assert.ok(sent[0]!.text.includes('**Varzia sells it** until'), sent[0]!.text);
    const ws = world as WorldState;
    assert.equal(await notifyWishlistVarzia(ctx, ws, Date.now(), { book }), 0);
    assert.equal(dms.length, 0);
  });

  it('name the set in the DM even when the relic tables cannot be read', () => {
    const bare: WishView = { plan: { set: { name: 'Saryn Prime', type: '', vaulted: true, plat: null, parts: [] }, parts: [], missing: [], missingPlat: 0, unpriced: 0, ownedRelics: null }, wish: null, varzia: { items: ['Saryn Prime Single Pack'], until: UNTIL }, access: 'ok', stale: true };
    const t = componentText([varziaDm([bare, view('Strun Prime')], null)]);
    assert.ok(t.includes(`**Saryn Prime** · until <t:${UNTIL / 1000}:D> (${rel(UNTIL)})\nSaryn Prime Single Pack\n-# From your /wishlist.`), t);
    assert.ok(!t.includes('Strun'), 'a set she does not sell is left out');
  });

  it('DM the members who collect a set when it leaves or re-enters the drop tables', async () => {
    const { ctx, store, dms } = server();
    store.addWish(GUILD, 'u1', 'Saryn Prime');
    store.addWish(GUILD, 'u1', 'Strun Prime');
    store.addWish(GUILD, 'u2', 'strun prime');
    store.addWish(GUILD, 'u3', 'Bronco Prime');
    assert.equal(await notifyWishlistVault(ctx, { openedSets: ['Saryn Prime'], vaultedSets: ['Strun Prime'] }), 2);
    assert.deepEqual(dms.map((d) => d.to), ['u1', 'u2']);
    assert.ok(dms[0]!.text.includes('🔓 **Saryn Prime** is back in the drop tables: its relics can be farmed again.\n🔒 **Strun Prime** is now vaulted: its relics no longer drop.'), dms[0]!.text);
    assert.ok(dms[1]!.text.includes('🔒 **Strun Prime** is now vaulted') && !dms[1]!.text.includes('Saryn'));
    assert.equal(await notifyWishlistVault(ctx, { openedSets: [], vaultedSets: [] }), 0);
    assert.equal(componentText([vaultDm(['A Prime'], [], null)]).split('\n')[0], '### 🔮 The Prime Vault moved something on your wishlist');
  });

  it('are told by the vault watch itself, with or without a news channel', async () => {
    const { ctx, store, dms } = server();
    store.addWish(GUILD, 'u1', 'Saryn Prime');
    // A table big enough to be believed, in which Saryn Prime's relics come back.
    const filler = (vaulted: boolean) => Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`F${i}`, { vaulted, rare1: 'Filler Prime Blade', uncommon1: 'Forma Blueprint', uncommon2: 'Forma Blueprint', common1: 'Forma Blueprint', common2: 'Forma Blueprint', common3: 'Forma Blueprint' }]));
    const table = (sarynVaulted: boolean): WfinfoTable => ({
      relics: { ...TABLE.relics, Requiem: filler(false) },
      eqmt: { ...TABLE.eqmt, 'Saryn Prime': { ...TABLE.eqmt!['Saryn Prime']!, vaulted: sarynVaulted } },
      ignored_items: TABLE.ignored_items,
    });
    assert.equal(await watchVault(ctx, { now: NOW, book: buildRelicBook(table(true), PRICES, NOW) }), null, 'the first look only records');
    assert.equal(await watchVault(ctx, { now: NOW + 3_600_000, book: buildRelicBook(table(false), PRICES, NOW) }), null, 'no news channel: nothing is posted');
    assert.deepEqual(dms.map((d) => d.to), ['u1'], 'but the member who collects it is told');
    assert.ok(dms[0]!.text.includes('🔓 **Saryn Prime** is back in the drop tables'));
    assert.equal(await watchVault(ctx, { now: NOW + 2 * 3_600_000, book: buildRelicBook(table(false), PRICES, NOW) }), null);
    assert.equal(dms.length, 1, 'once');
  });
});
