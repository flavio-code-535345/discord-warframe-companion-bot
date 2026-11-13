import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { relicList, snapshotOf, vaultChanges, vaultEmbed, vaultWatchState, watchVault } from '../src/discord/vault-watch.js';
import { type RelicBook, type WfinfoTable, buildRelicBook, findSet } from '../src/warframe/relics.js';

const G = '111111111111111111';
const DAY = 86_400_000;

type Relics = NonNullable<WfinfoTable['relics']>;

/**
 * WFInfo's table, cut down: 120 old relics that hold Braton Prime, and the relics the tests are about. `vaulted` says which of
 * those no longer drop, `xaku` adds a new prime with its relic.
 */
function book(opts: { vaulted?: string[]; xaku?: boolean; fillers?: number; stale?: boolean; flipFillers?: number } = {}): RelicBook {
  const gone = new Set(opts.vaulted ?? []);
  const relics: Relics = { Lith: {}, Meso: {}, Neo: {}, Axi: {} };
  const put = (tier: string, code: string, rare: string, vaulted = gone.has(`${tier} ${code}`)) => {
    relics[tier]![code] = { vaulted, rare1: rare, uncommon1: 'Braton Prime Barrel', uncommon2: 'Forma Blueprint', common1: 'Braton Prime Stock', common2: 'Forma Blueprint', common3: 'Braton Prime Receiver' };
  };
  for (let n = 1; n <= (opts.fillers ?? 120); n++) put('Lith', `F${n}`, 'Braton Prime Blueprint', n > (opts.flipFillers ?? 0));
  put('Lith', 'S1', 'Saryn Prime Chassis');
  put('Meso', 'S2', 'Saryn Prime Systems');
  put('Neo', 'N1', 'Nikana Prime Blade');
  put('Neo', 'N2', 'Nikana Prime Hilt');
  if (opts.xaku) put('Axi', 'X1', 'Xaku Prime Neuroptics');
  const part = (vaulted: boolean) => ({ count: 1, ducats: 45, vaulted });
  const all = (codes: string[]) => codes.every((c) => gone.has(c));
  const eqmt: NonNullable<WfinfoTable['eqmt']> = {
    'Braton Prime': {
      type: 'Primary',
      vaulted: true,
      parts: { 'Braton Prime Blueprint': part(true), 'Braton Prime Barrel': part(false), 'Braton Prime Stock': part(false), 'Braton Prime Receiver': part(false) },
    },
    'Saryn Prime': { type: 'Warframes', vaulted: all(['Lith S1', 'Meso S2']), parts: { 'Saryn Prime Chassis': part(gone.has('Lith S1')), 'Saryn Prime Systems': part(gone.has('Meso S2')) } },
    'Nikana Prime': { type: 'Melee', vaulted: all(['Neo N1', 'Neo N2']), parts: { 'Nikana Prime Blade': part(gone.has('Neo N1')), 'Nikana Prime Hilt': part(gone.has('Neo N2')) } },
    // A weapon made of two others: no relic holds its parts.
    'Akbronco Prime': { type: 'Secondary', vaulted: false, parts: { 'Bronco Prime': { count: 2, ducats: 0, vaulted: false } } },
  };
  if (opts.xaku) eqmt['Xaku Prime'] = { type: 'Warframes', vaulted: false, parts: { 'Xaku Prime Neuroptics': part(false) } };
  // Braton Prime's common parts sit in every relic, so the set itself is never vaulted here.
  eqmt['Braton Prime']!.vaulted = false;
  return buildRelicBook({ relics, eqmt, ignored_items: { 'Forma Blueprint': {} } }, [{ name: 'Saryn Prime Set', custom_avg: '120', yesterday_vol: '9' }], 1_000, opts.stale ?? false);
}

interface Post {
  channel: string;
  author: string;
  title: string;
  description: string;
}

