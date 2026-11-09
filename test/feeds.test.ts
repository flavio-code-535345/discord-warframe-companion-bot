import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { BOUNTY_SYNDICATES } from '../src/discord/embeds.js';
import { EMOJI, loadEmojis } from '../src/discord/emoji.js';
import { alertPings, groupAlerts } from '../src/discord/feeds/alerts.js';
import { arbitrationPings, planMessage } from '../src/discord/feeds/arbitrations.js';
import { TRACK_OPTIONS, notifyRow, sameSpec } from '../src/discord/feeds/controls.js';
import { handleFeedSelect } from '../src/discord/feeds/handlers.js';
import { FEEDS, feedHealth, feedOfChannel, syncFeeds } from '../src/discord/feeds/index.js';
import { invasionPings } from '../src/discord/feeds/invasions.js';
import { card, compact, componentText, fit, messageStats } from '../src/discord/feeds/parts.js';
import { traderPings } from '../src/discord/feeds/traders.js';
import { FEED_IDS, type FeedInput } from '../src/discord/feeds/types.js';
import { MAX_TRACKERS_PER_USER, parseSpec } from '../src/trackers.js';
import { type ArbitrationData, ArbitrationSchedule, arbitrationView, parseTiers } from '../src/warframe/arbitrations.js';
import { type WorldState, resurgenceItemName } from '../src/warframe/worldstate.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const G = '111111111111111111';
/** Monday 2026-11-09 18:10 UTC; the Arbitration schedule below starts at 18:00. */
const NOW = Date.UTC(2026, 10, 9, 18, 10);
const T0 = Date.UTC(2026, 10, 9, 18);
const iso = (ms: number) => new Date(ms).toISOString();

// --- A busy world state: more of everything than a normal day has, to check the boards stay inside Discord's limits. ---

const reward = (items: string[], credits = 0, countedItems: { type: string; count: number }[] = []) => ({ items, credits, countedItems });
const FACTIONS = ['Grineer', 'Corpus', 'Infested', 'Corrupted'];
const PLANETS = ['Earth', 'Venus', 'Mercury', 'Mars', 'Phobos', 'Ceres', 'Jupiter', 'Europa', 'Saturn', 'Uranus', 'Neptune', 'Pluto', 'Sedna', 'Eris', 'Void', 'Lua', 'Kuva Fortress', 'Zariman'];
const MISSIONS = ['Capture', 'Extermination', 'Survival', 'Defense', 'Disruption', 'Interception', 'Mobile Defense', 'Spy', 'Rescue', 'Sabotage', 'Excavation', 'Hijack'];
const node = (i: number) => `Longnamednode${i} (${PLANETS[i % PLANETS.length]})`;

