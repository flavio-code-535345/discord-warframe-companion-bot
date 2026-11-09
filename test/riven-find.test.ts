import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PNG } from 'pngjs';
import { Store } from '../src/db.js';
import { listingLines, rivenFindEmbed } from '../src/discord/riven-embeds.js';
import { compareRivens, rollScore } from '../src/rivens/compare.js';
import { describeFilter, findRivens, matchesFilter, resolveFilter } from '../src/rivens/find.js';
import { parseAuctions, resetRivenFilter, resetRivenLists, searchPageUrl } from '../src/rivens/market.js';
import { basisText, rivenPicture, saleText } from '../src/rivens/picture.js';
import { rivenReplies } from '../src/rivens/reply.js';
import { formatStatValue } from '../src/rivens/stats.js';
import type { RivenListing } from '../src/rivens/types.js';
import { checkRivenWatches, noteMatches, resetRivenWatch } from '../src/rivens/watch.js';
import { describeTracker } from '../src/trackers.js';
import { api } from '../src/warframe/fetch.js';

const stats = (positives: string[], negative?: string): RivenListing['stats'] => [
  ...positives.map((slug) => ({ slug, value: 100, positive: true })),
  ...(negative ? [{ slug: negative, value: -50, positive: false }] : []),
];
const listing = (id: string, price: number, positives: string[], negative?: string): RivenListing => ({ id, weapon: 'rubico', price, polarity: 'madurai', rerolls: 2, stats: stats(positives, negative) });

describe('reading what /riven find shows', () => {
  it('reads the seller, mastery, rank, name, platform and listing time, none of which is stored', () => {
    const [a, b] = parseAuctions(
      {
        payload: {
          auctions: [
            {
              id: 'x1',
              buyout_price: 450,
              platform: 'pc',
              created: '2026-11-08T10:00:00.000+00:00',
              owner: { status: 'ingame', ingame_name: 'Someone' },
              item: { type: 'riven', name: 'crita-visitis', mastery_level: 12, mod_rank: 8, polarity: 'vazarin', re_rolls: 0, attributes: [{ url_name: 'critical_chance', value: 90.2, positive: true }, { url_name: 'multishot', value: 80, positive: true }] },
            },
            { id: 'x2', buyout_price: 90, platform: 'xbox', owner: { status: 'away?' }, item: { type: 'riven', attributes: [{ url_name: 'zoom', value: 20, positive: true }, { url_name: 'recoil', value: 28, positive: false }] } },
          ],
        },
      },
      'rubico',
    );
    assert.deepEqual(
      { name: a!.name, mastery: a!.mastery, rank: a!.rank, seller: a!.seller, platform: a!.platform, listedAt: a!.listedAt, rerolls: a!.rerolls },
      { name: 'crita-visitis', mastery: 12, rank: 8, seller: 'ingame', platform: undefined, listedAt: Date.parse('2026-11-08T10:00:00Z'), rerolls: 0 },
    );
    assert.equal(b!.platform, 'xbox', 'another platform is shown, PC is the default');
    assert.equal(b!.seller, undefined, 'an unknown status is left out');
    assert.ok(!('owner' in b!) && !('ingameName' in b!), "the seller's name is never read");
  });

  it('writes values the way the game does', () => {
    assert.equal(formatStatValue('critical_chance', 90.2), '+90.2%');
    assert.equal(formatStatValue('zoom', -58.2), '−58.2%');
    assert.equal(formatStatValue('recoil', 28), '+28%', 'a curse keeps its own sign');
    assert.equal(formatStatValue('damage_vs_infested', 0.59), 'x0.59');
    assert.equal(formatStatValue('combo_duration', 8.5), '+8.5s');
    assert.equal(formatStatValue('punch_through', 2.1), '+2.1');
    assert.equal(formatStatValue('multishot', 50, 'multiply'), 'x50', "the market's own unit wins");
    assert.equal(formatStatValue('multishot', null), '');
  });

  it('links each listing and lists the curse last', () => {
    const l: RivenListing = { ...listing('abc', 1200, ['critical_chance', 'multishot'], 'zoom'), seller: 'online', mastery: 14, name: 'visitis' };
    const text = listingLines(l, { critical_chance: 'Critical Chance', multishot: 'Multishot', zoom: 'Zoom' });
    assert.match(text, /^🟡 \*\*\[1,200p\]\(https:\/\/warframe\.market\/auction\/abc\)\*\* · MR 14 · 2 re-rolls · .+ · \*Visitis\*\n/);
    assert.match(text, /\+100% Critical Chance · \+100% Multishot · 🔻 −50% Zoom$/);
  });

  it("builds warframe.market's own search page", () => {
    assert.equal(
      searchPageUrl('rubico', ['critical_chance', 'multishot'], 'zoom'),
      'https://warframe.market/auctions/search?type=riven&weapon_url_name=rubico&positive_stats=critical_chance,multishot&negative_stats=zoom&polarity=any&sort_by=price_asc',
    );
  });
});

