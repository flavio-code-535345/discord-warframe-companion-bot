import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { findInactive } from '../src/activity/service.js';
import { assertValidBirthday, birthdaysOn, daysUntil } from '../src/birthdays/service.js';
import { drawWinners, renderGiveaway } from '../src/giveaways/service.js';
import { rolesPanel } from '../src/selfroles/service.js';
import { describeTracker, priceDecision } from '../src/trackers.js';
import { componentText } from '../src/discord/feeds/parts.js';
import { postWeeklyReset, weeklyCard, weeklyDue } from '../src/discord/weekly.js';
import { weekStart } from '../src/time.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const G = '111111111111111111';
const DAY = 86_400_000;
/** The JSON of a discord.js builder (embeds and rows come back typed as builders or plain data). */
const json = <T = Record<string, unknown>>(x: unknown): T => (x as { toJSON(): T }).toJSON();
const ctx = { config: { CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Cephalon Ordis', DISCORD_GUILD_ID: G }, client: { user: null }, store: new Store(':memory:') } as unknown as AppContext;
/** The custom IDs of a panel's buttons, row by row. */
const buttonRows = (panel: { components?: unknown }) => (panel.components as unknown[]).map((r) => json<{ components: { custom_id: string }[] }>(r).components.map((c) => c.custom_id));
const NOTIFY_ROW = ['notify:clanEvent', 'notify:squad', 'notify:weekly', 'feeds:mine'];

describe('self-assign roles', () => {
  it('keeps the groups in the order they were added, each with its own row of buttons, and ends with the notifications', () => {
    const store = new Store(':memory:');
    store.upsertSelfRole(G, { roleId: '1', group: 'Platform', label: 'PC', emoji: '🖥️', description: null, position: 0 });
    store.upsertSelfRole(G, { roleId: '2', group: 'Region', label: 'Europe', emoji: null, description: 'Evenings in CET', position: 1 });
    store.upsertSelfRole(G, { roleId: '3', group: 'Platform', label: 'PlayStation', emoji: null, description: null, position: 2 });
    const panel = rolesPanel(ctx, store.listSelfRoles(G));
    const embed = json(panel.embeds![0]) as { fields: { name: string; value: string; inline: boolean }[] };
    assert.deepEqual(
      embed.fields.map((f) => [f.name, f.inline]),
      [['Platform', true], ['Region', false], ['🔔 Notifications', false]],
      'a group without descriptions is compact',
    );
    assert.match(embed.fields[1]!.value, /\*\*Europe\*\*\n-# Evenings/);
    assert.deepEqual(buttonRows(panel), [['roles:1', 'roles:3'], ['roles:2'], NOTIFY_ROW]);
  });

  it('says where notifications are picked: under the boards that are set up, else with /track', () => {
    const store = new Store(':memory:');
    const c = { ...ctx, store } as unknown as AppContext;
    const notifications = () => (json(rolesPanel(c, []).embeds![0]) as { fields: { name: string; value: string }[] }).fields.at(-1)!.value;
    assert.match(notifications(), /Ordis pings no role/);
    assert.match(notifications(), /Pick it with `\/track`/);
    store.updateSettings(G, { fissuresChannelId: '222', tradersChannelId: '333' });
    assert.match(notifications(), /under a board: <#222> <#333>/);
    assert.deepEqual(buttonRows(rolesPanel(c, [])), [NOTIFY_ROW], 'the notifications row is there even with no role to pick');
  });

  it('puts at most five buttons in a row', () => {
    const roles = Array.from({ length: 12 }, (_, i) => ({ roleId: String(i), group: 'G', label: `R${i}`, emoji: null, description: null, position: i }));
    const rows = buttonRows(rolesPanel(ctx, roles));
    assert.deepEqual(rows.map((r) => r.length), [5, 5, 2, 4]);
  });

  it('packs the buttons together when a row per group would need more than four rows, so the notifications always fit', () => {
    const roles = Array.from({ length: 6 }, (_, i) => ({ roleId: String(i), group: `G${i}`, label: `R${i}`, emoji: null, description: null, position: i }));
    assert.deepEqual(buttonRows(rolesPanel(ctx, roles)).map((r) => r.length), [5, 1, 4]);
    // The most the menu holds (20 roles) still leaves the fifth row for the notifications.
    const full = Array.from({ length: 25 }, (_, i) => ({ roleId: String(i), group: `G${i % 7}`, label: `R${i}`, emoji: null, description: null, position: i }));
    assert.deepEqual(buttonRows(rolesPanel(ctx, full)).map((r) => r.length), [5, 5, 5, 5, 4]);
  });

  it('a changed entry keeps its place, a removed one is gone', () => {
    const store = new Store(':memory:');
    store.upsertSelfRole(G, { roleId: '1', group: 'Platform', label: 'Alerts', emoji: null, description: null, position: 0 });
    store.upsertSelfRole(G, { roleId: '1', group: 'Platform', label: 'World alerts', emoji: '🚨', description: null, position: 0 });
    assert.deepEqual(store.listSelfRoles(G).map((r) => r.label), ['World alerts']);
    assert.equal(store.deleteSelfRole(G, '1'), true);
    assert.equal(store.listSelfRoles(G).length, 0);
  });
});

describe('inactivity report', () => {
  const now = Date.UTC(2026, 11, 1);
  const since = now - 90 * DAY;
  const members = [
    { userId: 'talker', name: 'Talker', joinedAt: now - 300 * DAY, bot: false },
    { userId: 'voice', name: 'Voice', joinedAt: now - 300 * DAY, bot: false },
    { userId: 'quiet', name: 'Quiet', joinedAt: now - 300 * DAY, bot: false },
    { userId: 'gone', name: 'Gone', joinedAt: now - 300 * DAY, bot: false },
    { userId: 'new', name: 'New', joinedAt: now - 3 * DAY, bot: false },
    { userId: 'bot', name: 'Bot', joinedAt: now - 300 * DAY, bot: true },
  ];

  it('flags members silent for longer than the limit, the longest silent first', () => {
    const store = new Store(':memory:');
    store.touchActivity(G, 'talker', 'message', now - DAY);
    store.touchActivity(G, 'voice', 'message', now - 60 * DAY);
    store.touchActivity(G, 'voice', 'voice', now - 2 * DAY);
    store.touchActivity(G, 'quiet', 'message', now - 45 * DAY);
    const out = findInactive(members, store.memberActivity(G), { now, days: 30, trackingSince: since });
    assert.deepEqual(out.map((m) => m.userId), ['gone', 'quiet'], 'never seen first, the newcomer and the bot are left out');
    assert.equal(out[0]!.lastSeen, null);
  });

  it('flags nobody without a record while tracking is younger than the limit', () => {
    const out = findInactive(members, new Map(), { now, days: 30, trackingSince: now - 5 * DAY });
    assert.deepEqual(out, []);
  });
});

describe('price trackers', () => {
  it('alert once at the limit, quiet until the price went back up', () => {
    assert.equal(priceDecision(40, 38, false), 'alert');
    assert.equal(priceDecision(40, 40, false), 'alert');
    assert.equal(priceDecision(40, 35, true), 'none');
    assert.equal(priceDecision(40, 45, true), 'reset');
    assert.equal(priceDecision(40, 45, false), 'none');
    assert.equal(priceDecision(40, null, false), 'none', 'nobody online selling');
  });

  it('describe themselves', () => {
    assert.equal(describeTracker({ kind: 'price', slug: 'arcane_energize', name: 'Arcane Energize', below: 40 }), 'Arcane Energize at 40p or less on warframe.market');
  });
});

describe('weekly reset post', () => {
  const monday = Date.UTC(2026, 10, 2);
  const ws = (activation: number) =>
    ({
      archonHunt: { id: 'a', boss: 'Archon Nira', activation: new Date(activation).toISOString(), expiry: new Date(activation + 7 * DAY).toISOString(), missions: [{ type: 'Survival', node: 'Mot (Void)' }] },
      steelPath: { currentReward: { name: 'Umbra Forma Blueprint', cost: 150 }, rotation: [], expiry: new Date(monday + 7 * DAY).toISOString() },
      duviriCycle: { choices: [{ category: 'normal', choices: ['Mesa', 'Nidus'] }, { category: 'hard', choices: ['Braton', 'Lato'] }] },
      nightwave: { activeChallenges: [{ isDaily: true, isElite: false, title: 'Daily', desc: 'x', reputation: 1000 }, { isDaily: false, isElite: true, title: 'Elite One', desc: 'Kill things', reputation: 7000 }] },
    }) as unknown as WorldState;

  it('finds the Monday 00:00 UTC of the week', () => {
    assert.equal(weekStart(monday + 3 * DAY + 5 * 3_600_000), monday);
    assert.equal(weekStart(monday), monday);
    assert.equal(weekStart(monday - 1), monday - 7 * DAY, 'Sunday 23:59 is still the week before');
  });

  it('waits for the new week to show in the world state, but not forever', () => {
    assert.equal(weeklyDue(ws(monday - 7 * DAY), 0, monday + 600_000), null, 'still last week\'s Archon Hunt');
    assert.equal(weeklyDue(ws(monday), 0, monday + 600_000), monday);
    assert.equal(weeklyDue(ws(monday - 7 * DAY), 0, monday + 7 * 3_600_000), monday, 'after six hours it posts anyway');
    assert.equal(weeklyDue(ws(monday), monday, monday + 600_000), null, 'once per week');
  });

  it('shows the Circuit, only the weekly Nightwave challenges, the Archon Hunt and Steel Path in one card', () => {
    const text = componentText([weeklyCard(ws(monday), monday, monday + 600_000)]);
    assert.match(text, /Mesa, Nidus/);
    assert.match(text, /Braton, Lato/);
    assert.match(text, /Elite One/);
    assert.doesNotMatch(text, /Daily/);
    assert.match(text, /### .* Archon Hunt · Archon Nira/);
    assert.match(text, /Amber Archon Shard/);
    assert.match(text, /Umbra Forma Blueprint/);
    assert.doesNotMatch(text, /Weeklies by DM/, 'no button in a DM');
    assert.match(componentText([weeklyCard(ws(monday), monday, monday + 600_000, true)]), /\[Weeklies by DM\]$/, 'the channel post ends with the button');
  });
});

describe('giveaways', () => {
  it('draw different winners, never more than entered, skipping earlier winners', () => {
    const entries = ['a', 'b', 'c', 'd'];
    const w = drawWinners(entries, 2);
    assert.equal(w.length, 2);
    assert.equal(new Set(w).size, 2);
    assert.deepEqual(drawWinners(['a'], 3), ['a']);
    assert.deepEqual(drawWinners(entries, 4, ['a', 'b']).sort(), ['c', 'd']);
    assert.deepEqual(drawWinners(entries, 1, [], () => 0), ['b'], 'a fixed random source gives a fixed draw');
  });

  it('a second tap leaves again; the ended post lists the winners without a button', () => {
    const store = new Store(':memory:');
    const g = store.createGiveaway({ guildId: G, channelId: 'c', hostId: 'h', prize: 'Wisp Prime', winners: 1, endsAt: Date.now() + DAY });
    assert.equal(store.toggleGiveawayEntry(g.id, 'u1'), true);
    assert.equal(store.toggleGiveawayEntry(g.id, 'u2'), true);
    assert.equal(store.toggleGiveawayEntry(g.id, 'u1'), false);
    assert.deepEqual(store.giveawayEntries(g.id), ['u2']);
    assert.equal(renderGiveaway(ctx, g, 1).components!.length, 1);
    store.endGiveaway(g.id, ['u2']);
    const ended = store.getGiveaway(g.id)!;
    assert.deepEqual(ended.winnerIds, ['u2']);
    const view = renderGiveaway(ctx, ended, 1);
    assert.equal(view.components!.length, 0);
    assert.match(JSON.stringify(json(view.embeds![0])), /<@u2>/);
    assert.deepEqual(store.giveawaysDue(Date.now() + 2 * DAY).length, 0, 'an ended one is not due again');
  });
});

describe('birthdays', () => {
  it('refuses days a month does not have', () => {
    assert.throws(() => assertValidBirthday(4, 31), /April has no day 31/);
    assert.doesNotThrow(() => assertValidBirthday(2, 29));
  });

  it("finds today's, and wishes a 29 February birthday on the 28th in other years", () => {
    const list = [
      { userId: 'a', month: 3, day: 1 },
      { userId: 'leap', month: 2, day: 29 },
    ];
    assert.deepEqual(birthdaysOn(list, Date.UTC(2027, 2, 1, 9)).map((b) => b.userId), ['a']);
    assert.deepEqual(birthdaysOn(list, Date.UTC(2027, 1, 28, 9)).map((b) => b.userId), ['leap']);
    assert.deepEqual(birthdaysOn(list, Date.UTC(2028, 1, 28, 9)).map((b) => b.userId), [], '2028 has a 29th');
  });

  it('counts the days to the next one', () => {
    const now = Date.UTC(2026, 11, 30, 15);
    assert.equal(daysUntil({ userId: 'a', month: 12, day: 30 }, now), 0);
    assert.equal(daysUntil({ userId: 'a', month: 1, day: 2 }, now), 3);
  });
});

describe('weekly reset DMs', () => {
  const monday = Date.UTC(2026, 10, 2);
  const ws = {
    archonHunt: { id: 'a', boss: 'Archon Boreal', activation: new Date(monday).toISOString(), expiry: new Date(monday + 7 * DAY).toISOString(), missions: [] },
    steelPath: { currentReward: { name: 'Umbra Forma Blueprint', cost: 150 }, rotation: [], expiry: new Date(monday + 7 * DAY).toISOString() },
  } as unknown as WorldState;

  /** A weekly channel and DMs that are recorded. Nothing here reads the member list: the weekly post goes to whoever asked for it. */
  function setup() {
    const store = new Store(':memory:');
    const posted: unknown[] = [];
    const dms: string[] = [];
    const channel = { isSendable: () => true, guildId: G, id: 'weekly', send: async (p: unknown) => posted.push(p) };
    const client = {
      user: null,
      guilds: { fetch: async () => assert.fail('the member list is not needed') },
      channels: { fetch: async () => channel },
      users: { fetch: async (id: string) => ({ send: async () => dms.push(id) }) },
    };
    const c = { config: { CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Cephalon Ordis', DISCORD_GUILD_ID: G }, store, client } as unknown as AppContext;
    return { c, store, posted, dms };
  }

  it('DMs everyone who asked for it once, besides the channel post', async () => {
    const { c, store, posted, dms } = setup();
    store.updateSettings(G, { weeklyChannelId: 'weekly' });
    store.createTracker(G, 'one', JSON.stringify({ kind: 'weekly' }));
    store.createTracker(G, 'two', JSON.stringify({ kind: 'weekly' }));
    store.createTracker(G, 'two', JSON.stringify({ kind: 'baro' }));
    store.createTracker(G, 'other', JSON.stringify({ kind: 'sortie' }));
    await postWeeklyReset(c, ws, monday + 600_000);
    assert.equal(posted.length, 1);
    assert.deepEqual(dms.sort(), ['one', 'two']);
    await postWeeklyReset(c, ws, monday + 3_600_000);
    assert.equal(dms.length, 2, 'once per week');
  });

  it('sends the DMs even without a channel', async () => {
    const { c, store, posted, dms } = setup();
    store.createTracker(G, 'subscriber', JSON.stringify({ kind: 'weekly' }));
    await postWeeklyReset(c, ws, monday + 600_000);
    assert.equal(posted.length, 0);
    assert.deepEqual(dms, ['subscriber']);
  });

  it('describes the subscription', () => {
    assert.equal(describeTracker({ kind: 'weekly' }), 'The weekly reset summary (Mondays)');
  });
});