function busyWorld(now = NOW, opts: { baroHere?: boolean } = {}): WorldState {
  const baroHere = opts.baroHere ?? true;
  return {
    timestamp: iso(now),
    alerts: [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `gift${i}`,
        expiry: iso(now + (i + 1) * 20 * MIN),
        mission: {
          description: `Gift of the Lotus ${i}`,
          type: MISSIONS[i % MISSIONS.length],
          node: node(i),
          faction: FACTIONS[i % 4],
          reward: i % 3 === 0 ? reward([], 0, [{ type: 'Kuva', count: 200_000 }]) : reward([i % 2 ? 'Forma Blueprint' : 'Orokin Catalyst Blueprint'], 15_000),
          minEnemyLevel: 20 + i,
          maxEnemyLevel: 30 + i,
          archwingRequired: i === 4,
          nightmare: i === 5,
        },
      })),
      // An event's endless resource missions: the same placeholder title and reward, folded into one line.
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `ev${i}`,
        expiry: iso(now + (i + 1) * 30 * MIN),
        mission: { description: 'Event Alert Title', type: 'Survival', node: `Eventnode${i} (Eris)`, faction: 'Infested', reward: reward([], 0, [{ type: 'Rotting Tumor', count: 50 }]) },
      })),
    ],
    events: Array.from({ length: 3 }, (_, i) => ({
      id: `e${i}`,
      description: `Operation: Something Big ${i}`,
      node: `Relay ${i}`,
      tooltip: 'A long tooltip that says what to do in this event, with a few more words to make it longer than usual',
      maximumScore: 100,
      currentScore: 40 + i * 10,
      interimSteps: [
        { goal: 50, reward: reward(['Orokin Reactor']) },
        { goal: 90, reward: reward(['Umbra Forma Blueprint']) },
      ],
      rewards: [reward(['Some Sigil', 'Arcane Thing'])],
      expiry: iso(now + 5 * 24 * HOUR),
    })),
    nightwave: {
      season: 14,
      expiry: iso(now + 60 * 24 * HOUR),
      activeChallenges: Array.from({ length: 12 }, (_, i) => ({
        id: `nw${i}`,
        title: `Challenge number ${i}`,
        desc: 'Complete a long description of what the challenge asks you to do in the game',
        reputation: i < 3 ? 1000 : i < 9 ? 4500 : 7000,
        isDaily: i < 3,
        isElite: i >= 9,
        expiry: iso(now + (i < 3 ? 1 : 6) * 24 * HOUR),
      })),
    },
    invasions: Array.from({ length: 16 }, (_, i) => ({
      id: `inv${i}`,
      node: node(i + 3),
      desc: i % 4 === 0 ? 'Infested Outbreak' : 'Grineer Offensive',
      completion: (i * 7) % 100,
      completed: false,
      vsInfestation: i % 4 === 0,
      attacker: { faction: i % 4 === 0 ? 'Infested' : 'Grineer', reward: i % 4 === 0 ? undefined : reward(i % 2 ? ['Wraith Twin Vipers Barrel'] : [], 0, i % 2 ? [] : [{ type: 'Fieldron', count: 3 }]) },
      defender: { faction: 'Corpus', reward: i % 3 ? reward([], 0, [{ type: 'Detonite Injector', count: 3 }]) : reward(['Orokin Catalyst Blueprint']) },
    })),
    voidTrader: {
      id: 'baro1',
      activation: iso(baroHere ? now - HOUR : now + 3 * 24 * HOUR),
      expiry: iso(baroHere ? now + 47 * HOUR : now + 5 * 24 * HOUR),
      location: 'Strata Relay (Earth)',
      inventory: baroHere ? Array.from({ length: 60 }, (_, i) => ({ item: `Primed Very Long Mod Name ${i}`, ducats: 100 + i * 10, credits: 100_000 + i * 10_000 })) : [],
    },
    dailyDeals: [{ id: 'dd1', item: 'Some Prime Weapon', originalPrice: 200, salePrice: 120, discount: 40, total: 200, sold: 50, expiry: iso(now + 10 * HOUR) }],
    vaultTrader: {
      location: "Maroo's Bazaar (Mars)",
      expiry: iso(now + 6 * 24 * HOUR),
      inventory: Array.from({ length: 30 }, (_, i) =>
        i % 2
          ? { item: `T${(i % 4) + 1} Void Projection Nidus Saryn Vault ${String.fromCharCode(65 + (i % 3))} Bronze`, ducats: 0, credits: 150 }
          : { item: `M P V Prime Strun Weapon ${i}`, ducats: 3, credits: 0 },
      ),
    },
    steelPath: {
      activation: iso(now - 24 * HOUR),
      expiry: iso(now + 6 * 24 * HOUR),
      currentReward: { name: 'Umbra Forma Blueprint', cost: 150 },
      rotation: ['Umbra Forma Blueprint', '50,000 Kuva', 'Kitgun Riven Mod', '3x Forma', 'Zaw Riven Mod', '30,000 Endo', 'Rifle Riven Mod', 'Shotgun Riven Mod'].map((name) => ({ name, cost: 75 })),
    },
    sortie: {
      id: 's1',
      boss: 'Vay Hek',
      faction: 'Grineer',
      expiry: iso(now + 5 * HOUR),
      variants: [1, 2, 3].map((i) => ({ missionType: MISSIONS[i], node: node(i), modifier: 'Enemy Elemental Enhancement', modifierDescription: 'Enemies deal extra damage of one element, a long description of the modifier' })),
    },
    archonHunt: {
      id: 'a1',
      boss: 'Archon Amar',
      expiry: iso(now + 6 * 24 * HOUR),
      missions: [
        { type: 'Extermination', node: 'Hydron (Sedna)' },
        { type: 'Survival', node: 'Kappa (Sedna)' },
        { type: 'Assassination', node: 'Merrow (Sedna)' },
      ],
    },
    archimedeas: ['C T_ L A B', 'C T_ H E X'].map((type) => ({
      type,
      expiry: iso(now + 6 * 24 * HOUR),
      missions: Array.from({ length: 3 }, (_, i) => ({
        missionType: MISSIONS[i],
        faction: 'Grineer',
        deviation: { name: 'Fortified Foes' },
        risks: [
          { name: 'Ambush', isHard: false },
          { name: 'Deadly Elite Units', isHard: true },
        ],
      })),
      personalModifiers: [{ name: 'Secondary Wounds' }, { name: 'Untreatable' }],
    })),
    syndicateMissions: BOUNTY_SYNDICATES.map((syndicate) => ({
      syndicate,
      expiry: iso(now + 2 * HOUR),
      jobs: Array.from({ length: 5 }, (_, j) => ({ enemyLevels: [5 + j * 10, 15 + j * 10], standingStages: [500, 500, 500, 1000] })),
    })),
    fissures: Array.from({ length: 60 }, (_, i) => ({
      id: `f${i}`,
      node: node(i),
      missionType: MISSIONS[i % MISSIONS.length],
      enemy: FACTIONS[i % 4],
      tier: ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'][i % 6],
      isHard: i % 3 === 1,
      isStorm: i % 3 === 2,
      expiry: iso(now + (i + 1) * 3 * MIN),
    })),
    cetusCycle: { isDay: true, expiry: iso(now + 40 * MIN) },
    vallisCycle: { isWarm: false, expiry: iso(now + 10 * MIN) },
    earthCycle: { isDay: true, expiry: iso(now + 2 * HOUR) },
    cambionCycle: { state: 'fass', expiry: iso(now + 40 * MIN) },
    zarimanCycle: { state: 'corpus', expiry: iso(now + 100 * MIN) },
    duviriCycle: {
      state: 'joy',
      expiry: iso(now + 90 * MIN),
      choices: [
        { category: 'normal', choices: ['Excalibur', 'Trinity', 'Ember', 'Loki', 'Mag'] },
        { category: 'hard', choices: ['Braton', 'Lato', 'Skana', 'Paris', 'Kunai'] },
      ],
    },
    arbitration: { node: 'SolNode000', expired: true, activation: '1970-01-01T00:00:00.000Z', expiry: '1970-01-01T00:00:00.000Z' },
    news: [],
  } as unknown as WorldState;
}

