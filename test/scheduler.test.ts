import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Scheduler } from '../src/scheduler.js';

/** A clock whose timers only fire when the test moves time forward; each fired job is allowed to finish before the next one. */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    pending: () => timers.size,
    /** Moves the clock forward, firing every timer that falls due on the way, in order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
        await settle();
      }
      now = target;
    },
  };
}

describe('scheduler', () => {
  it('runs a job after its first delay and then at its interval', async () => {
    const clock = fakeClock();
    const jobs = new Scheduler(clock);
    let runs = 0;
    jobs.every('tick', 60_000, () => void runs++, { firstMs: 5_000 });
    jobs.start();
    await clock.advance(4_999);
    assert.equal(runs, 0);
    await clock.advance(1);
    assert.equal(runs, 1);
    await clock.advance(60_000);
    assert.equal(runs, 2);
    await clock.advance(120_000);
    assert.equal(runs, 4);
    const [s] = jobs.stats();
    assert.equal(s!.runs, 4);
    assert.equal(s!.failures, 0);
    assert.equal(s!.nextAt, clock.now() + 60_000);
  });

  it('keeps a failing job going and never lets it stop the others', async () => {
    const clock = fakeClock();
    const jobs = new Scheduler(clock);
    let good = 0;
    let bad = 0;
    jobs.every('bad', 1_000, () => {
      bad++;
      throw new Error('boom');
    });
    jobs.every('good', 1_000, () => void good++);
    const errors = console.error;
    console.error = () => {};
    try {
      jobs.start();
      await clock.advance(2_500);
    } finally {
      console.error = errors;
    }
    assert.equal(bad, 3);
    assert.equal(good, 3);
    const s = jobs.stats().find((j) => j.name === 'bad')!;
    assert.equal(s.failures, 3);
    assert.equal(s.lastError, 'boom');
    assert.equal(s.lastErrorAt, clock.now() - 500);
    assert.equal(s.lastFailed, true);
    assert.equal(jobs.stats().find((j) => j.name === 'good')!.lastFailed, false);
  });

  it('marks a job that recovered as no longer failing, in the same millisecond too', async () => {
    const clock = fakeClock();
    const jobs = new Scheduler(clock);
    let n = 0;
    jobs.every('flaky', 1_000, () => {
      if (n++ === 0) throw new Error('first round fails');
    });
    const errors = console.error;
    console.error = () => {};
    try {
      await jobs.runNow('flaky');
      assert.equal(jobs.stats()[0]!.lastFailed, true);
      await jobs.runNow('flaky');
    } finally {
      console.error = errors;
    }
    const [s] = jobs.stats();
    assert.equal(s!.lastFailed, false);
    assert.equal(s!.failures, 1);
    assert.equal(s!.lastError, 'first round fails', 'the last error stays readable after the job recovers');
  });

  it('waits the delay a job returns instead of its interval', async () => {
    const clock = fakeClock();
    const jobs = new Scheduler(clock);
    const at: number[] = [];
    jobs.every('crawl', 45_000, () => {
      at.push(clock.now());
      return at.length === 1 ? 3_600_000 : undefined;
    });
    jobs.start();
    await clock.advance(0);
    await clock.advance(3_600_000);
    await clock.advance(45_000);
    assert.deepEqual(
      at.map((t) => t - at[0]!),
      [0, 3_600_000, 3_645_000],
    );
  });

  it('never runs a job twice at once', async () => {
    const clock = fakeClock();
    const jobs = new Scheduler(clock);
    let started = 0;
    let finish!: () => void;
    jobs.every('slow', 1_000, () => {
      started++;
      return new Promise<void>((r) => (finish = r));
    });
    const first = jobs.runNow('slow');
    await jobs.runNow('slow');
    assert.equal(started, 1, 'the second call returned without starting it again');
    assert.equal(jobs.stats()[0]!.running, true);
    finish();
    await first;
    assert.equal(jobs.stats()[0]!.running, false);
    assert.equal(jobs.stats()[0]!.runs, 1);
  });

  it('stops every timer and plans a job added after the start', async () => {
    const clock = fakeClock();
    const jobs = new Scheduler(clock);
    let a = 0;
    let b = 0;
    jobs.every('a', 1_000, () => void a++);
    jobs.start();
    jobs.every('b', 1_000, () => void b++, { firstMs: 500 });
    await clock.advance(1_000);
    assert.equal(a, 2, 'at the start and a second later');
    assert.equal(b, 1);
    jobs.stop();
    assert.equal(clock.pending(), 0);
    assert.ok(jobs.stats().every((s) => s.nextAt === null));
    await clock.advance(10_000);
    assert.equal(a, 2);
    assert.throws(() => jobs.every('a', 1_000, () => {}), /already exists/);
    await assert.rejects(jobs.runNow('nope'), /No job called nope/);
  });
});