function world(opts: { channel?: string | null; broken?: boolean } = {}) {
  const store = new Store(':memory:');
  if (opts.channel !== null) store.updateSettings(G, { newsChannelId: opts.channel ?? 'c-news' });
  const posts: Post[] = [];
  const state = { broken: opts.broken ?? false };
  const client = {
    channels: {
      fetch: async (id: string) => {
        if (state.broken) throw new Error('Missing Access');
        return {
          id,
          guildId: G,
          isSendable: () => true,
          send: async (payload: { embeds: { toJSON(): { author?: { name: string }; title: string; description: string } }[]; allowedMentions?: unknown }) => {
            assert.deepEqual(payload.allowedMentions, { parse: [] }, 'the post pings nobody');
            const embed = payload.embeds[0]!.toJSON();
            posts.push({ channel: id, author: embed.author?.name ?? '', title: embed.title, description: embed.description });
            return { id: 'm1' };
          },
        };
      },
    },
  };
  const ctx = { config: { DISCORD_GUILD_ID: G, CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Cephalon Ordis' }, store, client } as unknown as AppContext;
  return { ctx, store, posts, state };
}

describe('the relic book knows the prime sets', () => {
  it('lists each set with its parts, what they trade for and the relics that hold them', () => {
    const b = book({ vaulted: ['Meso S2'] });
    const saryn = findSet(b, 'saryn prime set')!;
    assert.equal(saryn.name, 'Saryn Prime');
    assert.equal(saryn.type, 'Warframes');
    assert.equal(saryn.vaulted, false, 'one of its relics still drops');
    assert.equal(saryn.plat, 120);
    assert.deepEqual(saryn.parts.map((p) => [p.name, p.count, p.ducats, p.relics.map((h) => `${h.relic.name} ${h.rarity}`)]), [
      ['Saryn Prime Chassis', 1, 45, ['Lith S1 Rare']],
      ['Saryn Prime Systems', 1, 45, ['Meso S2 Rare']],
    ]);
    assert.equal(findSet(b, 'Saryn')?.name, 'Saryn Prime', 'the word Prime may be left out');
    assert.equal(findSet(b, '  NIKANA   prime '), b.sets.get('nikana prime'));
    assert.equal(findSet(b, 'constructor'), null);
    assert.equal(findSet(b, ''), null);
    // The relics that still drop come first.
    const barrel = findSet(b, 'Braton Prime')!.parts.find((p) => p.name === 'Braton Prime Barrel')!;
    assert.deepEqual(barrel.relics.slice(0, 3).map((h) => h.relic.name), ['Lith S1', 'Neo N1', 'Neo N2']);
    assert.equal(findSet(b, 'Akbronco Prime')!.parts[0]!.count, 2);
  });

  it('works a set out from its relics when the table does not say', () => {
    const table: WfinfoTable = {
      relics: { Lith: { A1: { vaulted: true, rare1: 'Ash Prime Systems' }, B1: { vaulted: false, rare1: 'Boar Prime Barrel' }, C1: 'broken' as never } },
      eqmt: {
        'Ash Prime': { parts: { 'Ash Prime Systems': { ducats: 65 } } },
        'Boar Prime': { parts: { 'Boar Prime Barrel': {} } },
        'Odonata Prime': { parts: { 'Odonata Prime Blueprint': { count: 0 } } },
        Broken: null as never,
      },
    };
    const b = buildRelicBook(table, []);
    assert.equal(b.sets.get('ash prime')!.vaulted, true);
    assert.equal(b.sets.get('boar prime')!.vaulted, false);
    assert.equal(b.sets.get('odonata prime')!.vaulted, false, 'no relic holds it, so nothing says it is vaulted');
    assert.equal(b.sets.get('odonata prime')!.parts[0]!.count, 1);
    assert.equal(b.sets.has('broken'), false);
    assert.deepEqual([...b.relics.keys()], ['lith a1', 'lith b1']);
  });
});

describe('the vault watch', () => {
  it('compares two looks at the table', () => {
    const before = snapshotOf(book());
    assert.equal(before.sets.has('Akbronco Prime'), false, 'a set no relic holds is not watched');
    const after = snapshotOf(book({ vaulted: ['Lith S1', 'Meso S2', 'Neo N1'], xaku: true }));
    assert.deepEqual(vaultChanges(before, after), {
      vaultedSets: ['Saryn Prime'],
      openedSets: [],
      newSets: ['Xaku Prime'],
      vaultedRelics: ['Lith S1', 'Meso S2', 'Neo N1'],
      openedRelics: [],
      newRelics: ['Axi X1'],
    });
    assert.deepEqual(vaultChanges(after, before).openedSets, ['Saryn Prime']);
    assert.deepEqual(vaultChanges(after, before).newRelics, [], 'what is gone is not news');
    assert.deepEqual(Object.values(vaultChanges(before, before)).flat(), []);
  });

  it('writes relics by tier in the game order and counts what does not fit', () => {
    assert.equal(relicList(['Axi S10', 'Lith S2', 'Axi A1', 'Lith S14', 'Vanguard C1', 'Meso N16']), '**Lith** S2, S14 · **Meso** N16 · **Axi** A1, S10 · **Vanguard** C1');
    assert.equal(relicList(['Lith A1', 'Lith A2', 'Lith A3'], 2), '**Lith** A1, A2 and 1 more');
    const embed = vaultEmbed({ vaultedSets: ['A Prime', 'B Prime', 'C Prime', 'D Prime'], openedSets: [], newSets: [], vaultedRelics: ['Lith A1'], openedRelics: ['Neo B2'], newRelics: [] }).toJSON();
    assert.equal(embed.title, 'A Prime, B Prime and 2 more are now vaulted');
    assert.match(embed.description!, /🔒 \*\*Vaulted\*\*.*\nA Prime, B Prime, C Prime, D Prime\nRelics: \*\*Lith\*\* A1\n\n🔓 \*\*Back in the drop tables\*\*\nRelics: \*\*Neo\*\* B2/);
    assert.equal(vaultEmbed({ vaultedSets: [], openedSets: [], newSets: [], vaultedRelics: [], openedRelics: [], newRelics: ['Lith A1'] }).toJSON().title, '1 new relic');
  });

  it('only records at its first look, then posts what changed, once', async () => {
    const w = world();
    assert.equal(vaultWatchState(w.store), null);
    assert.equal(await watchVault(w.ctx, { book: book(), now: 1 * DAY }), null);
    assert.equal(w.posts.length, 0);
    assert.deepEqual(vaultWatchState(w.store), { relics: 124, vaultedRelics: 120, sets: 3, vaultedSets: 0, recordedAt: DAY, lastChangeAt: null });
    assert.equal(await watchVault(w.ctx, { book: book(), now: 2 * DAY }), null, 'nothing changed');

    const changed = await watchVault(w.ctx, { book: book({ vaulted: ['Lith S1', 'Meso S2'] }), now: 3 * DAY });
    assert.deepEqual(changed?.vaultedSets, ['Saryn Prime']);
    assert.equal(w.posts.length, 1);
    assert.equal(w.posts[0]!.channel, 'c-news');
    assert.equal(w.posts[0]!.author, '🔒 Prime Vault');
    assert.equal(w.posts[0]!.title, 'Saryn Prime is now vaulted');
    assert.match(w.posts[0]!.description, /Saryn Prime\nRelics: \*\*Lith\*\* S1 · \*\*Meso\*\* S2/);
    assert.equal(vaultWatchState(w.store)!.lastChangeAt, 3 * DAY);
    assert.equal(vaultWatchState(w.store)!.vaultedSets, 1);

    assert.equal(await watchVault(w.ctx, { book: book({ vaulted: ['Lith S1', 'Meso S2'] }), now: 4 * DAY }), null);
    assert.equal(w.posts.length, 1);
  });

  it('announces a new prime with its relics', async () => {
    const w = world();
    await watchVault(w.ctx, { book: book(), now: DAY });
    await watchVault(w.ctx, { book: book({ xaku: true }), now: 2 * DAY });
    assert.equal(w.posts[0]!.title, 'New in the relics: Xaku Prime');
    assert.match(w.posts[0]!.description, /✨ \*\*New\*\*\nXaku Prime\nRelics: \*\*Axi\*\* X1/);
  });

  it('does not repeat itself when a flag flips back and forth in the data', async () => {
    const w = world();
    const open = book();
    const shut = book({ vaulted: ['Neo N1'] });
    await watchVault(w.ctx, { book: open, now: DAY });
    await watchVault(w.ctx, { book: shut, now: 2 * DAY });
    await watchVault(w.ctx, { book: open, now: 3 * DAY });
    await watchVault(w.ctx, { book: shut, now: 4 * DAY });
    await watchVault(w.ctx, { book: open, now: 5 * DAY });
    assert.deepEqual(w.posts.map((p) => p.title), ['1 relic left the drop tables', '1 relic back in the drop tables']);
    assert.equal(vaultWatchState(w.store)!.vaultedRelics, 120, 'the record still follows the table');
  });

  it('leaves a stale, cut-off or rebuilt table alone', async () => {
    const w = world();
    await watchVault(w.ctx, { book: book({ fillers: 200 }), now: DAY });
    const recorded = w.store.getMeta('vault_watch');
    const vaulted = ['Lith S1', 'Meso S2'];
    assert.equal(await watchVault(w.ctx, { book: book({ vaulted, fillers: 200, stale: true }), now: 2 * DAY }), null, 'served from the cache while the source is down');
    assert.equal(await watchVault(w.ctx, { book: book({ vaulted, fillers: 50 }), now: 2 * DAY }), null, 'too few relics to be the table');
    assert.equal(await watchVault(w.ctx, { book: book({ vaulted, fillers: 150 }), now: 2 * DAY }), null, 'a quarter of the relics are missing');
    assert.equal(w.store.getMeta('vault_watch'), recorded);
    assert.equal(w.posts.length, 0);

    // 201 relics change at once: that is the data being rebuilt. It is taken as the new record and not announced.
    assert.equal(await watchVault(w.ctx, { book: book({ fillers: 200, flipFillers: 200, vaulted: ['Neo N1'] }), now: 3 * DAY }), null);
    assert.equal(w.posts.length, 0);
    assert.equal(vaultWatchState(w.store)!.vaultedRelics, 1);
  });

  it('keeps the record without a news channel, and waits for a channel it cannot post in', async () => {
    const quiet = world({ channel: null });
    await watchVault(quiet.ctx, { book: book(), now: DAY });
    assert.equal(await watchVault(quiet.ctx, { book: book({ vaulted: ['Neo N1'] }), now: 2 * DAY }), null);
    quiet.store.updateSettings(G, { newsChannelId: 'c-news' });
    assert.equal(await watchVault(quiet.ctx, { book: book({ vaulted: ['Neo N1'] }), now: 3 * DAY }), null, 'old news is not posted into a new channel');
    assert.equal(quiet.posts.length, 0);

    const w = world({ broken: true });
    await watchVault(w.ctx, { book: book(), now: DAY });
    await assert.rejects(watchVault(w.ctx, { book: book({ vaulted: ['Neo N1'] }), now: 2 * DAY }), /not a text channel in the clan server/);
    assert.equal(vaultWatchState(w.store)!.vaultedRelics, 120, 'not recorded, so it is tried again');
    w.state.broken = false;
    assert.deepEqual((await watchVault(w.ctx, { book: book({ vaulted: ['Neo N1'] }), now: 2 * DAY + 3_600_000 }))?.vaultedRelics, ['Neo N1']);
    assert.equal(w.posts.length, 1);
  });

  it('starts over from a record it cannot read', async () => {
    const w = world();
    for (const bad of ['{not json', 'null', '{"relics":{"open":"x"},"sets":{}}', '[]']) {
      w.store.setMeta('vault_watch', bad);
      assert.equal(vaultWatchState(w.store), null, bad);
    }
    assert.equal(await watchVault(w.ctx, { book: book({ vaulted: ['Neo N1'] }), now: DAY }), null);
    assert.equal(w.posts.length, 0);
    assert.equal(vaultWatchState(w.store)!.vaultedRelics, 121);
  });
});
