import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueueFullError, WorkQueue } from '../src/queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('WorkQueue', () => {
  it('lets a job through at once when there is room, and keeps the others in order', async () => {
    const q = new WorkQueue('t', { concurrency: 1 });
    const a = q.join('a');
    assert.equal(a.position(), 0);
    const b = q.join('b');
    const c = q.join('c');
    assert.deepEqual([b.position(), c.position()], [1, 2]);
    assert.deepEqual(q.snapshot(), { running: 1, waiting: 2 });

    const order: string[] = [];
    void b.ready.then(() => order.push('b'));
    void c.ready.then(() => order.push('c'));
    await sleep(5);
    assert.deepEqual(order, [], 'nobody starts while a runs');
    a.release();
    await sleep(5);
    assert.deepEqual(order, ['b']);
    assert.equal(c.position(), 1, 'c moved up');
    b.release();
    await sleep(5);
    assert.deepEqual(order, ['b', 'c']);
    c.release();
    assert.deepEqual(q.snapshot(), { running: 0, waiting: 0 });
  });

  it('tells a waiting job each time its position changes', async () => {
    const q = new WorkQueue('t');
    const first = q.join('a');
    const seen: number[] = [];
    q.join('b');
    const third = q.join('c', (n) => seen.push(n));
    assert.equal(third.position(), 2);
    first.release();
    assert.deepEqual(seen, [1]);
  });

  it('runs as many at once as the concurrency says', () => {
    const q = new WorkQueue('t', { concurrency: 2 });
    const t = [q.join('a'), q.join('b'), q.join('c')];
    assert.deepEqual(t.map((x) => x.position()), [0, 0, 1]);
  });

  it('lets someone leave the line, and everybody behind moves up', () => {
    const q = new WorkQueue('t');
    q.join('a');
    const b = q.join('b');
    const seen: number[] = [];
    const c = q.join('c', (n) => seen.push(n));
    b.release();
    assert.equal(c.position(), 1);
    assert.deepEqual(seen, [1]);
    b.release();
    assert.equal(q.snapshot().waiting, 1, 'releasing twice changes nothing');
  });

  it('limits what one person may have in the queue, and how many may wait overall', () => {
    const q = new WorkQueue('t', { perKey: 2, maxWaiting: 2 });
    q.join('a');
    q.join('a');
    assert.throws(() => q.join('a'), (e) => e instanceof QueueFullError && e.reason === 'user');
    q.join('b');
    assert.throws(() => q.join('c'), (e) => e instanceof QueueFullError && e.reason === 'full');
    assert.equal(q.stats.refused, 2);
  });

  it('frees the place of a job that never finishes', async () => {
    const q = new WorkQueue('t', { maxHoldMs: 20 });
    q.join('a');
    const b = q.join('b');
    await sleep(60);
    assert.equal(b.position(), 0, 'b got its turn when the stuck job was released');
  });

  it('applies new limits at once: more room starts waiting jobs', () => {
    const q = new WorkQueue('t');
    q.join('a');
    const b = q.join('b');
    q.configure({ concurrency: 2 });
    assert.equal(b.position(), 0);
  });
});

