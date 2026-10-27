import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { reportQueue, withStatus } from '../src/answers/status.js';
import { withAsker, withModelSlot } from '../src/answers/slot.js';
import { renderQueued, startProgress } from '../src/discord/progress.js';
import { QueueFullError, WorkQueue, questionQueue } from '../src/queue.js';

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

describe('the question queue and the notice', () => {
  afterEach(() => questionQueue.configure({ concurrency: 1, maxWaiting: 20 }));

  it('reports the position to the answer that waits, and 0 when its turn comes', async () => {
    const seen: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withAsker('u1', () => withModelSlot(() => gate));
    await sleep(2);
    const listener = Object.assign(() => {}, { queue: (n: number) => seen.push(n) });
    const second = withStatus(listener, () => withAsker('u2', () => withModelSlot(async () => 'done')));
    await sleep(5);
    assert.deepEqual(seen, [1], 'told it is next in line');
    release();
    assert.equal(await second, 'done');
    await first;
    assert.deepEqual(seen, [1, 0], 'then that it is its turn');
  });

  it('says nothing when there is no wait', async () => {
    const seen: number[] = [];
    await withStatus(Object.assign(() => {}, { queue: (n: number) => seen.push(n) }), () => withModelSlot(async () => 1));
    assert.deepEqual(seen, []);
  });

  it('rejects a third question from the same person while two are in the queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = withAsker('u1', () => withModelSlot(() => gate));
    const b = withAsker('u1', () => withModelSlot(async () => 'b'));
    await sleep(2);
    await assert.rejects(withAsker('u1', () => withModelSlot(async () => 'c')), QueueFullError);
    release();
    await Promise.all([a, b]);
  });

  it('frees the place when the answer fails', async () => {
    await assert.rejects(withAsker('u1', () => withModelSlot(async () => { throw new Error('boom'); })), /boom/);
    assert.deepEqual(questionQueue.snapshot(), { running: 0, waiting: 0 });
  });

  it('shows the queue message at once, keeps the place up to date, then turns into the normal thinking message', async () => {
    const log: string[] = [];
    const notice = { edit: async (p: { content: string }) => void log.push(`edit:${p.content}`), delete: async () => void log.push('delete') };
    const p = startProgress(async (t) => (log.push(`post:${t}`), notice), { delayMs: 60_000, everyMs: 20 });
    p.listener.queue?.(3);
    await sleep(10);
    assert.match(log[0]!, /^post:⏳ \*\*Ordis is busy with other questions\.\*\* You're \*\*#3\*\* in the queue/, 'no 2.5 s delay when waiting');
    p.listener.queue?.(1);
    await sleep(15);
    assert.match(log.at(-1)!, /edit:⏳ .*next in line/);
    p.listener.queue?.(0);
    await sleep(15);
    assert.match(log.at(-1)!, /edit:🧠 \*\*Ordis is thinking…\*\*/);
    assert.match(log.at(-1)!, /` 0 s|` [0-1] s/, 'the thinking clock starts at its turn');
    p.set('🔎 Searching the wiki');
    await sleep(30);
    assert.match(log.at(-1)!, /Searching the wiki/);
    await p.discard();
    assert.equal(log.at(-1), 'delete');
    assert.equal(log.filter((l) => l.startsWith('post:')).length, 1, 'one message the whole time');
  });

  it('renders the line position', () => {
    assert.match(renderQueued(1, 4000), /next in line\*\*, waiting 4 s/);
    assert.match(renderQueued(5, 0), /#5\*\* in the queue/);
    assert.doesNotThrow(() => reportQueue(1), 'a no-op outside an answer');
  });
});
