import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ChatInputCommandInteraction, Client, StringSelectMenuInteraction } from 'discord.js';
import { SHARES, forgetToken } from '../src/alecaframe/api.js';
import { DEFAULT_CRACK_PLAT, DEFAULT_CRACK_QUIET_HOURS, crackPlan } from '../src/alecaframe/crack.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { alecaframe } from '../src/discord/commands/alecaframe.js';
import { now as nowCommand } from '../src/discord/commands/now.js';
import { track } from '../src/discord/commands/track.js';
import { crackDm, crackLines, crackState, crackTrackerOf, notifyCrack, personalLines } from '../src/discord/crack.js';
import { tierEmoji } from '../src/discord/emoji.js';
import { TRACK_OPTIONS } from '../src/discord/feeds/controls.js';
import { handleFeedSelect } from '../src/discord/feeds/handlers.js';
import { componentText } from '../src/discord/feeds/parts.js';
import { MAX_TRACKERS_PER_USER, collectTrackables, describeTracker, matchTracker, parseSpec } from '../src/trackers.js';
import { api } from '../src/warframe/fetch.js';
import { type WfinfoPrice, type WfinfoTable, buildRelicBook, findRelic, relicValue, resetRelicBook } from '../src/warframe/relics.js';
import { type Fissure, type WorldState, configureWorldState } from '../src/warframe/worldstate.js';

const GUILD = '111111111111111111';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 14, 12);
const rel = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

const CHEAP = { uncommon1: 'Boar Prime Barrel', uncommon2: 'Forma Blueprint', common1: 'Paris Prime String', common2: 'Bronco Prime Barrel', common3: 'Lex Prime Receiver' };
const TABLE: WfinfoTable = {
  relics: {
    Axi: { A1: { vaulted: false, rare1: 'Ash Prime Systems', ...CHEAP }, C2: { vaulted: false, rare1: 'Lex Prime Barrel', ...CHEAP } },
    Neo: { V1: { vaulted: true, rare1: 'Valkyr Prime Systems', ...CHEAP } },
    Lith: { B1: { vaulted: false, rare1: 'Braton Prime Receiver', ...CHEAP } },
  },
  ignored_items: { 'Forma Blueprint': {} },
};
const PRICES: WfinfoPrice[] = [
  { name: 'Ash Prime Systems Blueprint', custom_avg: 400 },
  { name: 'Valkyr Prime Systems Blueprint', custom_avg: 600 },
  { name: 'Braton Prime Receiver', custom_avg: 25 },
  { name: 'Lex Prime Barrel', custom_avg: 5 },
  { name: 'Boar Prime Barrel', custom_avg: 10.5 },
  { name: 'Paris Prime String', custom_avg: 4 },
  { name: 'Bronco Prime Barrel', custom_avg: 2 },
  { name: 'Lex Prime Receiver', custom_avg: 3 },
];
const book = buildRelicBook(TABLE, PRICES, NOW, false);
const worth = (name: string, refinement: 'Intact' | 'Exceptional' | 'Flawless' | 'Radiant') => relicValue(findRelic(book, name)!, refinement).solo;

type FissureInit = { tier: string; type?: string; mins?: number; hard?: boolean; storm?: boolean; node?: string };
const fissure = (f: FissureInit, i = 0): Fissure =>
  ({ id: `f${i}`, node: f.node ?? `Node${i} (Earth)`, missionType: f.type ?? 'Capture', enemy: 'Grineer', tier: f.tier, isHard: Boolean(f.hard), isStorm: Boolean(f.storm), expiry: new Date(NOW + (f.mins ?? 40) * MIN).toISOString() }) as unknown as Fissure;
const worldWith = (list: FissureInit[]) => ({ fissures: list.map(fissure) }) as unknown as WorldState;
/** The same fissures as they would be `at` a later moment: open for another 40 minutes from then. */
const openAt = (at: number, list: FissureInit[] = [{ tier: 'Axi', node: 'Hepit (Void)' }, { tier: 'Omnia' }]) =>
  ({ fissures: list.map((f, i) => ({ ...fissure(f, i), expiry: new Date(at + (f.mins ?? 40) * MIN).toISOString() })) }) as unknown as WorldState;