// --- The Arbitration schedule: S, A, B, C and an unranked (F) node in turn, every hour from 18:00 for two weeks. ---

const NODES = ['SolNode23', 'SolNode195', 'ClanNode0', 'SolNode85', 'SolNode999'];
const tiers = parseTiers('window.arbyTiers = {\nSolNode23: "S",\nSolNode195: "A",\nClanNode0: "B",\nSolNode85: "C",\n};\n');
const scheduleText = Array.from({ length: 14 * 24 }, (_, i) => `${(T0 + i * HOUR) / 1000},${NODES[i % NODES.length]}`).join('\n');
const arbyData: ArbitrationData = { schedule: ArbitrationSchedule.parse(scheduleText), tiers, stale: false, fetchedAt: T0 };
const view = (now: number, ws: WorldState | null = null) => arbitrationView(arbyData, ws, now, { hours: 48, bestDays: 7, bestTier: 'B' });

function inputFor(store: Store, over: Partial<FeedInput> = {}): FeedInput {
  const now = over.now ?? NOW;
  return {
    now,
    ws: busyWorld(now),
    arby: view(now),
    arbyData,
    stale: false,
    settings: store.getSettings(G),
    selfRoles: new Set(['r-arby', 'r-baro']),
    ...over,
  };
}

/** Every custom emoji the registry knows of, so text is as long as it gets in the clan (`<:name:id>` is 30+ characters). */
const everyEmoji = () => [...new Set(Object.values(EMOJI).flatMap((d) => [...d.names]))].map((name, i) => ({ id: String(1_300_000_000_000_000_000n + BigInt(i)), name }));

// --- A clan server with channels that record what Ordis does in them. ---

