import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StringSelectMenuInteraction } from 'discord.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { TRACK_OPTIONS, alertsComponents, handleAlertsSelect } from '../src/discord/alerts-panel.js';
import { MAX_TRACKERS_PER_USER, collectTrackables, describeTracker, matchTracker, parseSpec } from '../src/trackers.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const MIN = 60_000;
const now = Date.parse('2026-10-30T12:00:00.000Z');
const at = (mins: number) => new Date(now + mins * MIN);
const G = 'g1';

const ws = {
  arbitration: { node: 'Hydron (Sedna)', type: 'Survival', enemy: 'Grineer', expired: false, activation: at(-5), expiry: at(55) },
  sortie: { id: 's1', boss: 'Vor', expiry: at(300), variants: [{ missionType: 'Spy', node: 'Pluto', modifier: 'x' }] },
  archonHunt: { id: 'a1', boss: 'Archon Amar', expiry: at(3000), missions: [{ type: 'Assassination', node: 'Sedna' }] },
} as unknown as WorldState;

function fakeSelect(store: Store, values: string[]) {
  const replies: { content?: string }[] = [];
  const interaction = { customId: 'alerts:track', values, user: { id: 'u1' }, reply: async (p: { content?: string }) => void replies.push(p) } as unknown as StringSelectMenuInteraction;
  const ctx = { store, config: { DISCORD_GUILD_ID: G } } as unknown as AppContext;
  return { interaction, ctx, replies };
}

describe('the alerts panel', () => {
  it('has three rows, a menu with every option and valid custom ids', () => {
    const rows = alertsComponents().map((r) => r.toJSON());
    assert.equal(rows.length, 3);
    const menu = rows[1]!.components[0] as { custom_id: string; options: unknown[]; max_values: number };
    assert.equal(menu.custom_id, 'alerts:track');
    assert.equal(menu.options.length, TRACK_OPTIONS.length);
    assert.ok(TRACK_OPTIONS.length <= 25);
    assert.equal(new Set(TRACK_OPTIONS.map((o) => o.value)).size, TRACK_OPTIONS.length);
    for (const o of TRACK_OPTIONS) assert.deepEqual(parseSpec(JSON.stringify(o.spec)), o.spec);
  });

  it('creates trackers from the menu and skips ones the member already has', async () => {
    const store = new Store(':memory:');
    const first = fakeSelect(store, ['arbitration', 'sortie']);
    await handleAlertsSelect(first.interaction, first.ctx);
    assert.equal(store.listTrackers(G, 'u1').length, 2);
    assert.match(first.replies[0]!.content!, /Arbitration/);

    const again = fakeSelect(store, ['arbitration', 'archon']);
    await handleAlertsSelect(again.interaction, again.ctx);
    assert.equal(store.listTrackers(G, 'u1').length, 3);
    assert.match(again.replies[0]!.content!, /Already set/);
  });

  it('stops at the tracker limit', async () => {
    const store = new Store(':memory:');
    for (let i = 0; i < MAX_TRACKERS_PER_USER; i++) store.createTracker(G, 'u1', JSON.stringify({ kind: 'reward', keyword: `thing${i}` }));
    const t = fakeSelect(store, ['baro']);
    await handleAlertsSelect(t.interaction, t.ctx);
    assert.equal(store.listTrackers(G, 'u1').length, MAX_TRACKERS_PER_USER);
    assert.match(t.replies[0]!.content!, /most allowed/);
  });
});

describe('arbitration, sortie and archon trackers', () => {
  const items = collectTrackables(ws, now);
  const hits = (spec: Parameters<typeof matchTracker>[0]) => items.filter((i) => matchTracker(spec, i) !== null).map((i) => i.key);

  it('collects them with stable keys', () => {
    assert.ok(items.some((i) => i.key.startsWith('arbitration:')));
    assert.ok(items.some((i) => i.key === 'sortie:s1'));
    assert.ok(items.some((i) => i.key === 'archon:a1'));
  });

  it('matches an arbitration by type, case-insensitively', () => {
    assert.equal(hits({ kind: 'arbitration' }).length, 1);
    assert.equal(hits({ kind: 'arbitration', type: 'survival' }).length, 1);
    assert.equal(hits({ kind: 'arbitration', type: 'Defense' }).length, 0);
  });

  it('matches a sortie by mission and an archon hunt always', () => {
    assert.ok(hits({ kind: 'sortie' }).includes('sortie:s1'));
    assert.ok(hits({ kind: 'sortie', mission: 'Spy' }).includes('sortie:s1'));
    assert.ok(!hits({ kind: 'sortie', mission: 'Capture' }).includes('sortie:s1'));
    assert.ok(hits({ kind: 'archon' }).includes('archon:a1'));
  });

  it('describes them', () => {
    assert.equal(describeTracker({ kind: 'arbitration', type: 'Defense' }), 'Arbitration (Defense)');
    assert.equal(describeTracker({ kind: 'arbitration' }), 'Arbitration (any)');
    assert.equal(describeTracker({ kind: 'archon' }), 'Weekly Archon Hunt');
  });
});