const OWNED = [
  { tier: 'Axi', code: 'A1', refinement: 'Intact', count: 5 },
  { tier: 'Axi', code: 'A1', refinement: 'Radiant', count: 1 },
  { tier: 'Axi', code: 'C2', refinement: 'Intact', count: 9 },
  { tier: 'Axi', code: 'Z9', refinement: 'Radiant', count: 4 },
  { tier: 'Neo', code: 'V1', refinement: 'Flawless', count: 2 },
  { tier: 'Lith', code: 'B1', refinement: 'Intact', count: 3 },
  { tier: 'Requiem', code: 'IV', refinement: 'Radiant', count: 3 },
] as const;

describe('relics worth cracking', () => {
  it('are what a run is expected to pay enough for, per tier, with a quick fissure that takes them', () => {
    // The fixture is only worth something if the numbers fall where the tests need them.
    assert.ok(worth('Axi A1', 'Intact') > 10 && worth('Axi A1', 'Intact') < 12, String(worth('Axi A1', 'Intact')));
    assert.ok(worth('Axi C2', 'Intact') < 5 && worth('Lith B1', 'Intact') < 10);

    const quick = [fissure({ tier: 'Axi', node: 'Hepit (Void)' }, 1), fissure({ tier: 'Neo', hard: true }, 2), fissure({ tier: 'Omnia', node: 'Ur (Uranus)' }, 3), fissure({ tier: 'Lith' }, 4)];
    const plan = crackPlan(OWNED, book, quick, 10);
    assert.deepEqual(plan.map((t) => t.tier), ['Axi', 'Neo'], 'the tier that pays the most first; nothing of Lith is worth it');
    const [axi, neo] = plan;
    assert.equal(neo!.fissure.tier, 'Omnia', 'the Neo fissure is on the Steel Path, so the Omnia one it is');
    assert.equal(neo!.copies, 2);
    assert.ok(Math.abs(neo!.value - 2 * worth('Neo V1', 'Flawless')) < 1e-9);
    assert.equal(axi!.fissure.node, 'Hepit (Void)');
    assert.deepEqual(axi!.relics.map((r) => `${r.name} ${r.refinement} ×${r.count}`), ['Axi A1 Radiant ×1', 'Axi A1 Intact ×5'], 'the cheap relic and the one the tables do not know are left out');
    assert.equal(axi!.copies, 6);
    assert.ok(Math.abs(axi!.value - (worth('Axi A1', 'Radiant') + 5 * worth('Axi A1', 'Intact'))) < 1e-9);

    assert.deepEqual(crackPlan(OWNED, book, quick, 12).find((t) => t.tier === 'Axi')!.relics.map((r) => r.refinement), ['Radiant'], 'a higher bar');
    assert.deepEqual(crackPlan(OWNED, book, quick.filter((f) => f.tier !== 'Omnia'), 10).map((t) => t.tier), ['Axi'], 'no fissure for Neo that everyone can enter');
    assert.deepEqual(crackPlan(OWNED, book, [fissure({ tier: 'Axi', storm: true }), fissure({ tier: 'Requiem' })], 10), []);
    assert.deepEqual(crackPlan([], book, quick, 10), []);
    assert.deepEqual(crackPlan(OWNED, book, [], 10), []);
    assert.deepEqual(crackPlan(OWNED, book, quick), plan, `${DEFAULT_CRACK_PLAT}p unless the member says otherwise`);
    // With more of them, the Neo relics pay more than the Axi ones and come first.
    const manyNeo = OWNED.map((o) => (o.tier === 'Neo' ? { ...o, count: 9 } : o));
    assert.deepEqual(crackPlan(manyNeo, book, quick, 10).map((t) => t.tier), ['Neo', 'Axi']);
  });

  it('are put in a DM: per tier the worth, the fissure and the best relics', () => {
    const quick = [fissure({ tier: 'Axi', node: 'Hepit (Void)' }, 1), fissure({ tier: 'Omnia', node: 'Ur (Uranus)', type: 'Extermination' }, 3)];
    const owned = [...OWNED, { tier: 'Axi', code: 'A1', refinement: 'Flawless', count: 2 }, { tier: 'Axi', code: 'A1', refinement: 'Exceptional', count: 1 }] as const;
    const t = componentText([crackDm(crackPlan(owned, book, quick, 10), { minPlat: 10, quietHours: 12, trackerId: 4 }, null)]);
    assert.match(t, /^### ⚡ A good moment to crack relics\nYou own relics expected to pay \*\*10p or more\*\* a run, and a quick fissure for them is open\.\n/);
    const axiValue = Math.round(worth('Axi A1', 'Radiant') + 2 * worth('Axi A1', 'Flawless') + worth('Axi A1', 'Exceptional') + 5 * worth('Axi A1', 'Intact'));
    assert.ok(t.includes(`**Axi** · 9 relics · about **${axiValue}p** opened alone\n⚡ ${tierEmoji('Axi')} **Axi Capture** · Hepit, Void · closes ${rel(NOW + 40 * MIN)}\n-# Axi A1 Radiant ×1 ≈ ${Math.round(worth('Axi A1', 'Radiant'))}p · Axi A1 Flawless ×2 ≈ ${Math.round(worth('Axi A1', 'Flawless'))}p · Axi A1 Exceptional ×1 ≈ ${Math.round(worth('Axi A1', 'Exceptional'))}p · +1 more`), t);
    assert.ok(t.includes(`**Neo** · 2 relics · about **${Math.round(2 * worth('Neo V1', 'Flawless'))}p** opened alone\n⚡ `), t);
    assert.ok(t.includes('**Omnia Extermination** · Ur, Uranus'));
    assert.match(t, /-# Tracker #4: at most one of these every 12 hours\. Change it with \/track crack, stop it with \/track remove or "My notifications"\.$/);

    const lines = crackLines(crackPlan(OWNED, book, quick, 10), 10);
    assert.equal(lines[0], '**Your relics** · worth cracking in a quick fissure right now');
    assert.match(lines[1]!, /\*\*Axi\*\* · 6 relics · about \d+p · best: Axi A1 Radiant ×1 ≈ \d+p$/);
    assert.match(lines[2]!, /\*\*Neo\*\* · 2 relics · about \d+p · best: Neo V1 Flawless ×2 ≈ \d+p$/);
    assert.match(lines[3]!, /expected to pay 10p or more a run/);
    assert.deepEqual(crackLines([], 10), []);
  });

  it('are a notification of their own kind, which no world state item matches', () => {
    const spec = { kind: 'crack', minPlat: 15, quietHours: 6 } as const;
    assert.equal(describeTracker(spec), 'Crack now: a quick fissure for relics of mine worth 15p or more (at most every 6 h)');
    assert.deepEqual(parseSpec(JSON.stringify(spec)), spec);
    for (const item of collectTrackables(worldWith([{ tier: 'Axi' }, { tier: 'Neo', hard: true }]), NOW)) assert.equal(matchTracker(spec, item), null, item.key);
    const option = TRACK_OPTIONS.find((o) => o.value === 'crack')!;
    assert.deepEqual(option.feeds, ['fissures']);
    assert.deepEqual(option.spec, { kind: 'crack', minPlat: DEFAULT_CRACK_PLAT, quietHours: DEFAULT_CRACK_QUIET_HOURS });
  });
});

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

describe('crack now', () => {
  const realFetch = globalThis.fetch;
  let requests: string[] = [];
  /** What AlecaFrame answers per token: an inventory, or a status. */
  let answers: Record<string, string | number> = {};
  let delayMs = 0;
  /** What the world state relay serves. */
  let world: unknown = {};

  beforeEach(() => {
    resetRelicBook();
    api.reset();
    api.configure({ limits: { minIntervalMs: 0, hostIntervalMs: {} } });
    forgetToken();
    requests = [];
    delayMs = 0;
    answers = {
      // Five Axi A1 intact and one radiant, nine of the cheap Axi C2, two Neo V1 flawless.
      richtoken123: inventory([[3, 0, 'A1', 5], [3, 3, 'A1', 1], [3, 0, 'C2', 9], [2, 2, 'V1', 2]]),
      poortoken123: inventory([[3, 0, 'C2', 9], [0, 0, 'B1', 3]]),
      downtoken123: 500,
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('http://relay.test/')) return json(world);
      if (url.endsWith('/wfinfo/filtered_items')) return json(TABLE);
      if (url.endsWith('/wfinfo/prices')) return json(PRICES);
      if (!url.includes('alecaframe')) return new Response('{}', { status: 404 });
      requests.push(url);
      if (delayMs) await new Promise((done) => setTimeout(done, delayMs));
      const token = /publicToken=([^&]+)/.exec(url)?.[1] ?? '';
      const answer = answers[token];
      if (typeof answer === 'string') return new Response(JSON.stringify(answer), { status: 200 });
      return new Response(JSON.stringify({ detail: 'Invalid token' }), { status: typeof answer === 'number' ? answer : 404 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    configureWorldState({ enabled: false });
    resetRelicBook();
  });

  function server() {
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
    const member = (userId: string, token: string | null, spec: { minPlat?: number; quietHours?: number } | null = {}, parts: number = SHARES.relics) => {
      if (token) store.setAlecaLink(userId, { token, username: userId, parts });
      return spec ? store.createTracker(GUILD, userId, JSON.stringify({ kind: 'crack', minPlat: 10, quietHours: 12, ...spec })).id : 0;
    };
    return { ctx, store, dms, member };
  }

  const OPEN = worldWith([{ tier: 'Axi', node: 'Hepit (Void)' }, { tier: 'Omnia' }]);

  it('DMs a member when a quick fissure is open for relics of theirs worth opening, then keeps quiet for their hours', async () => {
    const { ctx, store, dms, member } = server();
    assert.equal(await notifyCrack(ctx, OPEN, NOW, { book }), 0, 'nobody asked');
    assert.equal(requests.length, 0);

    const id = member('u1', 'richtoken123');
    assert.equal(await notifyCrack(ctx, OPEN, NOW, { book }), 1);
    assert.deepEqual(dms.map((d) => d.to), ['u1']);
    assert.match(dms[0]!.text, /^### ⚡ A good moment to crack relics/);
    assert.ok(dms[0]!.text.includes('**Axi** · 6 relics') && dms[0]!.text.includes('**Neo** · 2 relics'), dms[0]!.text);
    assert.ok(dms[0]!.text.includes(`Tracker #${id}: at most one of these every 12 hours`));
    assert.equal(requests.length, 1);
    assert.match(requests[0]!, /^https:\/\/stats\.alecaframe\.com\/api\/stats\/public\/getRelicInventory\?publicToken=richtoken123$/);
    assert.deepEqual(crackState(store)[id], { lastAt: NOW, checkAt: NOW + 12 * HOUR });

    assert.equal(await notifyCrack(ctx, OPEN, NOW + MIN, { book }), 0);
    assert.equal(await notifyCrack(ctx, openAt(NOW + 12 * HOUR - MIN), NOW + 12 * HOUR - MIN, { book }), 0, 'still quiet');
    assert.equal(requests.length, 1, 'and AlecaFrame is not asked meanwhile');

    const later = NOW + 12 * HOUR;
    assert.equal(await notifyCrack(ctx, openAt(later, [{ tier: 'Axi' }]), later, { book }), 1, 'the quiet time is over');
    assert.equal(dms.length, 2);
    assert.ok(!dms[1]!.text.includes('**Neo**'), 'no fissure takes the Neo relics this time');
  });

  it('asks nothing of AlecaFrame while no fissure is worth walking to', async () => {
    const { ctx, store, member } = server();
    const id = member('u1', 'richtoken123');
    assert.equal(await notifyCrack(ctx, worldWith([{ tier: 'Axi', mins: 19 }, { tier: 'Neo', hard: true }, { tier: 'Axi', type: 'Survival' }, { tier: 'Axi', storm: true }]), NOW, { book }), 0);
    assert.equal(await notifyCrack(ctx, null, NOW, { book }), 0);
    assert.equal(requests.length, 0, 'closing soon, Steel Path, endless, a storm: none of them counts');
    assert.equal(crackState(store)[id], undefined, 'and the member is looked at as soon as one opens');
    assert.equal(await notifyCrack(ctx, worldWith([{ tier: 'Axi', mins: 20 }]), NOW, { book }), 1);
  });

  it('looks again half an hour later when there was nothing to say', async () => {
    const { ctx, store, dms, member } = server();
    const poor = member('poor', 'poortoken123');
    const down = member('down', 'downtoken123');
    const unlinked = member('unlinked', null);
    const unshared = member('unshared', 'richtoken123', {}, SHARES.platinum);
    assert.equal(await notifyCrack(ctx, OPEN, NOW, { book }), 0);
    assert.equal(dms.length, 0);
    for (const id of [poor, down, unlinked, unshared]) assert.deepEqual(crackState(store)[id], { lastAt: 0, checkAt: NOW + 30 * MIN }, String(id));
    assert.equal(requests.length, 2, 'the two links that share relics were read');

    assert.equal(await notifyCrack(ctx, openAt(NOW + 29 * MIN), NOW + 29 * MIN, { book }), 0);
    assert.equal(requests.length, 2, 'not before the half hour is over');
    forgetToken();
    assert.equal(await notifyCrack(ctx, openAt(NOW + 30 * MIN), NOW + 30 * MIN, { book }), 0);
    assert.equal(requests.length, 4, 'then they are read again');

    // A member with a lower bar is told about relics another would leave closed.
    const low = member('low', 'poortoken123', { minPlat: 1 });
    assert.equal(await notifyCrack(ctx, openAt(NOW + 31 * MIN), NOW + 31 * MIN, { book }), 1);
    assert.ok(dms[0]!.text.includes('**Axi** · 9 relics') && dms[0]!.text.includes('expected to pay **1p or more**'), dms[0]!.text);
    assert.equal(crackState(store)[low]!.lastAt, NOW + 31 * MIN);
  });

  it('does not try a member with closed DMs every half hour, and forgets a notification that was removed', async () => {
    const { ctx, store, member } = server();
    const closed = member('closed', 'richtoken123', { quietHours: 6 });
    const gone = member('u2', 'richtoken123');
    assert.equal(await notifyCrack(ctx, OPEN, NOW, { book }), 1, 'only u2 was reached');
    assert.deepEqual(crackState(store)[closed], { lastAt: 0, checkAt: NOW + 6 * HOUR });
    assert.ok(crackState(store)[gone]);

    store.deleteTracker(GUILD, 'u2', gone);
    await notifyCrack(ctx, OPEN, NOW + MIN, { book });
    assert.deepEqual(Object.keys(crackState(store)), [String(closed)]);
    store.deleteTracker(GUILD, 'closed', closed);
    await notifyCrack(ctx, OPEN, NOW + 2 * MIN, { book });
    assert.deepEqual(crackState(store), {});

    // Values that are not numbers fall back to the defaults instead of sending every minute.
    const odd = store.createTracker(GUILD, 'u3', '{"kind":"crack","minPlat":"lots","quietHours":0}').id;
    store.setAlecaLink('u3', { token: 'richtoken123', username: 'u3', parts: 0 });
    assert.equal(await notifyCrack(ctx, OPEN, NOW + 3 * MIN, { book }), 1);
    assert.equal(crackState(store)[odd]!.checkAt, NOW + 3 * MIN + DEFAULT_CRACK_QUIET_HOURS * HOUR);
    store.setMeta('crack_state', '{broken');
    assert.deepEqual(crackState(store), {}, 'a record that cannot be read is an empty one');
  });

  it('adds a member\'s own relics to their /now card, when they can be had in time', async () => {
    const { ctx, member } = server();
    assert.deepEqual(await personalLines(ctx, 'nobody', OPEN, NOW, { waitMs: 500, book }), [], 'not linked');
    assert.equal(requests.length, 0);

    member('u1', 'richtoken123', null);
    const lines = await personalLines(ctx, 'u1', OPEN, NOW, { waitMs: 500, book });
    assert.equal(lines.length, 4);
    assert.match(lines[1]!, /\*\*Axi\*\* · 6 relics/);
    assert.match(lines[3]!, new RegExp(`expected to pay ${DEFAULT_CRACK_PLAT}p or more`));
    assert.deepEqual(await personalLines(ctx, 'u1', worldWith([{ tier: 'Axi', hard: true }]), NOW, { waitMs: 500, book }), [], 'nothing open that everyone can enter');
    assert.deepEqual(await personalLines(ctx, 'u1', null, NOW, { waitMs: 500, book }), []);

    // Their own bar, when they have set one.
    member('u2', 'richtoken123', { minPlat: 12 });
    const strict = await personalLines(ctx, 'u2', OPEN, NOW, { waitMs: 500, book });
    assert.match(strict.find((l) => l.includes('**Axi**'))!, /\*\*Axi\*\* · 1 relic ·/);
    assert.match(strict.at(-1)!, /expected to pay 12p or more/);

    member('poor', 'poortoken123', null);
    assert.deepEqual(await personalLines(ctx, 'poor', OPEN, NOW, { waitMs: 500, book }), [], 'nothing of theirs is worth opening');

    // AlecaFrame answering slowly does not hold the card up; the answer is there for the next one.
    forgetToken();
    delayMs = 120;
    const started = Date.now();
    assert.deepEqual(await personalLines(ctx, 'u1', OPEN, NOW, { waitMs: 20, book }), []);
    assert.ok(Date.now() - started < 100, 'the card was not kept waiting');
    await new Promise((done) => setTimeout(done, 200));
    delayMs = 0;
    assert.equal((await personalLines(ctx, 'u1', OPEN, NOW, { waitMs: 20, book })).length, 4);
  });

  it('shows on the /now card of the member who asked, never on a shared one', async () => {
    const { ctx, member } = server();
    member('u1', 'richtoken123', null);
    const soon = (mins: number) => new Date(Date.now() + mins * MIN).toISOString();
    world = { timestamp: new Date().toISOString(), cetusCycle: { isDay: true, expiry: soon(30) }, fissures: [{ id: 'f1', node: 'Hepit (Void)', missionType: 'Capture', enemy: 'Corrupted', tier: 'Axi', isHard: false, isStorm: false, expiry: soon(40) }] };
    configureWorldState({ enabled: true, intervalSeconds: 600, url: `http://relay.test/${Math.random()}`, store: new Store(':memory:') });
    // The Arbitration schedule cannot be read here: the card says so quietly and goes on.
    const warn = console.warn;
    console.warn = () => {};
    const card = async (userId: string, share: boolean) => {
      const sent: { kind: string; text: string }[] = [];
      const record = (kind: string) => async (o: { components?: { toJSON(): unknown }[] } = {}) => void sent.push({ kind, text: componentText(o.components ?? []) });
      const interaction = { user: { id: userId }, options: { getBoolean: () => share }, reply: record('reply'), deferReply: record('deferReply'), editReply: record('editReply') } as unknown as ChatInputCommandInteraction;
      await nowCommand.execute(interaction, ctx);
      return sent.at(-1)!.text;
    };
    try {
      const mine = await card('u1', false);
      assert.ok(mine.includes('**Quick fissures** · one per relic tier'), mine);
      assert.ok(mine.includes('**Your relics** · worth cracking in a quick fissure right now'), mine);
      assert.match(mine, /\*\*Axi\*\* · 6 relics · about \d+p · best: Axi A1 Radiant ×1/);
      assert.ok(mine.indexOf('Quick fissures') < mine.indexOf('Your relics'), 'right under the fissures');
      assert.ok(!(await card('u1', true)).includes('Your relics'), 'what a member owns is not posted for everyone');
      assert.ok(!(await card('someone-else', false)).includes('Your relics'), 'and nobody sees another member\'s');
    } finally {
      console.warn = warn;
    }
  });

  type Reply = { content?: string };
  function trackCommand(userId: string, ints: Record<string, number | null>) {
    const replies: Reply[] = [];
    const interaction = {
      user: { id: userId },
      options: { getSubcommand: () => 'crack', getInteger: (name: string) => ints[name] ?? null, getString: () => null, getBoolean: () => null },
      reply: async (o: Reply) => void replies.push(o),
    } as unknown as ChatInputCommandInteraction;
    return { interaction, replies };
  }

  it('is set with /track crack once a link shares the relics, and set again to change it', async () => {
    const { ctx, store } = server();
    const set = async (userId: string, ints: Record<string, number | null> = {}) => {
      const c = trackCommand(userId, ints);
      await track.execute(c.interaction, ctx);
      return c.replies[0]!.content ?? '';
    };
    await assert.rejects(set('u1'), /link AlecaFrame first with `\/alecaframe link`/);
    store.setAlecaLink('u1', { token: 'richtoken123', username: 'Rat', parts: SHARES.platinum });
    await assert.rejects(set('u1'), /does not share your relics/);
    assert.equal(store.listTrackers(GUILD, 'u1').length, 0);

    store.setAlecaLink('u1', { token: 'richtoken123', username: 'Rat', parts: SHARES.platinum | SHARES.relics });
    assert.match(await set('u1'), /^Tracker \*\*#\d+\*\* set: Crack now: a quick fissure for relics of mine worth 10p or more \(at most every 12 h\)\. Ordis reads your relics from AlecaFrame/);
    assert.deepEqual(crackTrackerOf(store, GUILD, 'u1')!.spec, { kind: 'crack', minPlat: 10, quietHours: 12 });
    await assert.rejects(set('u1'), /You already have that one/);

    assert.match(await set('u1', { worth: 25, quiet: 6 }), /^Tracker \*\*#\d+\*\* changed: Crack now: .* worth 25p or more \(at most every 6 h\)/);
    assert.deepEqual(store.listTrackers(GUILD, 'u1').map((t) => parseSpec(t.spec)), [{ kind: 'crack', minPlat: 25, quietHours: 6 }], 'one per member');

    // At the limit it can still be changed, but not added.
    for (let i = store.listTrackers(GUILD, 'u1').length; i < MAX_TRACKERS_PER_USER; i++) store.createTracker(GUILD, 'u1', JSON.stringify({ kind: 'reward', keyword: `thing${i}` }));
    assert.match(await set('u1', { worth: 30 }), /changed/);
    assert.equal(store.listTrackers(GUILD, 'u1').length, MAX_TRACKERS_PER_USER);
    store.setAlecaLink('u2', { token: 'poortoken123', username: 'Mouse', parts: 0 });
    for (let i = 0; i < MAX_TRACKERS_PER_USER; i++) store.createTracker(GUILD, 'u2', JSON.stringify({ kind: 'reward', keyword: `thing${i}` }));
    await assert.rejects(set('u2'), /You already have 15 trackers/);
  });

  it('is offered in the fissure board\'s menu, to members whose link shares their relics', async () => {
    const { ctx, store } = server();
    const pick = async (userId: string) => {
      const sent: string[] = [];
      const interaction = {
        customId: 'feeds:track:fissures',
        values: ['crack', 'fissure-capture'],
        user: { id: userId },
        message: { id: 'not-a-board-message' },
        deferUpdate: async () => {},
        followUp: async (o: { components: { toJSON(): unknown }[] }) => void sent.push(componentText(o.components)),
      } as unknown as StringSelectMenuInteraction;
      await handleFeedSelect(interaction, ctx);
      return sent[0]!;
    };
    const refused = await pick('u1');
    assert.ok(refused.includes('link AlecaFrame first with `/alecaframe link`'), refused);
    assert.ok(refused.includes('• Capture fissure'), 'the other pick is set all the same');
    assert.equal(crackTrackerOf(store, GUILD, 'u1'), null);

    store.setAlecaLink('u1', { token: 'richtoken123', username: 'Rat', parts: SHARES.relics });
    assert.ok((await pick('u1')).includes('• Crack now: a quick fissure for relics of mine worth 10p or more (at most every 12 h)'));
    assert.ok(crackTrackerOf(store, GUILD, 'u1'));

    // Changed with /track crack since: the menu does not add a second one.
    store.deleteTracker(GUILD, 'u1', crackTrackerOf(store, GUILD, 'u1')!.id);
    store.createTracker(GUILD, 'u1', JSON.stringify({ kind: 'crack', minPlat: 40, quietHours: 3 }));
    const had = await pick('u1');
    assert.match(had, /Already set:\n(• .*\n)*• Crack now: .* worth 40p or more \(at most every 3 h\)/);
    assert.equal(store.listTrackers(GUILD, 'u1').filter((t) => parseSpec(t.spec)?.kind === 'crack').length, 1);
  });

  it('goes with the AlecaFrame link when a member unlinks', async () => {
    const { ctx, store, member } = server();
    member('u1', 'richtoken123');
    store.createTracker(GUILD, 'u1', '{"kind":"baro"}');
    const unlink = async (userId: string) => {
      const replies: Reply[] = [];
      const interaction = { user: { id: userId }, options: { getSubcommand: () => 'unlink' }, reply: async (o: Reply) => void replies.push(o) } as unknown as ChatInputCommandInteraction;
      await alecaframe.execute(interaction, ctx);
      return replies[0]!.content ?? '';
    };
    assert.match(await unlink('u1'), /^✅ Unlinked\. Ordis no longer has your AlecaFrame token, and your "crack now" notification is off with it\./);
    assert.equal(store.getAlecaLink('u1'), null);
    assert.deepEqual(store.listTrackers(GUILD, 'u1').map((t) => parseSpec(t.spec)), [{ kind: 'baro' }], 'the other notifications stay');
    assert.equal(await unlink('u1'), 'Your AlecaFrame is not linked.');

    store.setAlecaLink('u2', { token: 'poortoken123', username: 'Mouse', parts: SHARES.relics });
    assert.match(await unlink('u2'), /^✅ Unlinked\. Ordis no longer has your AlecaFrame token\. To stop/);
  });
});