function fakeChannel(id: string, opts: { failSend?: boolean } = {}) {
  let next = 1;
  const log: string[] = [];
  const live = new Map<string, string>();
  const notes: { id: string; content: string; roles: string[] }[] = [];
  const gone = () => Object.assign(new Error('Unknown Message'), { code: 10008 });
  const body = (components: { toJSON(): unknown }[]) => JSON.stringify(components.map((c) => c.toJSON()));
  const channel = {
    id,
    guildId: G,
    isSendable: () => true,
    async send(p: { components?: { toJSON(): unknown }[]; content?: string; allowedMentions?: { roles?: string[] } }) {
      if (opts.failSend) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      const mid = `${id}-m${next++}`;
      if (p.content !== undefined) {
        notes.push({ id: mid, content: p.content, roles: p.allowedMentions?.roles ?? [] });
        log.push(`note ${mid}`);
      } else {
        live.set(mid, body(p.components ?? []));
        log.push(`send ${mid}`);
      }
      return { id: mid };
    },
    messages: {
      async edit(mid: string, p: { components: { toJSON(): unknown }[] }) {
        if (!live.has(mid)) throw gone();
        live.set(mid, body(p.components));
        log.push(`edit ${mid}`);
      },
      async delete(mid: string) {
        log.push(`delete ${mid}`);
        live.delete(mid);
      },
      async fetch(mid: string) {
        if (!live.has(mid)) throw gone();
        return {};
      },
    },
  };
  return { channel, log, live, notes };
}

function fakeServer() {
  const store = new Store(':memory:');
  const channels = new Map<string, ReturnType<typeof fakeChannel>>();
  const ctx = {
    config: { DISCORD_GUILD_ID: G },
    store,
    client: { channels: { fetch: async (id: string) => channels.get(id)?.channel ?? null } },
  } as unknown as AppContext;
  const add = (id: string, opts: { failSend?: boolean } = {}) => {
    const c = fakeChannel(id, opts);
    channels.set(id, c);
    return c;
  };
  return { ctx, store, add };
}

describe('World State boards', () => {
  before(() => loadEmojis(everyEmoji()));
  after(() => loadEmojis([]));

  it('fit inside Discord limits on a busy day, with every custom emoji in use', () => {
    const store = new Store(':memory:');
    store.updateSettings(G, { arbitrationsRoleId: 'r-arby', baroRoleId: 'r-baro' });
    for (const def of FEEDS) {
      for (const input of [inputFor(store), inputFor(store, { stale: true }), inputFor(store, { ws: busyWorld(NOW, { baroHere: false }) })]) {
        for (const [i, message] of def.render(input).entries()) {
          const s = messageStats(message);
          assert.ok(s.text <= 4000, `${def.id} message ${i + 1} has ${s.text} characters of text`);
          assert.ok(s.components <= 40, `${def.id} message ${i + 1} has ${s.components} components`);
        }
      }
    }
  });

  it('keep the same number of messages whatever the world state shows, so a quiet day never reposts a board', () => {
    const store = new Store(':memory:');
    const empty = { cetusCycle: { isDay: true, expiry: iso(NOW + HOUR) } } as unknown as WorldState;
    // The cycles board says why it shows no worlds for a world state without them; that warning is expected here.
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const def of FEEDS) {
        const counts = [busyWorld(), busyWorld(NOW, { baroHere: false }), empty, null].map((ws) => def.render(inputFor(store, { ws })).length);
        assert.equal(new Set(counts).size, 1, `${def.id}: ${counts.join(', ')}`);
      }
    } finally {
      console.warn = warn;
    }
    const arby = FEEDS.find((f) => f.id === 'arbitrations')!;
    assert.equal(arby.render(inputFor(store, { arby: arbitrationView(null, null, NOW), arbyData: null })).length, 4, 'and the Arbitration board without a schedule');
  });

  it('show the whole of a big Baro visit, in plain words when the icons would not fit', () => {
    const store = new Store(':memory:');
    const [baro] = FEEDS.find((f) => f.id === 'traders')!.render(inputFor(store));
    const text = JSON.stringify(baro!.map((c) => c.toJSON()));
    assert.match(text, /Primed Very Long Mod Name 59/, 'the last of 60 items is listed');
    assert.doesNotMatch(text, /…and \d+ more/);
    assert.match(text, /ducats · 690k cr/);
  });

  it('name Varzia\'s stock as players know it', () => {
    assert.equal(resurgenceItemName('T1 Void Projection Nidus Saryn Vault A Bronze'), 'Lith relic · Nidus Saryn A');
    assert.equal(resurgenceItemName('T4 Void Projection Nidus Saryn Vault b Bronze'), 'Axi relic · Nidus Saryn B');
    assert.equal(resurgenceItemName('M P V Prime Strun Weapon'), 'Strun Prime');
    assert.equal(resurgenceItemName('Prime Access Pack'), 'Prime Access Pack');
    assert.equal(resurgenceItemName('M P V Protea Prime Single Pack'), 'Protea Prime Single Pack');
    assert.equal(resurgenceItemName('Ember Prime'), 'Ember Prime');
  });

  it("fold an event's resource missions into one line, the worthwhile alerts first", () => {
    const groups = groupAlerts(busyWorld().alerts);
    assert.equal(groups.length, 11);
    const event = groups.find((g) => g.alerts.length > 1)!;
    assert.equal(event.name, 'Event mission (Survival)');
    assert.equal(event.alerts.length, 8);
    assert.equal(groups.at(-1), event, 'a resource mission comes after every Gift of the Lotus');
  });

  it('are found by their channel', () => {
    const store = new Store(':memory:');
    store.updateSettings(G, { fissuresChannelId: 'c-fis' });
    assert.equal(feedOfChannel(store.getSettings(G), 'c-fis')?.id, 'fissures');
    assert.equal(feedOfChannel(store.getSettings(G), 'c-other'), undefined);
  });
});

