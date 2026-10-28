import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SECTIONS, summarizeWorldState } from '../src/mcp/worldstate-summary.js';
import type { WorldState } from '../src/warframe/worldstate.js';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const sortie = { boss: 'Vor', faction: 'Grineer', expiry: '2026-10-28T20:00:00Z', variants: [{ missionType: 'Capture', node: 'Cairo (Sedna)', modifier: 'Eximus Stronghold' }] };

describe('summarizeWorldState', () => {
  it('summarizes the sections it is asked for', () => {
    const out = summarizeWorldState({ sortie } as unknown as WorldState, ['sortie'], NOW);
    assert.equal(out.fetchedAt, '2026-10-28T12:00:00.000Z');
    assert.equal((out.sortie as { boss: string }).boss, 'Vor');
    assert.equal('unavailable' in out, false);
  });

  it('leaves out a section the feed delivered malformed and still answers the others', () => {
    // A feed that drops a list (the invasions) or fills one with rubbish (Baro's inventory) used to fail the whole answer.
    const ws = { sortie, voidTrader: { location: 'Larunda Relay', activation: '2026-10-28T10:00:00Z', expiry: '2026-10-30T10:00:00Z', inventory: [null] } } as unknown as WorldState;
    const out = summarizeWorldState(ws, ['sortie', 'invasions', 'baro'], NOW);
    assert.equal((out.sortie as { boss: string }).boss, 'Vor');
    assert.deepEqual(out.unavailable, ['invasions', 'baro']);
    assert.equal('invasions' in out, false);
  });

  it('does not repeat a section that was asked for twice, and tolerates an empty feed', () => {
    const out = summarizeWorldState({} as unknown as WorldState, ['sortie', 'sortie'], NOW);
    assert.equal('unavailable' in out, false, 'a sortie that is not in the feed is simply absent');
    // Most sections just come out empty on an empty feed; the two that need their data to exist are reported.
    assert.deepEqual(summarizeWorldState({} as unknown as WorldState, SECTIONS, NOW).unavailable, ['cycles', 'invasions']);
  });
});
