import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EmbedBuilder } from 'discord.js';
import { Store } from '../src/db.js';
import { Notifier, type SummaryChannel, newItemsText, updateSummaryMessage } from '../src/discord/notifier.js';
import { summaryEmbed, summaryHash } from '../src/discord/summary.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const MIN = 60_000;
const now = Date.parse('2026-10-27T16:00:00.000Z');
const at = (mins: number) => new Date(now + mins * MIN);
const opts = { botName: 'Ordis', clanName: 'The Rats Den 69' };

const world = (over: Record<string, unknown> = {}): WorldState =>
  ({
    cetusCycle: { isDay: true, expiry: at(30) },
    vallisCycle: { isWarm: true, expiry: at(20) },
    earthCycle: { isDay: true, expiry: at(60) },
    cambionCycle: { state: 'fass', expiry: at(30) },
    zarimanCycle: { state: 'grineer', isCorpus: false, expiry: at(60) },
    duviriCycle: { state: 'joy', expiry: at(60) },
    fissures: [
      { tier: 'Lith', isHard: false, isStorm: false, expiry: at(20) },
      { tier: 'Lith', isHard: true, isStorm: false, expiry: at(20) },
      { tier: 'Neo', isHard: false, isStorm: true, expiry: at(20) },
      { tier: 'Axi', isHard: false, isStorm: false, expiry: at(-5) },
    ],
    sortie: { id: 's1', boss: 'Vor', expiry: at(300), variants: [{ missionType: 'Capture', node: 'Pluto', modifier: 'Eximus Stronghold' }] },
    archonHunt: { id: 'a1', boss: 'Archon Amar', expiry: at(3000), missions: [{ type: 'Assassination', node: 'Sedna' }] },
    voidTrader: { id: 'b1', activation: at(-60), expiry: at(2000), location: 'Kronia Relay', inventory: [{ item: 'x', ducats: 1, credits: 1 }, { item: 'y', ducats: 1, credits: 1 }] },
    steelPath: { currentReward: { name: 'Umbra Forma', cost: 150 }, activation: at(-100), expiry: at(5000), rotation: [] },
    alerts: [{ id: 'al1', expiry: at(40), mission: { description: 'Mutalist', type: 'Capture', node: 'Eris', faction: 'Infested', reward: { items: ['Orokin Catalyst Blueprint'] } } }],
    invasions: [
      { id: 'i1', completed: false, node: 'Mars', desc: 'D', vsInfestation: false, completion: 50, attacker: { faction: 'Grineer', reward: { items: ['Orokin Reactor Blueprint'] } }, defender: { faction: 'Corpus', reward: { countedItems: [{ count: 3, type: 'Fieldron' }] } } },
      { id: 'i2', completed: false, node: 'Ceres', desc: 'D', vsInfestation: false, completion: 50, attacker: { faction: 'Grineer', reward: { countedItems: [{ count: 3, type: 'Mutagen Mass' }] } }, defender: { faction: 'Corpus', reward: { countedItems: [{ count: 3, type: 'Fieldron' }] } } },
    ],
    ...over,
  }) as unknown as WorldState;

const fieldsOf = (e: EmbedBuilder) => Object.fromEntries((e.toJSON().fields ?? []).map((f) => [f.name, f.value]));