describe('what the boards ping for', () => {
  const store = new Store(':memory:');

  it('alerts and invasions with a reward worth a detour, each with a stable key', () => {
    const input = inputFor(store);
    const alerts = alertPings(input);
    assert.deepEqual(
      alerts.map((p) => p.key),
      Array.from({ length: 10 }, (_, i) => `alert:gift${i}`),
      'every Gift of the Lotus (Forma, a Catalyst, 200,000 Kuva), none of the Rotting Tumor missions',
    );
    assert.ok(alerts.every((p) => p.until <= NOW + 3 * HOUR));
    assert.match(alerts[0]!.text, /200,000 Kuva/);
    const invasions = invasionPings(input).map((p) => p.key);
    assert.ok(invasions.includes('invasion:inv1'), 'a Wraith barrel');
    assert.ok(invasions.includes('invasion:inv3'), 'and a Catalyst');
    assert.ok(!invasions.includes('invasion:inv2'), 'not Fieldron against Detonite');
  });

  it("Baro's arrival, once per visit", () => {
    const here = traderPings(inputFor(store));
    assert.equal(here.length, 1);
    assert.equal(here[0]!.key, `baro:${NOW - HOUR}`);
    assert.equal(here[0]!.until, NOW + 47 * HOUR);
    assert.deepEqual(traderPings(inputFor(store, { ws: busyWorld(NOW, { baroHere: false }) })), []);
  });

  it('S and A tier Arbitrations from ten minutes before they start, only while the schedule is trusted', () => {
    assert.deepEqual(arbitrationPings(inputFor(store)).map((p) => p.key), [`arbitration:${T0}`], 'the S tier hour running now');
    const at = T0 + 52 * MIN;
    assert.deepEqual(
      arbitrationPings(inputFor(store, { now: at, arby: view(at) })).map((p) => p.key),
      [`arbitration:${T0}`, `arbitration:${T0 + HOUR}`],
      'and the A tier hour that starts in 8 minutes',
    );
    const later = T0 + 2 * HOUR + 55 * MIN;
    assert.deepEqual(arbitrationPings(inputFor(store, { now: later, arby: view(later) })), [], 'B and C hours are never pinged');
    const untrusted = { ...view(NOW), scheduleTrusted: false };
    assert.deepEqual(arbitrationPings(inputFor(store, { arby: untrusted })), []);
  });
});

