import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MessageFlags } from 'discord.js';
import { Store } from '../src/db.js';
import { answerNow } from '../src/discord/commands/now.js';
import { EMOJI, loadEmojis } from '../src/discord/emoji.js';
import { componentText, messageStats } from '../src/discord/feeds/parts.js';
import type { FeedInput } from '../src/discord/feeds/types.js';
import { nowCard, quickFissures } from '../src/discord/now.js';
import type { ArbitrationSlot, ArbitrationView } from '../src/warframe/arbitrations.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const GUILD = '111111111111111111';
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Friday 2026-11-13 18:20 UTC, twenty minutes into an Arbitration. */
const NOW = Date.UTC(2026, 10, 13, 18, 20);
const HOUR_START = Date.UTC(2026, 10, 13, 18);
const iso = (ms: number) => new Date(ms).toISOString();
const rel = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

const slot = (start: number, over: Partial<ArbitrationSlot> = {}): ArbitrationSlot =>
  ({ nodeKey: 'SolNode1', node: 'Casta (Ceres)', name: 'Casta', planet: 'Ceres', mission: 'Defense', faction: 'Grineer', start, end: start + HOUR, tier: 'S', ...over }) as ArbitrationSlot;

const view = (over: Partial<ArbitrationView> = {}): ArbitrationView => ({
  current: slot(HOUR_START),
  upcoming: [slot(HOUR_START + HOUR, { name: 'Odin', planet: 'Mercury', mission: 'Interception', tier: 'C' }), slot(HOUR_START + 2 * HOUR, { name: 'Seimeni', mission: 'Defense', tier: 'A' })],
  best: [],
  scheduleTrusted: true,
  stale: false,
  ...over,
});

const NONE: ArbitrationView = { current: null, upcoming: [], best: [], scheduleTrusted: true, stale: false };

type FissureInit = { tier: string; type: string; mins: number; hard?: boolean; storm?: boolean; node?: string };
const fissure = (f: FissureInit, i: number) => ({ id: `f${i}`, node: f.node ?? `Node${i} (Earth)`, missionType: f.type, enemy: 'Grineer', tier: f.tier, isHard: Boolean(f.hard), isStorm: Boolean(f.storm), expiry: iso(NOW + f.mins * MIN) });
const fissures = (list: FissureInit[]) => ({ fissures: list.map(fissure) }) as unknown as WorldState;

const reward = (items: string[], credits = 0, countedItems: { type: string; count: number }[] = []) => ({ items, credits, countedItems });

