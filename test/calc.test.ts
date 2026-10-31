import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculate } from '../src/answers/calc.js';

describe('calculate', () => {
  it('does arithmetic with the usual precedence', () => {
    assert.equal(calculate('2 + 3 * 4'), 14);
    assert.equal(calculate('(2 + 3) * 4'), 20);
    assert.equal(calculate('2 ^ 3 ^ 2'), 512);
    assert.equal(calculate('-3 + 5'), 2);
    assert.equal(calculate('10 % 3'), 1);
    assert.equal(calculate('50%'), 0.5);
    assert.equal(calculate('20 x 3'), 60);
    assert.equal(calculate('max(2, 9, 4) + sqrt(16)'), 13);
    assert.ok(Math.abs(calculate('(1 - 0.9^10) * 100') - 65.13215599) < 1e-6);
  });

  it('rejects anything that is not plain maths', () => {
    for (const bad of ['', '2 +', '1 / 0', 'process.exit()', 'require("fs")', 'foo(1)', 'x', '(((', '1'.repeat(300)]) assert.throws(() => calculate(bad), /./, bad);
  });
});