describe('keeping the boards in their channels', () => {
  it('posts a board, pings the role only for what is new after the first round, and removes the note when it is over', async () => {
    const { ctx, store, add } = fakeServer();
    const arby = add('c-arby');
    store.updateSettings(G, { arbitrationsChannelId: 'c-arby', arbitrationsRoleId: 'r-arby' });

    // First round: the board is posted and the S tier hour running now is only recorded.
    await syncFeeds(ctx, inputFor(store));
    assert.deepEqual(arby.log, ['send c-arby-m1', 'send c-arby-m2', 'send c-arby-m3', 'send c-arby-m4']);
    assert.equal(feedHealth().arbitrations!.action, 'posted');

    // Nothing new: nothing happens.
    await syncFeeds(ctx, inputFor(store, { now: NOW + MIN, arby: view(NOW + MIN) }));
    assert.equal(arby.log.length, 4);

    // The A tier hour is 8 minutes away: one note pings the role.
    const soon = T0 + 52 * MIN;
    await syncFeeds(ctx, inputFor(store, { now: soon, arby: view(soon) }));
    assert.equal(arby.notes.length, 1);
    assert.deepEqual(arby.notes[0]!.roles, ['r-arby']);
    assert.match(arby.notes[0]!.content, /^<@&r-arby> .*A tier Arbitration.* starts/);
    assert.doesNotMatch(arby.notes[0]!.content, /S tier/, 'the hour that was recorded in the first round is not news');
    assert.equal(feedHealth().arbitrations!.pinged, 1);

    // While that hour runs the note stays; once it is over the note goes.
    const during = T0 + HOUR + 5 * MIN;
    await syncFeeds(ctx, inputFor(store, { now: during, arby: view(during) }));
    assert.ok(!arby.log.includes(`delete ${arby.notes[0]!.id}`));
    const over = T0 + 2 * HOUR + MIN;
    await syncFeeds(ctx, inputFor(store, { now: over, arby: view(over) }));
    assert.ok(arby.log.includes(`delete ${arby.notes[0]!.id}`));
    assert.equal(arby.notes.length, 1, 'a B tier hour pings nobody');
  });

  it('moves a board with its channel, starts over without pings there, and removes it when switched off', async () => {
    const { ctx, store, add } = fakeServer();
    const first = add('c-one');
    const second = add('c-two');
    store.updateSettings(G, { arbitrationsChannelId: 'c-one', arbitrationsRoleId: 'r-arby' });
    await syncFeeds(ctx, inputFor(store));
    const soon = T0 + 52 * MIN;
    await syncFeeds(ctx, inputFor(store, { now: soon, arby: view(soon) }));
    assert.equal(first.notes.length, 1);

    store.updateSettings(G, { arbitrationsChannelId: 'c-two' });
    await syncFeeds(ctx, inputFor(store, { now: soon + MIN, arby: view(soon + MIN) }));
    for (const id of ['c-one-m1', 'c-one-m2', 'c-one-m3', 'c-one-m4', first.notes[0]!.id]) assert.ok(first.log.includes(`delete ${id}`), `${id} removed`);
    assert.equal(second.log.filter((l) => l.startsWith('send')).length, 4);
    assert.equal(second.notes.length, 0, 'a new channel is not pinged for what is already running');

    store.updateSettings(G, { arbitrationsChannelId: null });
    await syncFeeds(ctx, inputFor(store, { now: soon + 2 * MIN, arby: view(soon + 2 * MIN) }));
    assert.equal(second.live.size, 0);
    assert.equal(feedHealth().arbitrations!.channelId, null);
  });

  it('replaces the old alerts summary, and leaves the boards alone when the world state could not be read', async () => {
    const { ctx, store, add } = fakeServer();
    const alerts = add('c-alerts');
    const fissures = add('c-fis');
    store.updateSettings(G, { alertsChannelId: 'c-alerts', fissuresChannelId: 'c-fis' });
    store.setMeta('alerts_summary:c-alerts', JSON.stringify({ messageId: 'old-summary', hash: 'x', at: 1 }));
    store.setMeta('alerts_note:c-alerts', JSON.stringify({ messageId: 'old-note', until: 1 }));

    await syncFeeds(ctx, inputFor(store, { ws: null }), { wsFailed: true });
    assert.equal(alerts.log.length, 0, 'nothing is drawn from a failed read');
    assert.equal(fissures.log.length, 0);
    assert.equal(feedHealth().fissures!.action, 'skipped');

    await syncFeeds(ctx, inputFor(store));
    assert.deepEqual(alerts.log.slice(0, 2), ['delete old-summary', 'delete old-note']);
    assert.equal(store.getMeta('alerts_summary:c-alerts'), '');
    assert.equal(store.getMeta('alerts_note:c-alerts'), '');
    assert.equal(alerts.log.filter((l) => l.startsWith('send')).length, 2);
    assert.equal(fissures.log.filter((l) => l.startsWith('send')).length, 3);
  });

  it('keeps going when one board fails, and says which one', async () => {
    const { ctx, store, add } = fakeServer();
    add('c-broken', { failSend: true });
    const cycles = add('c-cycles');
    store.updateSettings(G, { sortieChannelId: 'c-broken', cyclesChannelId: 'c-cycles' });
    const errors = console.error;
    console.error = () => {};
    try {
      await syncFeeds(ctx, inputFor(store));
    } finally {
      console.error = errors;
    }
    assert.match(feedHealth().sortie!.error ?? '', /Missing Permissions/);
    assert.equal(cycles.log.filter((l) => l.startsWith('send')).length, 2);
  });
});

