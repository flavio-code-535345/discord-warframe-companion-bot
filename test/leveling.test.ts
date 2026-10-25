import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { levelOf, levelTier, mayEarnMessageXp, planLevelRoles, progressOf, rollMessageXp, xpForLevel, xpForNextLevel, type LevelRole } from '../src/leveling/xp.js';

const role = (id: string, name: string, position: number, managed = false): LevelRole => ({ id, name, position, managed });

describe('xp curve', () => {
  it('follows 5n²+50n+100 per level', () => {
    assert.equal(xpForNextLevel(0), 100);
    assert.equal(xpForNextLevel(1), 155);
    assert.equal(xpForLevel(2), 255);
  });

  it('derives the level and progress from total xp', () => {
    assert.equal(levelOf(0), 0);
    assert.equal(levelOf(99), 0);
    assert.equal(levelOf(100), 1);
    assert.deepEqual(progressOf(120), { level: 1, into: 20, needed: 155 });
    assert.equal(levelOf(xpForLevel(60)), 60);
    assert.equal(levelOf(xpForLevel(60) - 1), 59);
  });

  it('rolls 15-25 xp and enforces the cooldown', () => {
    assert.equal(rollMessageXp(() => 0), 15);
    assert.equal(rollMessageXp(() => 0.9999), 25);
    assert.equal(mayEarnMessageXp(1000, 30_000), false);
    assert.equal(mayEarnMessageXp(1000, 61_000), true);
  });
});

describe('level roles', () => {
  const roles = [role('a', 'Level 1+', 10), role('b', 'Level 5+', 11), role('c', 'Level 10+', 12), role('x', 'MR 5', 13), role('m', 'Level 15+', 14, true), role('hi', 'Level 20+', 99)];

  it('parses tier names', () => {
    assert.equal(levelTier('Level 10+'), 10);
    assert.equal(levelTier('level 5'), 5);
    assert.equal(levelTier('MR 10'), null);
    assert.equal(levelTier('Level up squad'), null);
  });

  it('gives the highest tier at or below the level and takes lower ones away', () => {
    const plan = planLevelRoles(roles, 7, new Set(['a']), 50);
    assert.equal(plan.add?.id, 'b');
    assert.deepEqual(plan.remove.map((r) => r.id), ['a']);
  });

  it('does nothing when the member already holds the right tier', () => {
    const plan = planLevelRoles(roles, 12, new Set(['c']), 50);
    assert.equal(plan.add, null);
    assert.deepEqual(plan.remove, []);
  });

  it('gives no role below level 1 and clears tiers after a reset', () => {
    const plan = planLevelRoles(roles, 0, new Set(['b']), 50);
    assert.equal(plan.add, null);
    assert.deepEqual(plan.remove.map((r) => r.id), ['b']);
  });

  it('skips managed roles and roles above the bot', () => {
    const plan = planLevelRoles(roles, 25, new Set(), 50);
    assert.equal(plan.add?.id, 'c');
  });
});

describe('xp storage', () => {
  it('adds xp, counts messages and ranks members', () => {
    const s = new Store(':memory:');
    assert.deepEqual(s.addXp('g', 'u1', 20, 1000), { before: 0, after: 20 });
    s.addXp('g', 'u1', 20, 2000);
    s.addXp('g', 'u2', 100, 2000);
    assert.equal(s.getMemberXp('g', 'u1')?.messages, 2);
    assert.equal(s.getMemberXp('g', 'u1')?.lastXpAt, 2000);
    assert.equal(s.xpPosition('g', 'u1'), 2);
    assert.deepEqual(s.topXp('g', 10).map((r) => r.userId), ['u2', 'u1']);
    assert.equal(s.countXpMembers('g'), 2);
  });

  it('voice xp leaves the message cooldown alone', () => {
    const s = new Store(':memory:');
    s.addXp('g', 'u', 20, 1000);
    s.addXp('g', 'u', 10, 9000, false);
    const row = s.getMemberXp('g', 'u')!;
    assert.equal(row.xp, 30);
    assert.equal(row.messages, 1);
    assert.equal(row.lastXpAt, 1000);
  });

  it('sets, resets and toggles ignored channels', () => {
    const s = new Store(':memory:');
    s.setXp('g', 'u', 500);
    assert.equal(s.getMemberXp('g', 'u')?.xp, 500);
    assert.equal(s.resetXp('g', 'u'), true);
    assert.equal(s.getMemberXp('g', 'u'), null);
    assert.equal(s.toggleXpIgnored('g', 'c'), true);
    assert.deepEqual(s.xpIgnoredChannels('g'), ['c']);
    assert.equal(s.toggleXpIgnored('g', 'c'), false);
  });

  it('keeps the leveling settings', () => {
    const s = new Store(':memory:');
    assert.equal(s.getSettings('g').levelingOff, null);
    s.updateSettings('g', { levelingOff: 1, levelChannelId: '42' });
    assert.equal(s.getSettings('g').levelingOff, 1);
    assert.equal(s.getSettings('g').levelChannelId, '42');
  });
});

describe('screenshot claims reset', () => {
  it('forgets every claim so the same card can be used again', () => {
    const s = new Store(':memory:');
    assert.equal(s.claimSs('g', 'image', 'hash', 'u1'), null);
    assert.equal(s.claimSs('g', 'image', 'hash', 'u2'), 'u1');
    assert.equal(s.resetSsClaims('g'), 1);
    assert.equal(s.claimSs('g', 'image', 'hash', 'u2'), null);
  });
});