describe('matching a filter', () => {
  const f = { positives: ['critical_chance', 'multishot'], negative: null, noCurse: false, maxPrice: 500 };
  it('wants every bonus asked for, allows one more, and keeps to the price', () => {
    assert.equal(matchesFilter(listing('a', 400, ['critical_chance', 'multishot', 'status_chance'], 'zoom'), f), true);
    assert.equal(matchesFilter(listing('a', 400, ['critical_chance', 'status_chance']), f), false);
    assert.equal(matchesFilter(listing('a', 501, ['critical_chance', 'multishot']), f), false);
    assert.equal(matchesFilter(listing('a', 500, ['critical_chance', 'multishot']), f), true, 'the limit itself is fine');
  });
  it('follows the curse rule', () => {
    assert.equal(matchesFilter(listing('a', 1, ['critical_chance', 'multishot'], 'zoom'), { ...f, noCurse: true }), false);
    assert.equal(matchesFilter(listing('a', 1, ['critical_chance', 'multishot']), { ...f, noCurse: true }), true);
    assert.equal(matchesFilter(listing('a', 1, ['critical_chance', 'multishot'], 'zoom'), { ...f, negative: 'zoom' }), true);
    assert.equal(matchesFilter(listing('a', 1, ['critical_chance', 'multishot'], 'recoil'), { ...f, negative: 'zoom' }), false);
    assert.equal(matchesFilter(listing('a', 1, ['critical_chance', 'multishot']), { ...f, negative: 'zoom' }), false);
  });
  it('says what it looks for', () => {
    assert.equal(describeFilter({ ...f, noCurse: true }, { critical_chance: 'Critical Chance', multishot: 'Multishot' }), 'Critical Chance + Multishot, no curse, at most 500p');
    assert.equal(describeFilter({ ...f, negative: 'zoom', maxPrice: null }, {}), 'critical chance + multishot, curse zoom');
  });
});

