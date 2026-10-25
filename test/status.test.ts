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
  return { config, store: new Store(':memory:'), client: { isReady: () => false } as unknown as Client, ai: null };
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