/** An ordinary evening: a few fissures, one alert worth running and one that is not, two invasions, Baro at the relay. */
function world(over: Record<string, unknown> = {}): WorldState {
  return {
    timestamp: iso(NOW),
    fissures: [
      { tier: 'Lith', type: 'Capture', mins: 40, node: 'Hepit (Void)' },
      { tier: 'Lith', type: 'Extermination', mins: 70, node: 'Teshub (Void)' },
      { tier: 'Meso', type: 'Survival', mins: 80 },
      { tier: 'Neo', type: 'Rescue', mins: 3 },
      { tier: 'Axi', type: 'Sabotage', mins: 30, hard: true, node: 'Marduk (Void)' },
      { tier: 'Axi', type: 'Capture', mins: 60, storm: true },
    ].map(fissure),
    alerts: [
      { id: 'a1', expiry: iso(NOW + 50 * MIN), mission: { description: 'Gift of the Lotus', type: 'Defense', node: 'Hydron (Sedna)', faction: 'Grineer', reward: reward(['Orokin Catalyst Blueprint'], 15_000) } },
      { id: 'a2', expiry: iso(NOW + 50 * MIN), mission: { description: 'Supply run', type: 'Capture', node: 'Mantle (Earth)', faction: 'Grineer', reward: reward([], 12_000) } },
      { id: 'a3', expiry: iso(NOW - MIN), mission: { description: 'Over already', type: 'Capture', node: 'Mantle (Earth)', faction: 'Grineer', reward: reward(['Forma Blueprint']) } },
    ],
    invasions: [
      { id: 'i1', node: 'Kiliken (Venus)', completed: false, vsInfestation: false, attacker: { faction: 'Grineer', reward: reward([], 0, [{ type: 'Fieldron', count: 3 }]) }, defender: { faction: 'Corpus', reward: reward(['Wraith Twin Vipers Barrel']) } },
      { id: 'i2', node: 'Tessera (Venus)', completed: false, vsInfestation: true, attacker: { faction: 'Infested', reward: reward(['Orokin Reactor Blueprint']) }, defender: { faction: 'Corpus', reward: reward([], 0, [{ type: 'Detonite Injector', count: 3 }]) } },
      { id: 'i3', node: 'Done (Mars)', completed: true, vsInfestation: false, attacker: { faction: 'Grineer', reward: reward(['Orokin Reactor Blueprint']) }, defender: { faction: 'Corpus', reward: reward(['Forma Blueprint']) } },
    ],
    events: [{ id: 'e1', description: 'Operation: Plague Star', expiry: iso(NOW + 3 * 24 * HOUR) }],
    voidTrader: {
      id: 'baro',
      activation: iso(NOW - HOUR),
      expiry: iso(NOW + 47 * HOUR),
      location: 'Strata Relay (Earth)',
      inventory: [
        { item: 'Primed Fury', ducats: 400, credits: 110_000 },
        { item: 'Primed Flow', ducats: 350, credits: 110_000 },
        { item: 'Sands of Inaros', ducats: 100, credits: 25_000 },
      ],
    },
    dailyDeals: [{ id: 'd1', item: 'Braton Prime', originalPrice: 200, salePrice: 120, discount: 40, total: 200, sold: 50, expiry: iso(NOW + 10 * HOUR) }],
    sortie: { id: 's1', boss: 'Vay Hek', faction: 'Grineer', expiry: iso(NOW + 5 * HOUR), variants: [] },
    archonHunt: { id: 'h1', boss: 'Archon Amar', expiry: iso(NOW + 2 * 24 * HOUR), missions: [] },
    cetusCycle: { isDay: false, expiry: iso(NOW + 30 * MIN) },
    vallisCycle: { isWarm: true, expiry: iso(NOW + 4 * MIN) },
    earthCycle: { isDay: true, expiry: iso(NOW + 2 * HOUR) },
    cambionCycle: { state: 'vome', expiry: iso(NOW + 30 * MIN) },
    zarimanCycle: { state: 'corpus', expiry: iso(NOW + 100 * MIN) },
    duviriCycle: { state: 'joy', expiry: iso(NOW + 90 * MIN), choices: [] },
    ...over,
  } as unknown as WorldState;
}

const settings = (over: Partial<FeedInput['settings']> = {}): FeedInput['settings'] => ({
  ...new Store(':memory:').getSettings(GUILD),
  lfgChannelId: '222222222222222222',
  arbitrationsChannelId: '333333333333333333',
  fissuresChannelId: '444444444444444444',
  alertsChannelId: '555555555555555555',
  tradersChannelId: '666666666666666666',
  ...over,
});

const input = (over: Partial<FeedInput> = {}): FeedInput => ({ now: NOW, ws: world(), arby: view(), arbyData: null, stale: false, settings: settings(), ...over });
const text = (i: FeedInput, opts?: { personal?: string[] }) => componentText([nowCard(i, opts)]);