describe('the boards\' controls', () => {
  it('offer at most 25 options per menu, each a valid notification', () => {
    assert.equal(new Set(TRACK_OPTIONS.map((o) => o.value)).size, TRACK_OPTIONS.length, 'option values are unique');
    for (const o of TRACK_OPTIONS) {
      assert.deepEqual(parseSpec(JSON.stringify(o.spec)), o.spec);
      assert.ok(o.label.length <= 100 && o.description.length <= 100, o.value);
      assert.ok(o.feeds.length > 0 && o.feeds.every((f) => FEED_IDS.includes(f)), o.value);
    }
    for (const feed of FEED_IDS) {
      const menu = notifyRow(feed).toJSON().components[0] as { custom_id: string; options: unknown[]; max_values: number };
      assert.equal(menu.custom_id, `feeds:track:${feed}`);
      assert.ok(menu.options.length >= 1 && menu.options.length <= 25, `${feed}: ${menu.options.length} options`);
      assert.equal(menu.max_values, menu.options.length);
    }
  });

  it('compare notifications by meaning, not key order', () => {
    assert.ok(sameSpec({ kind: 'fissure', tier: 'Axi', steelPath: true }, '{"steelPath":true,"kind":"fissure","tier":"Axi"}'));
    assert.ok(sameSpec({ kind: 'fissure', tier: 'Axi', steelPath: true, storm: undefined }, { kind: 'fissure', tier: 'Axi', steelPath: true }));
    assert.ok(!sameSpec({ kind: 'fissure', tier: 'Axi' }, { kind: 'fissure', tier: 'Neo' }));
  });

  function fakeSelect(customId: string, values: string[], messageId = 'unknown-message') {
    const calls: { kind: string; payload: { components?: { toJSON(): unknown }[]; flags?: number } | null }[] = [];
    const interaction = {
      customId,
      values,
      user: { id: 'u1' },
      message: { id: messageId },
      update: async (p: never) => void calls.push({ kind: 'update', payload: p }),
      deferUpdate: async () => void calls.push({ kind: 'deferUpdate', payload: null }),
      followUp: async (p: never) => void calls.push({ kind: 'followUp', payload: p }),
      reply: async (p: never) => void calls.push({ kind: 'reply', payload: p }),
    } as unknown as StringSelectMenuInteraction;
    return { interaction, calls };
  }
  const text = (p: { components?: { toJSON(): unknown }[] } | null) => JSON.stringify((p?.components ?? []).map((c) => c.toJSON()));

  it('set up notifications from a board menu, skip the ones a member has and stop at the limit', async () => {
    const { ctx, store } = fakeServer();
    const first = fakeSelect('feeds:track:arbitrations', ['arby-s', 'arbitration']);
    await handleFeedSelect(first.interaction, ctx);
    assert.equal(store.listTrackers(G, 'u1').length, 2);
    assert.deepEqual(first.calls.map((c) => c.kind), ['deferUpdate', 'followUp']);
    assert.match(text(first.calls[1]!.payload), /Ordis will DM you for/);
    assert.match(text(first.calls[1]!.payload), /S tier/);

    const again = fakeSelect('feeds:track:arbitrations', ['arby-s', 'arby-a']);
    await handleFeedSelect(again.interaction, ctx);
    assert.equal(store.listTrackers(G, 'u1').length, 3);
    assert.match(text(again.calls[1]!.payload), /Already set/);

    for (let i = store.listTrackers(G, 'u1').length; i < MAX_TRACKERS_PER_USER; i++) store.createTracker(G, 'u1', JSON.stringify({ kind: 'reward', keyword: `thing${i}` }));
    const full = fakeSelect('feeds:track:traders', ['baro']);
    await handleFeedSelect(full.interaction, ctx);
    assert.equal(store.listTrackers(G, 'u1').length, MAX_TRACKERS_PER_USER);
    assert.match(text(full.calls[1]!.payload), /the most allowed/);

    await assert.rejects(handleFeedSelect(fakeSelect('feeds:track:nope', ['baro']).interaction, ctx), /Unknown menu/);
  });

  it('redraw the board message as it is, so the pick does not stay in the menu', async () => {
    const { ctx, store, add } = fakeServer();
    const arby = add('c-arby');
    store.updateSettings(G, { arbitrationsChannelId: 'c-arby' });
    await syncFeeds(ctx, inputFor(store));
    const pick = fakeSelect('feeds:track:arbitrations', ['arby-a'], 'c-arby-m4');
    await handleFeedSelect(pick.interaction, ctx);
    assert.equal(pick.calls[0]!.kind, 'update');
    assert.equal(text(pick.calls[0]!.payload), arby.live.get('c-arby-m4'), 'the message as it is on the board');
  });

  it('remove notifications from the list', async () => {
    const { ctx, store } = fakeServer();
    const id = store.createTracker(G, 'u1', JSON.stringify({ kind: 'baro' }));
    store.createTracker(G, 'u1', JSON.stringify({ kind: 'sortie' }));
    const remove = fakeSelect('feeds:untrack', [String(typeof id === 'object' ? (id as { id: number }).id : id)]);
    await handleFeedSelect(remove.interaction, ctx);
    assert.equal(store.listTrackers(G, 'u1').length, 1);
    assert.equal(remove.calls[0]!.kind, 'update');
    assert.match(text(remove.calls[0]!.payload), /Removed 1/);
  });

  it('plan Arbitrations days ahead', () => {
    const sa = JSON.stringify(planMessage(arbyData, NOW).toJSON());
    assert.match(sa, /S and A tier, next 14 days/);
    assert.doesNotMatch(sa, /Casta/, 'no B tier node in the S and A list');
    assert.match(JSON.stringify(planMessage(arbyData, NOW, 'b7').toJSON()), /B tier or better/);
    assert.match(JSON.stringify(planMessage(null, NOW).toJSON()), /can not be read right now/);
  });
});

