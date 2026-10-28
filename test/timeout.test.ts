import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withTimeout } from '../src/timeout.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withTimeout', () => {
  it('returns what the work returns, and clears its timer', async () => {
    let created = 0;
    assert.equal(
      await withTimeout(Promise.resolve(5), 20, () => {
        created++;
        return new Error('late');
      }),
      5,
    );
    await wait(60);
    assert.equal(created, 0, 'the timeout must not fire after the work finished');
  });

  it('rejects with the given error when the work is too slow', async () => {
    await assert.rejects(
      withTimeout(wait(200), 20, () => new Error('too slow')),
      /too slow/,
    );
  });

  it('passes the work\'s own failure through', async () => {
    await assert.rejects(
      withTimeout(Promise.reject(new Error('broken')), 1000, () => new Error('too slow')),
      /broken/,
    );
  });
});
