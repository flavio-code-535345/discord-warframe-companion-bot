import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRoleMove } from '../src/mcp/role-order.js';

const roles = (...ids: string[]) => ids.map((id, i) => ({ id, position: i + 1 })); // a is the lowest

const apply = (movable: { id: string; position: number }[], changes: { id: string; position: number }[]) => {
  const next = new Map(movable.map((r) => [r.id, r.position]));
  for (const c of changes) next.set(c.id, c.position);
  return [...next].sort((a, b) => a[1] - b[1]).map(([id]) => id).join('');
};

test('moving up inserts at the final position and shifts the ones in between down', () => {
  const r = roles('a', 'b', 'c', 'd', 'e');
  assert.equal(apply(r, planRoleMove(r, 'a', 4)), 'bcdae');
  assert.equal(apply(r, planRoleMove(r, 'a', 5)), 'bcdea');
});

test('moving down shifts the ones in between up', () => {
  const r = roles('a', 'b', 'c', 'd', 'e');
  assert.equal(apply(r, planRoleMove(r, 'e', 2)), 'aebcd');
  assert.equal(apply(r, planRoleMove(r, 'e', 1)), 'eabcd');
});

test('only roles whose position changes are sent, and a move to the same place sends nothing', () => {
  const r = roles('a', 'b', 'c', 'd', 'e');
  assert.deepEqual(planRoleMove(r, 'c', 3), []);
  assert.deepEqual(planRoleMove(r, 'b', 3).map((x) => x.id).sort(), ['b', 'c']);
});

test('out-of-range positions are clamped and an unknown role changes nothing', () => {
  const r = roles('a', 'b', 'c');
  assert.equal(apply(r, planRoleMove(r, 'a', 99)), 'bca');
  assert.equal(apply(r, planRoleMove(r, 'c', 0)), 'cab');
  assert.deepEqual(planRoleMove(r, 'zzz', 2), []);
});

test('ties in the stored numbers are renumbered cleanly', () => {
  const r = [{ id: 'a', position: 1 }, { id: 'b', position: 1 }, { id: 'c', position: 3 }];
  const changes = planRoleMove(r, 'c', 1);
  assert.deepEqual(changes.map((x) => x.position).sort(), [1, 2, 3]);
});