describe('with a fake warframe.market', () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];
  let forSale: (RivenListing & { status?: string })[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const attributes = [
    { slug: 'critical_chance', name: 'Critical Chance', unit: 'percent' },
    { slug: 'critical_damage', name: 'Critical Damage', unit: 'percent' },
    { slug: 'multishot', name: 'Multishot', unit: 'percent' },
    { slug: 'status_chance', name: 'Status Chance', unit: 'percent' },
    { slug: 'zoom', name: 'Zoom', unit: 'percent' },
    { slug: 'punch_through', name: 'Punch Through', positiveOnly: true },
    { slug: 'damage_vs_infested', name: 'Damage to Infested', unit: 'multiply' },
  ];

  beforeEach(() => {
    api.reset();
    api.configure({ limits: { minIntervalMs: 0 } });
    resetRivenLists();
    resetRivenFilter();
    resetRivenWatch();
    urls = [];
    forSale = [
      { ...listing('r1', 300, ['critical_chance', 'multishot']), status: 'ingame' },
      { ...listing('r2', 150, ['critical_chance', 'multishot', 'critical_damage'], 'zoom'), status: 'offline' },
      { ...listing('r3', 900, ['critical_chance', 'multishot']), status: 'online' },
      { ...listing('r4', 100, ['critical_chance', 'status_chance']), status: 'ingame' },
    ];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const u = new URL(String(url));
      if (u.pathname === '/v2/riven/weapons') return json({ data: [{ slug: 'rubico', i18n: { en: { name: 'Rubico' } } }, { slug: 'acceltra', i18n: { en: { name: 'Acceltra' } } }] });
      if (u.pathname === '/v2/riven/attributes') return json({ data: attributes.map((a) => ({ slug: a.slug, positiveOnly: a.positiveOnly === true, ...(a.unit ? { unit: a.unit } : {}), i18n: { en: { name: a.name } } })) });
      if (u.pathname === '/v1/auctions/search') {
        const want = (u.searchParams.get('positive_stats') ?? '').split(',').filter(Boolean);
        const neg = u.searchParams.get('negative_stats');
        const rows = forSale
          .filter((l) => want.every((w) => l.stats.some((s) => s.positive && s.slug === w)) && (!neg || l.stats.some((s) => !s.positive && s.slug === neg)))
          .sort((a, b) => a.price - b.price);
        return json({ payload: { auctions: rows.map((l) => ({ id: l.id, buyout_price: l.price, owner: { status: l.status }, item: { type: 'riven', polarity: l.polarity, re_rolls: l.rerolls, attributes: l.stats.map((s) => ({ url_name: s.slug, value: s.value, positive: s.positive })) } })) } });
      }
      return new Response('?', { status: 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const searches = () => urls.filter((u) => u.includes('/v1/auctions/search'));

  it('turns what was typed into a filter, and explains what it can not use', async () => {
    const { filter, names, units } = await resolveFilter({ weapon: 'rubico', bonuses: 'cc ms', curse: 'none', maxPrice: 500 });
    assert.deepEqual({ weapon: filter.weapon.slug, positives: filter.positives, negative: filter.negative, noCurse: filter.noCurse, maxPrice: filter.maxPrice }, { weapon: 'rubico', positives: ['critical_chance', 'multishot'], negative: null, noCurse: true, maxPrice: 500 });
    assert.equal(names.multishot, 'Multishot');
    assert.equal(units.damage_vs_infested, 'multiply');
    assert.equal((await resolveFilter({ weapon: 'rubico', bonuses: 'cc', curse: 'zoom -40' })).filter.negative, 'zoom', 'a value after the curse is ignored');
    await assert.rejects(resolveFilter({ weapon: 'rubico', bonuses: 'cc cd ms sc' }), /1 to 3 bonus stats/);
    await assert.rejects(resolveFilter({ weapon: 'rubico', bonuses: 'cc', curse: 'punch through' }), /only be a bonus/);
    await assert.rejects(resolveFilter({ weapon: 'rubico', bonuses: 'cc ms', curse: 'ms' }), /can not be one of the bonus/);
    await assert.rejects(resolveFilter({ weapon: 'rubico', bonuses: 'cc frobnicate' }), /don't know/);
    await assert.rejects(resolveFilter({ weapon: 'nothing like it', bonuses: 'cc' }), /No weapon/);
  });

  it('finds the cheapest matching rivens with one filtered search', async () => {
    const { filter, names, units } = await resolveFilter({ weapon: 'rubico', bonuses: 'cc ms', maxPrice: 500 });
    const found = await findRivens(filter, { ttlMs: 60_000 });
    assert.deepEqual(found.listings.map((l) => l.id), ['r2', 'r1'], 'cheapest first, a third bonus and a curse are fine, r3 is over the limit');
    assert.equal(found.complete, true);
    assert.equal(searches().length, 1);
    assert.match(searches()[0]!, /positive_stats=critical_chance,multishot(&|$)/);
    assert.ok(!searches()[0]!.includes('negative_stats'), 'any curse: the market is not asked for one');
    assert.match(searches()[0]!, /buyout_policy=direct/);
    const embed = rivenFindEmbed(filter, found, names, units).toJSON();
    assert.match(embed.title!, /Rubico rivens for sale/);
    assert.match(embed.description!, /\*\*2\*\* for sale, cheapest first/);
    assert.ok(embed.description!.indexOf('150p') < embed.description!.indexOf('300p'));
    const inGame = rivenFindEmbed(filter, found, names, units, { inGame: true }).toJSON();
    assert.ok(!inGame.description!.includes('150p') && inGame.description!.includes('300p'), 'only the seller who is in the game');
    const none = rivenFindEmbed(filter, { listings: [], complete: true }, names, units).toJSON();
    assert.match(none.description!, /Nobody is selling one like that right now/);
  });

  describe('the riven watch', () => {
    const guild = 'g1';
    const setup = () => {
      const store = new Store(':memory:');
      const sent: { to: string; text: string }[] = [];
      const ctx = {
        store,
        config: { DISCORD_GUILD_ID: guild },
        client: {
          user: { displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1/a.png' },
          users: { fetch: async (id: string) => ({ send: async (m: { components: { toJSON(): unknown }[] }) => void sent.push({ to: id, text: JSON.stringify(m.components.map((c) => c.toJSON())) }) }) },
        },
      } as never;
      const spec = { kind: 'riven' as const, weapon: 'rubico', weaponName: 'Rubico', positives: ['critical_chance', 'multishot'], maxPrice: 500, label: 'Critical Chance + Multishot, any curse' };
      return { store, ctx, sent, spec };
    };
    const round = async (ctx: never) => {
      api.reset();
      resetRivenWatch();
      await checkRivenWatches(ctx);
    };

    it('notes what is already for sale, then DMs each new match once', async () => {
      const { store, ctx, sent, spec } = setup();
      const t = store.createTracker(guild, 'u1', JSON.stringify(spec));
      assert.equal(describeTracker(spec), 'Rubico riven with Critical Chance + Multishot, any curse at 500p or less');
      await round(ctx);
      assert.equal(sent.length, 0, 'the first look only records what is listed');
      forSale.push({ ...listing('r5', 420, ['multishot', 'critical_chance', 'status_chance']), status: 'online' }, { ...listing('r6', 800, ['critical_chance', 'multishot']), status: 'ingame' });
      await round(ctx);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, 'u1');
      assert.match(sent[0]!.text, /A Rubico riven you watch for is for sale/);
      assert.match(sent[0]!.text, /auction\/r5/);
      assert.ok(!sent[0]!.text.includes('auction/r6'), 'over the price limit');
      assert.match(sent[0]!.text, new RegExp(`Tracker #${t.id}`));
      await round(ctx);
      assert.equal(sent.length, 1, 'no second DM about the same riven');
      // A price drop makes an old listing a match.
      forSale.find((l) => l.id === 'r6')!.price = 480;
      await round(ctx);
      assert.equal(sent.length, 2);
      assert.match(sent[1]!.text, /auction\/r6/);
    });

    it('shares one search between watches for the same riven, and stays quiet without watches', async () => {
      const { store, ctx, sent, spec } = setup();
      await round(ctx);
      assert.equal(searches().length, 0, 'no watches, no requests');
      store.createTracker(guild, 'u1', JSON.stringify(spec));
      store.createTracker(guild, 'u2', JSON.stringify({ ...spec, positives: ['multishot', 'critical_chance'], maxPrice: 1000, noCurse: true }));
      await round(ctx);
      assert.equal(searches().length, 1, 'the same weapon, bonuses and curse are one search');
      forSale.push({ ...listing('r7', 200, ['critical_chance', 'multishot'], 'zoom'), status: 'online' }, { ...listing('r8', 950, ['critical_chance', 'multishot']), status: 'online' });
      await round(ctx);
      assert.deepEqual(sent.map((s) => s.to).sort(), ['u1', 'u2']);
      assert.match(sent.find((s) => s.to === 'u1')!.text, /auction\/r7/);
      const second = sent.find((s) => s.to === 'u2')!.text;
      assert.ok(second.includes('auction/r8') && !second.includes('auction/r7'), 'the second watch wants no curse and pays more');
    });

    it('a watch the command already seeded announces only what comes after', () => {
      const { store, ctx, spec } = setup();
      const t = store.createTracker(guild, 'u1', JSON.stringify(spec));
      assert.deepEqual(noteMatches(ctx, t.id, spec, forSale), [], 'seeding sends nothing');
      const later = [...forSale, listing('r9', 50, ['critical_chance', 'multishot'])];
      assert.deepEqual(noteMatches(ctx, t.id, spec, later).map((l) => l.id), ['r9']);
      assert.deepEqual(noteMatches(ctx, t.id, spec, later), []);
    });
  });
});

describe('remembering what was seen', () => {
  it('is new once, and stays known while it is seen again', () => {
    const store = new Store(':memory:');
    assert.equal(store.refreshSeen('riven:1:a'), true);
    assert.equal(store.refreshSeen('riven:1:a'), false);
    assert.equal(store.markSeen('riven:1:a'), false, 'the same table as markSeen');
  });
});

/** A scan result with just what the comparison and the picture read. */
const scanned = (weapon: string, letter: 'S' | 'A' | 'B' | 'C' | 'D' | null, deviations: (number | null)[], extra: Record<string, unknown> = {}) =>
  ({
    reading: { weapon: { slug: weapon, name: weapon === 'rubico' ? 'Rubico' : weapon }, positives: [{ slug: 'critical_chance', value: 100 }, { slug: 'multishot', value: 90 }], negative: null, unsureSign: [], unknown: [], statLines: [], guessed: [] },
    names: { critical_chance: 'Critical Chance', multishot: 'Multishot', critical_damage: 'Critical Damage' },
    report: {
      weapon: { slug: weapon, name: weapon === 'rubico' ? 'Rubico' : weapon },
      grade: letter ? { letter, wanted: ['critical_chance', 'critical_damage', 'multishot'], comparable: { count: 4, min: 300, median: 500, max: 900, tenth: null, sameNegative: false, complete: true, source: 'market' }, marketChecked: true } : null,
      rolls: deviations.map((d, i) => ({ slug: `s${i}`, value: 1, curse: false, deviation: d, letter: d === null ? null : 'B', samples: 0 })),
      basis: { source: 'table', kind: 'rifle', multiplier: 1.2, disposition: false },
    },
    problem: null,
    ms: 1,
    lines: 5,
    image: null,
    box: null,
    ...extra,
  }) as never;

describe('which riven to keep', () => {
  it('goes by the bonuses first', () => {
    const text = compareRivens([scanned('rubico', 'C', [9, 9]), scanned('rubico', 'A', [-5, -5])])!;
    assert.match(text, /^\*\*Keep #2\.\*\* Its bonuses are what expensive Rubico rivens have \(grade A; #1 is C\)\. Rivens with its bonuses are listed from 300p\.$/);
  });
  it('then by the rolls', () => {
    const text = compareRivens([scanned('rubico', 'B', [-2, -3]), scanned('rubico', 'B', [5, 6])])!;
    assert.match(text, /^\*\*Keep #2\.\*\* Both have the same kind of bonuses \(grade B\), and its rolls are better \(\+5\.5% on average, against −2\.5% on #1\)/);
  });
  it('calls it even when they are about the same', () => {
    assert.match(compareRivens([scanned('rubico', 'B', [2, 2]), scanned('rubico', 'B', [2.4, 2.2])])!, /^\*\*Either one\.\*\* Both have the same kind of bonuses \(grade B\), and their rolls are about as good/);
  });
  it('compares only rivens of one weapon that were graded', () => {
    assert.equal(compareRivens([scanned('rubico', 'A', [1]), scanned('acceltra', 'B', [1])]), null);
    assert.equal(compareRivens([scanned('rubico', 'A', [1])]), null);
    assert.equal(compareRivens([scanned('rubico', 'A', [1]), scanned('rubico', null, [], { report: null })]), null);
    assert.equal(rollScore(scanned('rubico', 'A', [4, null, 2])), 3);
  });
});

describe('the picture footer', () => {
  it('says what the rolls were measured against and what the bonuses are listed for', () => {
    assert.equal(basisText({ source: 'table', kind: 'pistol', multiplier: 1.1, disposition: true }), 'Pistol riven · disposition 1.1');
    assert.equal(basisText({ source: 'table', kind: 'rifle', multiplier: 1.2, disposition: false }), "Rifle riven · today's range (×1.2)");
    assert.equal(basisText({ source: 'listings' }), 'Graded from the rolls listed for sale');
    assert.equal(basisText(undefined), null);
    assert.equal(saleText(scanned('rubico', 'A', [1])), '4 listed · 300p – 900p · median 500p');
    assert.equal(saleText(scanned('rubico', null, [1])), null);
  });

  it('makes the picture taller, and numbers the pictures when several are answered together', async () => {
    const shot = new PNG({ width: 300, height: 400 });
    shot.data.fill(120);
    const image = { bytes: PNG.sync.write(shot), mime: 'image/png' };
    const plain = scanned('rubico', null, [5, -3], { image });
    const full = scanned('rubico', 'A', [5, -3], { image });
    const short = PNG.sync.read((await rivenPicture(plain))!);
    const tall = PNG.sync.read((await rivenPicture(full, { label: '#1' }))!);
    assert.ok(tall.height > short.height, `${tall.height} > ${short.height}`);
    const both = await rivenReplies([full, scanned('rubico', 'C', [1, 1], { image })]);
    assert.equal(both.files.length, 2);
    assert.match(both.content, /^\*\*Keep #1\.\*\*/);
    const one = await rivenReplies([full]);
    assert.equal(one.content, '', 'one picture needs no verdict');
  });
});
