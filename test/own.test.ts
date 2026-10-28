import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolStatus } from '../src/answers/status.js';
import { own } from '../src/own.js';
import { resolveStat } from '../src/rivens/stats.js';
import type { RivenAttribute } from '../src/rivens/types.js';

const attrs: RivenAttribute[] = [{ slug: 'critical_chance', name: 'Critical Chance', positiveOnly: false, negativeOnly: false }];

describe('own', () => {
  it('finds what a table defines and nothing it merely inherits', () => {
    const table: Record<string, string> = { cc: 'critical chance' };
    assert.equal(own(table, 'cc'), 'critical chance');
    assert.equal(own(table, 'missing'), undefined);
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) assert.equal(own(table, inherited), undefined, inherited);
  });

  it('keeps a typed stat name or a model-chosen tool name from reaching Object.prototype', () => {
    // These used to throw "is not iterable" / "split is not a function" out of the lookup.
    assert.equal(resolveStat(attrs, 'constructor'), null);
    assert.equal(resolveStat(attrs, 'toString'), null);
    assert.equal(resolveStat(attrs, 'crit constructor'), null);
    assert.equal(toolStatus('constructor'), '🔧 Using constructor');
    assert.equal(toolStatus('search_wiki'), '🔎 Searching the wiki');
  });
});
