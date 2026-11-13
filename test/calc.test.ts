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

  it('knows pi, the square root sign and a multiplication written without a sign', () => {
    const near = (expression: string, value: number) => assert.ok(Math.abs(calculate(expression) - value) < 1e-9, `${expression} = ${calculate(expression)}`);
    near('2 * pi', 2 * Math.PI);
    near('2π', 2 * Math.PI);
    near('2pi', 2 * Math.PI);
    near('pi / 2', Math.PI / 2);
    near('e ^ 2', Math.E ** 2);
    assert.equal(calculate('√16'), 4);
    assert.equal(calculate('√(9 + 16)'), 5);
    assert.equal(calculate('2√16'), 8);
    assert.equal(calculate('3(4 + 1)'), 15);
    assert.equal(calculate('(1 + 2)(3 + 4)'), 21);
    assert.equal(calculate('2 x sqrt(16)'), 8);
    assert.equal(calculate('3 x (4 + 1)'), 15);
    assert.equal(calculate('2e3'), 2000, 'scientific notation is still one number');
    assert.equal(calculate('max(2, 9)'), 9, 'the x in a name is not a multiplication');
    assert.equal(calculate('15% * 200'), 30);
    assert.equal(calculate('log(1000) + ln(e)'), 4);
  });

  it('rejects anything that is not plain maths', () => {
    for (const bad of ['', '2 +', '1 / 0', 'process.exit()', 'require("fs")', 'foo(1)', 'x', '(((', '1'.repeat(300)]) assert.throws(() => calculate(bad), /./, bad);
  });
});