describe('/now', () => {
  it('lists the quick fissure of each relic tier that stays open longest, normal ones first', () => {
    const ws = fissures([
      { tier: 'Axi', type: 'Capture', mins: 20 },
      { tier: 'Lith', type: 'Capture', mins: 40 },
      { tier: 'Lith', type: 'Extermination', mins: 70 },
      { tier: 'Lith', type: 'Sabotage', mins: 10, hard: true },
      { tier: 'Meso', type: 'Survival', mins: 90 },
      { tier: 'Meso', type: 'Defense', mins: 90 },
      { tier: 'Neo', type: 'Rescue', mins: 4 },
      { tier: 'Neo', type: 'Spy', mins: 5 },
      { tier: 'Requiem', type: 'Capture', mins: 60, storm: true },
      { tier: 'Omnia', type: 'capture', mins: 15 },
      { tier: 'Tau', type: 'Capture', mins: 15 },
    ]);
    assert.deepEqual(
      quickFissures(ws, NOW).map((f) => `${f.tier} ${f.missionType}${f.isHard ? ' SP' : ''}`),
      ['Lith Extermination', 'Neo Spy', 'Axi Capture', 'Omnia capture', 'Tau Capture', 'Lith Sabotage SP'],
      'no storm, no endless mission, nothing that closes within five minutes; a tier the list does not know comes last',
    );
    assert.deepEqual(quickFissures(null, NOW), []);
    assert.deepEqual(quickFissures({} as WorldState, NOW), []);

    // A day with every tier open twice over: the list stays short.
    const tiers = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
    const many = fissures(tiers.flatMap((tier) => [{ tier, type: 'Capture', mins: 30 }, { tier, type: 'Capture', mins: 30, hard: true }]));
    assert.equal(quickFissures(many, NOW).length, 8);
    assert.equal(quickFissures(many, NOW).filter((f) => !f.isHard).length, 6, 'the Steel Path ones are what is left out');
  });

  it('puts the evening on one card', () => {
    const t = text(input());
    assert.match(t, /^## 🧭 Right now\n/);
    assert.ok(t.includes(`**Arbitration** · Casta, Ceres · Defense · Grineer · ends ${rel(HOUR_START + HOUR)}`), t);
    assert.ok(!t.includes('The next'), 'an S tier hour needs no hint at a better one');

    assert.ok(t.includes('**Quick fissures** · one per relic tier'));
    assert.ok(t.includes(`**Lith Extermination** · Teshub, Void · closes ${rel(NOW + 70 * MIN)}`), 'the Lith fissure that stays open longer');
    assert.ok(!t.includes('Hepit'));
    assert.ok(!t.includes('Survival'), 'an endless mission is not quick');
    assert.ok(!t.includes('Neo'), 'three minutes are not enough to get there');
    assert.match(t, /\*\*Axi Sabotage\*\* .*Steel Path · Marduk, Void/);

    assert.ok(t.includes('**Worth running**'));
    assert.ok(t.includes(`**Orokin Catalyst Blueprint, 15,000 cr** · alert: Defense on Hydron, Sedna · ends ${rel(NOW + 50 * MIN)}`), t);
    assert.ok(!t.includes('12,000 cr'), 'credits alone are not worth a detour');
    assert.ok(!t.includes('Over already') && !t.includes('**Forma Blueprint**'), 'an alert that has ended');
    assert.ok(t.includes('**Wraith Twin Vipers Barrel** · invasion on Kiliken, Venus'));
    assert.ok(!t.includes('Tessera'), 'the Infested pay nothing, and the other side only an injector');
    assert.ok(!t.includes('Done, Mars'));

    assert.ok(t.includes(`**Night on the Plains** (Eidolons) · day ${rel(NOW + 30 * MIN)}`));
    assert.ok(t.includes(`**Orb Vallis is warm** · cold ${rel(NOW + 4 * MIN)}`));
    assert.ok(t.includes(`**Baro Ki'Teer** is at Strata Relay (Earth) · leaves ${rel(NOW + 47 * HOUR)}`));
    assert.ok(!t.includes('Best resale'), 'nothing is priced yet');
    assert.ok(t.includes('**Darvo:** Braton Prime for 120p (−40%) · 150 left'));
    assert.ok(t.includes(`**Operation: Plague Star** · ends ${rel(NOW + 3 * 24 * HOUR)}`));
    assert.match(t, /-# .*Sortie \(Vay Hek\) resets <t:\d+:R> · .*Archon Hunt \(Archon Amar\) <t:\d+:R>\n-# As of <t:\d+:t>\. The World State channels keep themselves up to date\.\n\[Squad up\] \[Arbitrations\] \[Fissures\] \[Alerts\] \[Traders\]$/);
  });

  it('names the best resale once Baro is priced', () => {
    const prices = (item: string) => ({ 'Primed Fury': 60, 'Primed Flow': 70 })[item] ?? null;
    assert.ok(text(input({ prices })).includes('-# Best resale: **Primed Flow** · 70p for 350 ducats'), 'most platinum per ducat, not the highest price');
    const soon = world({ voidTrader: { id: 'baro', activation: iso(NOW + 30 * HOUR), expiry: iso(NOW + 78 * HOUR), location: 'Larunda Relay (Mercury)', inventory: [] } });
    assert.ok(text(input({ ws: soon, prices })).includes(`**Baro Ki'Teer** arrives ${rel(NOW + 30 * HOUR)} at Larunda Relay (Mercury)`));
    const far = world({ voidTrader: { id: 'baro', activation: iso(NOW + 5 * 24 * HOUR), expiry: iso(NOW + 7 * 24 * HOUR), location: 'Larunda Relay (Mercury)', inventory: [] } });
    assert.ok(!text(input({ ws: far })).includes('Baro'), 'days away is no news');
    assert.ok(!text(input({ ws: world({ dailyDeals: [{ id: 'd1', item: 'Braton Prime', salePrice: 120, discount: 40, total: 200, sold: 200, expiry: iso(NOW + HOUR) }] }) })).includes('Darvo'), 'sold out');
  });

  it('points at the next good Arbitration when this hour is a weak one', () => {
    const weak = view({ current: slot(HOUR_START, { tier: 'C' }) });
    assert.ok(text(input({ arby: weak })).includes(`-# The next A tier hour starts ${rel(HOUR_START + 2 * HOUR)}: Seimeni (Defense)`));
    assert.ok(!text(input({ arby: { ...weak, scheduleTrusted: false } })).includes('The next'), 'the hours ahead are not known when the schedule and the game disagree');
    assert.ok(!text(input({ arby: view({ current: slot(HOUR_START, { tier: 'A' }) }) })).includes('The next'));
  });

  it('still shows the Arbitration while the world state is off, and says what is missing', () => {
    const t = text(input({ ws: null }));
    assert.ok(t.includes('**Arbitration** · Casta, Ceres'));
    assert.ok(!t.includes('fissures**') && !t.includes('Worth running') && !t.includes('Baro') && !t.includes('Sortie'));
    assert.ok(t.includes('-# The live world state is switched off or not answering, so fissures, alerts and the open worlds are missing.'));
    assert.match(t, /\n\[Squad up\] \[Arbitrations\] \[Fissures\] \[Alerts\] \[Traders\]$/);

    const nothing = text(input({ ws: null, arby: NONE }));
    assert.ok(nothing.includes('Nothing can be read right now'));
    assert.ok(!nothing.includes('switched off or not answering'), 'said once');
    assert.ok(!nothing.includes('Squad up'), 'no Arbitration, no squad for it');

    assert.ok(text(input({ stale: true })).includes('may be outdated'), 'old data is marked');
    const quiet = text(input({ ws: world({ fissures: [{ tier: 'Meso', type: 'Survival', mins: 80 }].map(fissure) }) }));
    assert.ok(quiet.includes('**Fissures** · no quick mission open right now (1 fissures in all)'));
  });

  it('offers the squad button and the boards the clan has', () => {
    const json = JSON.stringify(nowCard(input()).toJSON());
    assert.ok(json.includes('"custom_id":"feeds:squad"'));
    for (const id of ['333333333333333333', '444444444444444444', '555555555555555555', '666666666666666666']) assert.ok(json.includes(`"url":"https://discord.com/channels/${GUILD}/${id}"`), id);

    assert.match(text(input({ settings: settings({ lfgChannelId: null }) })), /\n\[Arbitrations\] \[Fissures\] \[Alerts\] \[Traders\]$/);
    assert.match(text(input({ settings: settings({ fissuresChannelId: null, tradersChannelId: null }) })), /\n\[Squad up\] \[Arbitrations\] \[Alerts\]$/);
    const bare = text(input({ settings: settings({ lfgChannelId: null, arbitrationsChannelId: null, fissuresChannelId: null, alertsChannelId: null, tradersChannelId: null }) }));
    assert.match(bare, /keep themselves up to date\.$/, 'no row at all without a channel');
  });

  it('shows a member their own lines only when it is given them', () => {
    assert.ok(!text(input()).includes('your relics'));
    const t = text(input(), { personal: ['**Your relics** · 12 Lith worth opening', '-# from your AlecaFrame inventory'] });
    assert.ok(t.includes('**Your relics** · 12 Lith worth opening\n-# from your AlecaFrame inventory'));
    assert.ok(t.indexOf('Quick fissures') < t.indexOf('Your relics') && t.indexOf('Your relics') < t.indexOf('Worth running'), 'right under the fissures');
  });

  describe('on the busiest day', () => {
    const everyEmoji = () => [...new Set(Object.values(EMOJI).flatMap((d) => [...d.names]))].map((name, i) => ({ id: String(1_300_000_000_000_000_000n + BigInt(i)), name }));
    before(() => loadEmojis(everyEmoji()));
    after(() => loadEmojis([]));

    it('stays inside Discord limits and keeps its last lines', () => {
      const tiers = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
      const long = 'Averyveryverylongnodename';
      const busy = world({
        fissures: tiers.flatMap((tier) => [{ tier, type: 'Extermination', mins: 60, node: `${long} (Kuva Fortress)` }, { tier, type: 'Extermination', mins: 60, hard: true, node: `${long} (Kuva Fortress)` }]).map(fissure),
        alerts: Array.from({ length: 12 }, (_, i) => ({
          id: `a${i}`,
          expiry: iso(NOW + (i + 1) * 10 * MIN),
          mission: { description: `Gift of the Lotus number ${i}`, type: 'Mobile Defense', node: `${long}${i} (Kuva Fortress)`, faction: 'Corrupted', reward: reward([`Orokin Catalyst Blueprint ${i}`, 'Umbra Forma Blueprint', 'Exilus Weapon Adapter Blueprint'], 150_000 + i) },
        })),
        invasions: Array.from({ length: 12 }, (_, i) => ({
          id: `i${i}`,
          node: `${long}${i} (Kuva Fortress)`,
          completed: false,
          vsInfestation: false,
          attacker: { faction: 'Grineer', reward: reward([`Wraith Twin Vipers Receiver ${i}`]) },
          defender: { faction: 'Corpus', reward: reward([`Sheev Vandal Blueprint and a very long name ${i}`]) },
        })),
        events: Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, description: `Operation: Something With A Very Long Name Indeed ${i}`.repeat(3), expiry: iso(NOW + 24 * HOUR) })),
      });
      const full = input({ ws: busy, stale: true, prices: () => 99, arby: view({ current: slot(HOUR_START, { tier: 'C', name: long, planet: 'Kuva Fortress', mission: 'Mobile Defense', faction: 'Corrupted' }) }) });
      // More of a member's own lines than a card can hold: the card is cut in the middle, never at its end.
      const personal = Array.from({ length: 60 }, (_, i) => `Your relic line number ${i} with a fairly long explanation of what it is good for`);
      for (const c of [nowCard(full), nowCard(full, { personal }), nowCard(input())]) {
        const s = messageStats([c]);
        assert.ok(s.text <= 4000, `${s.text} characters of text`);
        assert.ok(s.components <= 40, `${s.components} components`);
        const t = componentText([c]);
        assert.match(t, /-# As of <t:\d+:t>\. The World State channels keep themselves up to date\.\n\[Squad up\] \[Arbitrations\] \[Fissures\] \[Alerts\] \[Traders\]$/);
        assert.ok(t.includes('**Arbitration**'));
      }
      assert.match(componentText([nowCard(full, { personal })]), /Sortie \(Vay Hek\) resets .*\n-# .*may be outdated.*\n-# As of /, 'the resets and the note that the data is old are kept too');
      assert.ok(componentText([nowCard(full)]).includes('…and 19 more'), 'five rewards are shown, the rest are counted');
      const cut = componentText([nowCard(full, { personal })]);
      assert.match(cut, /Your relic line number 0 .*\n[^]*-# …and \d+ more\n/, 'the lines that did not fit are counted');
      assert.ok(!cut.includes('Your relic line number 59'));
      assert.ok(messageStats([nowCard(full, { personal })]).text > 3000, 'and the card is as full as it may be');
    });
  });

  describe('the command', () => {
    type Call = [string, { flags?: number; components?: unknown[]; allowedMentions?: unknown }];
    const fake = () => {
      const calls: Call[] = [];
      const record = (name: string) => async (o: Call[1] = {}) => void calls.push([name, o]);
      return { calls, interaction: { reply: record('reply'), deferReply: record('deferReply'), editReply: record('editReply') } as unknown as Parameters<typeof answerNow>[0] };
    };

    it('answers with the card at once when the data is at hand, for the member alone unless shared', async () => {
      const mine = fake();
      await answerNow(mine.interaction, Promise.resolve(input()), false);
      assert.deepEqual(mine.calls.map(([name]) => name), ['reply']);
      assert.equal(mine.calls[0]![1].flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
      assert.equal(mine.calls[0]![1].components?.length, 1);
      assert.deepEqual(mine.calls[0]![1].allowedMentions, { parse: [] });

      const shared = fake();
      await answerNow(shared.interaction, Promise.resolve(input()), true);
      assert.equal(shared.calls[0]![1].flags, MessageFlags.IsComponentsV2);
    });

    it('says it is thinking first when the source is slow', async () => {
      const slow = fake();
      await answerNow(slow.interaction, new Promise((done) => setTimeout(() => done(input()), 60)), false, 5);
      assert.deepEqual(slow.calls.map(([name]) => name), ['deferReply', 'editReply']);
      assert.equal(slow.calls[0]![1].flags, MessageFlags.Ephemeral);
      assert.equal(slow.calls[1]![1].flags, MessageFlags.IsComponentsV2);
      assert.equal(slow.calls[1]![1].components?.length, 1);

      const shared = fake();
      await answerNow(shared.interaction, new Promise((done) => setTimeout(() => done(input()), 60)), true, 5);
      assert.equal(shared.calls[0]![1].flags, undefined, 'a shared card is deferred in the open');
    });
  });
});