describe('the summary message', () => {
  it('says everything in one embed: cycles, fissures by tier, sortie, archon hunt, Baro, steel path, alerts and notable invasions', () => {
    const fields = fieldsOf(summaryEmbed(world(), opts, now));
    const names = Object.keys(fields);
    assert.deepEqual(names, ['🌍 Cycles', '🌀 Void fissures', '⚔️ Daily sortie — Vor', '🗡️ Archon Hunt — Archon Amar', "👑 Baro Ki'Teer", '🔱 Steel Path honors', '⚠️ Alerts', '🎯 Invasions worth running']);
    assert.match(fields['🌍 Cycles']!, /Cetus\*\* ☀️ day.*\n.*Orb Vallis\*\* 🔥 warm.*\n.*Cambion Drift\*\* Fass.*\n.*Zariman\*\* Grineer.*\n.*Duviri\*\* Joy/);
    assert.match(fields['🌀 Void fissures']!, /^\*\*Lith\*\* 2 · \*\*Neo\*\* 1\n🔱 1 Steel Path · 🌀 1 Void Storm\n/, 'the expired Axi fissure is not counted');
    assert.match(fields['⚔️ Daily sortie — Vor']!, /Capture — Pluto · Eximus Stronghold\nResets <t:/);
    assert.match(fields["👑 Baro Ki'Teer"]!, /At \*\*Kronia Relay\*\*, leaves <t:\d+:R>\n2 items/);
    assert.match(fields['🔱 Steel Path honors']!, /Umbra Forma — 150 Steel Essence/);
    assert.match(fields['⚠️ Alerts']!, /Mutalist\*\* — Eris · Orokin Catalyst Blueprint/);
    assert.match(fields['🎯 Invasions worth running']!, /Mars/);
    assert.doesNotMatch(fields['🎯 Invasions worth running']!, /Ceres/);
  });

  it('leaves out what is over or missing, and Baro when he is away says when he arrives', () => {
    const fields = fieldsOf(
      summaryEmbed(world({ sortie: { id: 's', expiry: at(-1), variants: [] }, archonHunt: undefined, steelPath: undefined, alerts: [], invasions: [], voidTrader: { id: 'b', activation: at(600), expiry: at(2000), location: 'Larunda Relay', inventory: [] } }), opts, now),
    );
    assert.deepEqual(Object.keys(fields), ['🌍 Cycles', '🌀 Void fissures', "👑 Baro Ki'Teer"]);
    assert.match(fields["👑 Baro Ki'Teer"]!, /Arrives at \*\*Larunda Relay\*\* <t:/);
  });

  it('survives one malformed section instead of losing the whole message', () => {
    const fields = fieldsOf(summaryEmbed(world({ archonHunt: { id: 'a', expiry: at(10), missions: 5 } }), opts, now));
    assert.ok(fields['⚔️ Daily sortie — Vor']);
    assert.equal(Object.keys(fields).some((n) => n.includes('Archon')), false);
  });

  it('has a stable fingerprint, so it is only edited when something changed', () => {
    const a = summaryHash(summaryEmbed(world(), opts, now));
    assert.equal(summaryHash(summaryEmbed(world(), opts, now + 10_000)), a);
    assert.notEqual(summaryHash(summaryEmbed(world({ fissures: [] }), opts, now)), a);
  });

  it('stays within Discord limits with a lot going on', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, expiry: at(30), mission: { description: `Alert number ${i}`, type: 'Capture', node: 'Eris (Eris)', faction: 'Infested', reward: { items: ['Orokin Catalyst Blueprint'] } } }));
    const json = summaryEmbed(world({ alerts: many }), opts, now).toJSON();
    for (const f of json.fields ?? []) assert.ok(f.value.length <= 1024);
    assert.ok(JSON.stringify(json).length < 6000);
  });
});

describe('keeping the message up to date', () => {
  const setup = () => {
    const store = new Store(':memory:');
    const log: string[] = [];
    let n = 0;
    let failEdit: unknown = null;
    const channel: SummaryChannel = {
      id: 'chan',
      guildId: 'g',
      send: async () => {
        log.push('send');
        return { id: `m${++n}` };
      },
      messages: {
        edit: async (id) => {
          log.push(`edit ${id}`);
          if (failEdit) throw failEdit;
        },
      },
    };
    const ctx = { store, client: {}, config: { BOT_NAME: 'Ordis', CLAN_NAME: 'Rats', DISCORD_GUILD_ID: 'g' } } as never;
    return { ctx, channel, log, store, breakEdit: (e: unknown) => (failEdit = e) };
  };

  it('posts once, then edits only when something changed (at most every two minutes unless something new happened)', async () => {
    const { ctx, channel, log } = setup();
    assert.equal(await updateSummaryMessage(ctx, channel, world(), { force: false, now }), 'https://discord.com/channels/g/chan/m1');
    assert.deepEqual(log, ['send']);
    await updateSummaryMessage(ctx, channel, world(), { force: false, now: now + 5 * MIN });
    assert.deepEqual(log, ['send'], 'nothing changed: no API call at all');
    await updateSummaryMessage(ctx, channel, world({ fissures: [] }), { force: false, now: now + MIN });
    assert.deepEqual(log, ['send'], 'changed, but edited a minute ago: wait');
    await updateSummaryMessage(ctx, channel, world({ fissures: [] }), { force: true, now: now + MIN });
    assert.deepEqual(log, ['send', 'edit m1'], 'something new: edit at once');
    await updateSummaryMessage(ctx, channel, world({ fissures: [], alerts: [] }), { force: false, now: now + 4 * MIN });
    assert.deepEqual(log, ['send', 'edit m1', 'edit m1'], 'changed and more than two minutes since the last edit');
  });

  it('posts a new one when the message was deleted, and passes on other errors', async () => {
    const { ctx, channel, log, breakEdit } = setup();
    await updateSummaryMessage(ctx, channel, world(), { force: false, now });
    breakEdit(Object.assign(new Error('Unknown Message'), { code: 10008 }));
    assert.equal(await updateSummaryMessage(ctx, channel, world({ fissures: [] }), { force: true, now: now + MIN }), 'https://discord.com/channels/g/chan/m2');
    assert.deepEqual(log, ['send', 'edit m1', 'send']);
    breakEdit(Object.assign(new Error('Missing Permissions'), { code: 50013 }));
    await assert.rejects(updateSummaryMessage(ctx, channel, world({ fissures: [], alerts: [] }), { force: true, now: now + 2 * MIN }), /Missing Permissions/);
  });

  it('keeps the same message across a restart', async () => {
    const { ctx, channel, log } = setup();
    await updateSummaryMessage(ctx, channel, world(), { force: false, now });
    const again = await updateSummaryMessage(ctx, channel, world({ fissures: [] }), { force: true, now: now + 10 * MIN });
    assert.equal(again, 'https://discord.com/channels/g/chan/m1');
    assert.deepEqual(log, ['send', 'edit m1']);
  });
});

