import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import type { WorldState } from '../src/warframe/worldstate.js';
import { buildStatus, renderStatusPage } from '../src/web/status.js';

const GUILD = '111111111111111111';

function ctx(): AppContext {
  const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD });
  return { config, store: new Store(':memory:'), client: { isReady: () => false } as unknown as Client };
}

const soon = () => new Date(Date.now() + 600_000);
const fakeWorldState = () =>
  ({
    cetusCycle: { isDay: true, expiry: soon() },
    vallisCycle: { isWarm: false, expiry: soon() },
    cambionCycle: { state: 'vome', expiry: soon() },
    zarimanCycle: { state: 'corpus', expiry: soon() },
    earthCycle: { isDay: false, expiry: soon() },
    duviriCycle: { state: 'joy', expiry: soon(), choices: [{ category: 'normal', choices: ['Hydroid', 'Limbo'] }] },
  }) as unknown as WorldState;

test('buildStatus reports offline bot, events with RSVP counts only, and cycles', async () => {
  const c = ctx();
  const event = c.store.createEvent({ guildId: GUILD, title: 'Eidolons', description: null, startsAt: Date.now() + 3_600_000, createdBy: 'u1' });
  c.store.setRsvp(event.id, 'u1', 'going');
  c.store.setRsvp(event.id, 'u2', 'maybe');
  c.store.upsertMember({ guildId: GUILD, userId: 'u1', ign: 'RatKing', masteryRank: null, platform: null });

  const s = await buildStatus(c, async () => fakeWorldState());
  assert.equal(s.online, false);
  assert.equal(s.server, null);
  assert.equal(s.botName, 'Cephalon Ordis');
  assert.equal(s.registeredMembers, 1);
  assert.deepEqual(s.upcomingEvents.map((e) => [e.title, e.going, e.maybe]), [['Eidolons', 1, 1]]);
  assert.deepEqual(s.cycles?.map((x) => `${x.name}: ${x.state}`), [
    'Cetus: Day',
    'Orb Vallis: Cold',
    'Cambion Drift: Vome',
    'Zariman: Corpus control',
    'Earth: Night',
    'Duviri: Joy',
  ]);
  assert.equal(s.cycles?.at(-1)?.note, 'Circuit: Hydroid, Limbo');
});

test('buildStatus marks cycles unavailable when the worldstate fails', async () => {
  const s = await buildStatus(ctx(), async () => {
    throw new Error('down');
  });
  assert.equal(s.cycles, null);
});

test('renderStatusPage escapes user-provided text and applies the nonce', async () => {
  const c = ctx();
  c.store.createEvent({ guildId: GUILD, title: '<script>alert(1)</script>', description: null, startsAt: Date.now() + 60_000, createdBy: 'u1' });
  const html = renderStatusPage(await buildStatus(c, async () => fakeWorldState()), 'abc123');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('<script nonce="abc123">'));
  assert.ok(html.includes('Offline'));
  assert.ok(html.includes('Zariman'));
});

test('world tiles come from the worldstate and tolerate missing sections', async () => {
  const later = new Date(Date.now() + 3_600_000);
  const ws = {
    ...fakeWorldState(),
    sortie: { boss: 'Alad V', faction: 'Corpus', expiry: later, variants: [{ missionType: 'Survival', node: 'Mot (Void)', modifier: 'Eximus Stronghold' }] },
    fissures: [
      { tier: 'Axi', isHard: true, isStorm: false, expiry: later },
      { tier: 'Axi', isHard: false, isStorm: false, expiry: later },
      { tier: 'Lith', isHard: false, isStorm: true, expiry: later },
    ],
    dailyDeals: [{ item: 'Mire', salePrice: 45, originalPrice: 150, discount: 70, total: 10, sold: 4, expiry: later }],
    invasions: [{ completed: false, node: 'Pallas', vsInfestation: true, completion: 40, defender: { reward: { items: ['Orokin Catalyst Blueprint'] } } }],
  } as unknown as WorldState;
  const s = await buildStatus(ctx(), async () => ws);
  assert.equal(s.world?.sortie?.boss, 'Alad V');
  assert.deepEqual(s.world?.fissures, [
    { tier: 'Lith', normal: 0, steelPath: 0, storm: 1 },
    { tier: 'Axi', normal: 1, steelPath: 1, storm: 0 },
  ]);
  assert.equal(s.world?.darvo?.left, 6);
  assert.equal(s.world?.invasions[0]?.notable, true);
  // Sections the worldstate didn't include are simply absent rather than breaking the page.
  assert.equal(s.world?.archon, null);
  assert.deepEqual(s.world?.events, []);
  const html = renderStatusPage(s, 'n');
  for (const text of ['Sortie', 'Alad V', 'Void fissures', "Darvo's deal", 'Invasions', '★']) assert.ok(html.includes(text), text);
});

test('the page has a headline strip, grouped sections, fissure filters, the arbitration and folded event missions', async () => {
  const later = new Date(Date.now() + 3_600_000);
  const event = (id: string, type: string, node: string) => ({ id, expiry: later, mission: { description: 'Event Alert Title', type, node, faction: 'Infested', reward: { countedItems: [{ count: 50, type: 'Road To Tau Event Resource' }] } } });
  const ws = {
    ...fakeWorldState(),
    arbitration: { node: 'Hydron (Sedna)', type: 'Survival', enemy: 'Grineer', archwing: false, sharkwing: false, expired: false, activation: new Date(Date.now() - 60_000), expiry: later },
    sortie: { boss: 'Alad V', faction: 'Corpus', expiry: later, variants: [] },
    fissures: [
      { tier: 'Axi', missionType: 'Survival', node: 'Mot (Void)', isHard: true, isStorm: false, expiry: later },
      { tier: 'Lith', missionType: 'Capture', node: 'Cluster (Veil)', isHard: false, isStorm: true, expiry: later },
    ],
    alerts: [event('e1', 'Survival', 'Naeglar (Eris)'), event('e2', 'Defense', 'Saxis (Eris)')],
  } as unknown as WorldState;
  const s = await buildStatus(ctx(), async () => ws);
  assert.equal(s.world?.arbitration?.type, 'Survival');
  assert.equal(s.world?.alerts.length, 1);
  assert.equal(s.world?.alerts[0]?.count, 2);
  assert.deepEqual(s.world?.fissureList.map((f) => [f.tier, f.steelPath, f.storm]), [['Lith', false, true], ['Axi', true, false]]);
  const html = renderStatusPage(s, 'n');
  for (const text of ['class="strip"', 'Open worlds', 'The Void', 'Resets', 'Events and trading', 'data-kind="sp"', 'data-tier="Axi"', 'Arbitration', 'Hydron (Sedna)', '2 event missions']) assert.ok(html.includes(text), text);
  assert.ok(html.includes("connect-src") === false, 'the CSP is set by the server, not the page');
});

test('the page still renders without a world state', async () => {
  const s = await buildStatus(ctx(), async () => {
    throw new Error('down');
  });
  const html = renderStatusPage(s, 'n');
  assert.ok(!html.includes('class="strip"') || html.includes('Next change') === false);
  assert.ok(html.includes('World state unavailable'));
});