describe('board building blocks', () => {
  it('cut text at a line and say how much was left out', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const cut = fit(lines, 100)!;
    assert.ok(cut.length <= 100);
    assert.match(cut, /…and \d+ more$/);
    assert.equal(fit('short', 100), 'short');
    assert.equal(fit('', 100), null);
    assert.equal(fit('anything', 0), null);
  });

  it('never start, end or double a separator, and say so when a card is empty', () => {
    const json = card(0, [{ separator: true, divider: true, large: false }, 'a', { separator: true, divider: true, large: false }, { separator: true, divider: false, large: false }, 'b', { separator: true, divider: true, large: false }]).toJSON() as { components: { type: number }[] };
    assert.deepEqual(json.components.map((c) => c.type), [10, 14, 10], 'text, one separator, text');
    assert.match(JSON.stringify(card(0, [null, false, '']).toJSON()), /Nothing to show right now/);
  });

  it('read back as text, with the buttons and menus of a row on one line', () => {
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId('a').setLabel('My notifications').setStyle(ButtonStyle.Secondary),
      new StringSelectMenuBuilder().setCustomId('b').setPlaceholder('🔔 DM me when…').addOptions({ label: 'x', value: 'x' }),
    );
    const board = card(0, ['### Fissures', { separator: true, divider: true, large: false }, { section: true, text: 'Lith · Capture', thumb: 'https://cdn.discordapp.com/emojis/1.png' }, row]);
    assert.equal(componentText([board]), '### Fissures\nLith · Capture\n[My notifications] [🔔 DM me when…]');
  });

  it('write credit prices short', () => {
    assert.equal(compact(110_000), '110k');
    assert.equal(compact(1_250_000), '1.25M');
    assert.equal(compact(950), '950');
    assert.equal(compact(12_500), '12.5k');
  });
});
