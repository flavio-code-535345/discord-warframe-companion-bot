import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { auditListings } from '../src/rivens/audit.js';
import type { RivenListing } from '../src/rivens/types.js';

const listing = (id: string, stats: { slug: string; value: number; positive: boolean }[]): RivenListing => ({ id, weapon: 'x', price: 100, polarity: 'madurai', rerolls: 0, stats });

describe('auditListings', () => {
  it('counts a pistol riven at the top of its range and spreads it by stat', () => {
    // 3 bonuses (0.75) and no curse, pistol Damage base 219.6, disposition 1.2: centre 197.64, top 217.4
    const top = listing('1', [
      { slug: 'base_damage_melee_damage', value: 217.4, positive: true },
      { slug: 'critical_chance', value: 135, positive: true },
      { slug: 'multishot', value: 107.7, positive: true },
    ]);
    const r = auditListings([{ weapon: { type: 'pistol', disposition: 1.2 }, listings: [top] }]);
    assert.equal(r.pistol!.listings, 1);
    assert.equal(r.pistol!.fit, 1);
    assert.ok(Math.abs(r.pistol!.spread['damage:bonus']!.max - 10) < 0.2);
  });

  it('reports a stat outside its window and a stat the kind has no range for', () => {
    const wrong = listing('1', [
      { slug: 'critical_chance', value: 400, positive: true },
      { slug: 'multishot', value: 100, positive: true },
    ]);
    const unknown = listing('2', [
      { slug: 'critical_chance', value: 178, positive: true },
      { slug: 'made_up_stat', value: 10, positive: true },
    ]);
    const r = auditListings([{ weapon: { type: 'rifle' }, listings: [wrong, unknown] }]);
    assert.equal(r.rifle!.fit, 0);
    assert.equal(r.rifle!.outOfRange.crit_chance, 1);
    assert.equal(r.rifle!.noRange.made_up_stat, 1);
  });

  it('keeps a weapon without a known kind apart', () => {
    const r = auditListings([{ weapon: { type: 'mystery' }, listings: [listing('1', [{ slug: 'multishot', value: 100, positive: true }, { slug: 'zoom', value: 50, positive: true }])] }]);
    assert.equal(r['mystery (no range)']!.listings, 1);
    assert.equal(r['mystery (no range)']!.fit, 0);
  });
});
