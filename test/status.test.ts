import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { type ArbitrationData, ArbitrationSchedule, parseTiers } from '../src/warframe/arbitrations.js';
import type { WorldState } from '../src/warframe/worldstate.js';
import { buildStatus, renderStatusPage } from '../src/web/status.js';

const GUILD = '111111111111111111';
const HOUR = 3_600_000;

/** Every hour from the current one for 8 days: Hydron (A), Cytherean (S), Romula (B) and Gaia (C) in turn. */
function schedule(): ArbitrationData {
  const h0 = Math.floor(Date.now() / HOUR) * HOUR;
  const nodes = ['SolNode195', 'SolNode23', 'ClanNode0', 'SolNode85'];
  const text = Array.from({ length: 8 * 24 }, (_, i) => `${(h0 + i * HOUR) / 1000},${nodes[i % nodes.length]}`).join('\n');
  return { schedule: ArbitrationSchedule.parse(text), tiers: parseTiers('SolNode23: "S",\nSolNode195: "A",\nClanNode0: "B",\nSolNode85: "C",'), stale: false, fetchedAt: h0 };
}
const noSchedule = () => null;

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

test('the page has a headline strip, grouped sections, fissure filters and folded event missions', async () => {
  const later = new Date(Date.now() + 3_600_000);
  const event = (id: string, type: string, node: string) => ({ id, expiry: later, mission: { description: 'Event Alert Title', type, node, faction: 'Infested', reward: { countedItems: [{ count: 50, type: 'Road To Tau Event Resource' }] } } });
  const ws = {
    ...fakeWorldState(),
    sortie: { boss: 'Alad V', faction: 'Corpus', expiry: later, variants: [] },
    fissures: [
      { tier: 'Axi', missionType: 'Survival', node: 'Mot (Void)', isHard: true, isStorm: false, expiry: later },
      { tier: 'Lith', missionType: 'Capture', node: 'Cluster (Veil)', isHard: false, isStorm: true, expiry: later },
    ],
    alerts: [event('e1', 'Survival', 'Naeglar (Eris)'), event('e2', 'Defense', 'Saxis (Eris)')],
  } as unknown as WorldState;
  const s = await buildStatus(ctx(), async () => ws, noSchedule);
  assert.deepEqual(s.world?.alerts.map((a) => [a.name, a.count, a.where, a.notable]), [['Event missions', 2, ['Survival · Naeglar (Eris)', 'Defense · Saxis (Eris)'], false]]);
  assert.deepEqual(s.world?.fissureList.map((f) => [f.tier, f.steelPath, f.storm]), [['Lith', false, true], ['Axi', true, false]]);
  assert.equal(s.arbitration, null, 'no schedule and no Arbitration in the world state');
  const html = renderStatusPage(s, 'n', () => null);
  for (const text of ['class="strip"', 'Open worlds', 'The Void', 'Resets', 'Events and trading', 'data-kind="sp"', 'data-tier="Axi"', 'Event missions', '×2', 'Arbitration schedule can not be read']) assert.ok(html.includes(text), text);
  assert.ok(!html.includes('<img class="ico"'), 'no icon without a custom emoji');
  assert.ok(html.includes("connect-src") === false, 'the CSP is set by the server, not the page');
});

test('tiles carry the Warframe icon of their kind when the clan has the emoji', async () => {
  const s = await buildStatus(ctx(), async () => fakeWorldState(), schedule);
  const html = renderStatusPage(s, 'n', (name) => (name === 'arbitration' ? 'https://cdn.discordapp.com/emojis/222.png?size=48' : null));
  assert.equal(html.match(/<img class="ico" src="https:\/\/cdn\.discordapp\.com\/emojis\/222\.png\?size=48"/g)?.length, 2, 'the Arbitration tile and its headline');
});

test('the Arbitration comes from the schedule, with its tier, the next hours and the best of the week, also without a world state', async () => {
  const s = await buildStatus(
    ctx(),
    async () => {
      throw new Error('down');
    },
    schedule,
  );
  const a = s.arbitration!;
  assert.deepEqual([a.now?.tier, a.now?.node, a.now?.planet, a.now?.mission, a.now?.faction, a.trusted], ['A', 'Hydron', 'Sedna', 'Defense', 'Grineer', true]);
  assert.deepEqual(a.next.map((h) => `${h.tier} ${h.node}`), ['S Cytherean', 'B Romula', 'C Gaia', 'A Hydron', 'S Cytherean', 'B Romula']);
  assert.equal(a.best.length, 8);
  assert.ok(a.best.every((h) => h.tier === 'S' || h.tier === 'A'));
  assert.ok(Date.parse(a.best[0]!.startsAt) > Date.now(), 'only hours still to come');
  const html = renderStatusPage(s, 'n', () => null);
  for (const text of ['class="tier tier-a"', 'class="tier tier-s"', '<b>Hydron</b>, Sedna', 'a very good node', 'Next hours', 'Best of the week', 'data-local="t"', 'browse.wf']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /<span class="sl">Arbitration<\/span><b class="sv"><span class="tier tier-a"[^>]*>A<\/span>Hydron<\/b>/, 'the headline works without a world state');
});

test('when the game names another node than the schedule, only the current hour is shown', async () => {
  const ws = {
    ...fakeWorldState(),
    arbitration: { node: 'Gaia (Earth)', type: 'Interception', enemy: 'Grineer', expired: false, activation: new Date(Date.now() - 60_000), expiry: new Date(Date.now() + 600_000) },
  } as unknown as WorldState;
  const s = await buildStatus(ctx(), async () => ws, schedule);
  assert.equal(s.arbitration?.trusted, false);
  assert.equal(s.arbitration?.now?.node, 'Gaia (Earth)');
  assert.deepEqual([s.arbitration?.next, s.arbitration?.best], [[], []]);
  assert.ok(renderStatusPage(s, 'n', () => null).includes('disagree'));
});

test('the page still renders without a world state', async () => {
  const s = await buildStatus(
    ctx(),
    async () => {
      throw new Error('down');
    },
    noSchedule,
  );
  const html = renderStatusPage(s, 'n', () => null);
  assert.ok(!html.includes('class="strip"') || html.includes('Next change') === false);
  assert.ok(html.includes('World state unavailable'));
});