describe('the short message that goes with a ping', () => {
  it('names what is new, caps the list, pings the role and links the summary', () => {
    const text = newItemsText(['⚠️ Alert: Mutalist', '🎯 Invasion worth running: Mars'], 'https://discord.com/channels/g/c/m', '123');
    assert.equal(text, '<@&123> 🔔 **New:** ⚠️ Alert: Mutalist · 🎯 Invasion worth running: Mars\n[Everything right now](<https://discord.com/channels/g/c/m>)');
    const long = newItemsText(Array.from({ length: 11 }, (_, i) => `Item ${i}`), 'u', null);
    assert.match(long, /^🔔 \*\*New:\*\* Item 0 · .* Item 7 · \+3 more\n/);
    assert.doesNotMatch(long, /<@&/);
  });
});

describe('the notifier', () => {
  it('posts the summary quietly at first, then edits it and pings once when something new appears', async () => {
    const store = new Store(':memory:');
    store.updateSettings('g', { alertsChannelId: 'chan', alertsRoleId: 'role1' });
    const sent: { content?: string; embeds?: unknown[]; allowedMentions: { roles?: string[] } }[] = [];
    const edits: string[] = [];
    const channel = {
      id: 'chan',
      guildId: 'g',
      isSendable: () => true,
      send: async (p: (typeof sent)[number]) => {
        sent.push(p);
        return { id: `m${sent.length}` };
      },
      messages: { edit: async (id: string) => void edits.push(id) },
    };
    const ctx = { store, client: { channels: { fetch: async () => channel } }, config: { BOT_NAME: 'Ordis', CLAN_NAME: 'Rats', DISCORD_GUILD_ID: 'g' } } as never;
    const notifier = new Notifier(ctx) as unknown as { postWorldStateAlerts(ws: WorldState): Promise<void> };
    const future = Date.now() + 3_600_000;
    const base = (over: Record<string, unknown> = {}) => world({ sortie: { id: 's1', boss: 'Vor', expiry: new Date(future), variants: [] }, archonHunt: undefined, voidTrader: undefined, steelPath: undefined, alerts: [], invasions: [], ...over });

    await notifier.postWorldStateAlerts(base());
    assert.equal(sent.length, 1, 'the first run only posts the summary (what is already live is not announced as new)');
    assert.equal(sent[0]!.content, undefined);
    assert.equal(sent[0]!.embeds!.length, 1);

    await notifier.postWorldStateAlerts(base());
    assert.equal(sent.length, 1, 'nothing new: nothing sent');

    const alert = { id: 'al9', expiry: new Date(future), mission: { description: 'Mutalist', type: 'Capture', node: 'Eris', faction: 'Infested', reward: { items: ['Orokin Catalyst Blueprint'] } } };
    await notifier.postWorldStateAlerts(base({ alerts: [alert] }));
    assert.equal(sent.length, 2);
    assert.deepEqual(edits, ['m1'], 'the summary was brought up to date first');
    assert.match(sent[1]!.content!, /^<@&role1> 🔔 \*\*New:\*\* ⚠️ Alert: Mutalist\n\[Everything right now\]\(<https:\/\/discord\.com\/channels\/g\/chan\/m1>\)$/);
    assert.deepEqual(sent[1]!.allowedMentions.roles, ['role1']);
    assert.equal(sent[1]!.embeds, undefined, 'the ping is a short text, not another pile of embeds');
  });
});
