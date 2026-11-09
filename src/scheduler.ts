/**
 * Every recurring background job in one place. A job has a name, an interval and a first delay; it never runs twice at once
 * (a slow round just delays the next), a failure is logged and counted but never stops the job or any other, and it may return
 * the delay until its next round (the riven crawler rests after failures). The numbers behind `stats()` are what the MCP health
 * check and the admin panel show, so a stuck or failing job is visible without reading the container log.
 */

export interface JobStats {
  name: string;
  everyMs: number;
  runs: number;
  failures: number;
  running: boolean;
  lastStartAt: number | null;
  lastMs: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** The last round that finished threw (the error stays in `lastError` after the job recovers). */
  lastFailed: boolean;
  nextAt: number | null;
}

/** A job may return the delay until its next round; nothing (or a non-number) means its normal interval. */
export type JobFn = () => Promise<unknown> | unknown;

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // The Discord connection keeps the process alive; a pending job alone must not (tests, shutdown).
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface Job {
  name: string;
  everyMs: number;
  firstMs: number;
  fn: JobFn;
  handle: unknown;
  stats: JobStats;
}

export class Scheduler {
  private readonly jobs = new Map<string, Job>();
  private started = false;

  constructor(private readonly clock: Clock = realClock) {}

  /** Adds a job; started with the others, or at once when the scheduler already runs. */
  every(name: string, everyMs: number, fn: JobFn, opts: { firstMs?: number } = {}): this {
    if (this.jobs.has(name)) throw new Error(`A job called ${name} already exists.`);
    const job: Job = {
      name,
      everyMs,
      firstMs: opts.firstMs ?? 0,
      fn,
      handle: null,
      stats: { name, everyMs, runs: 0, failures: 0, running: false, lastStartAt: null, lastMs: null, lastError: null, lastErrorAt: null, lastFailed: false, nextAt: null },
    };
    this.jobs.set(name, job);
    if (this.started) this.plan(job, job.firstMs);
    return this;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs.values()) this.plan(job, job.firstMs);
  }

  stop(): void {
    this.started = false;
    for (const job of this.jobs.values()) {
      if (job.handle !== null) this.clock.clearTimeout(job.handle);
      job.handle = null;
      job.stats.nextAt = null;
    }
  }

  /** Runs a job now (outside its timer); resolves when it is done. A job that is already running is not started twice. */
  async runNow(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`No job called ${name}.`);
    await this.run(job);
  }

  stats(): JobStats[] {
    return [...this.jobs.values()].map((j) => ({ ...j.stats }));
  }

  private plan(job: Job, ms: number): void {
    if (job.handle !== null) this.clock.clearTimeout(job.handle);
    const delay = Math.max(0, Math.round(ms));
    job.stats.nextAt = this.clock.now() + delay;
    job.handle = this.clock.setTimeout(() => {
      job.handle = null;
      void this.run(job).then((next) => {
        if (this.started && job.handle === null) this.plan(job, next ?? job.everyMs);
      });
    }, delay);
  }

  /** One round; returns the delay the job asked for, if any. */
  private async run(job: Job): Promise<number | null> {
    if (job.stats.running) return null;
    const s = job.stats;
    s.running = true;
    s.lastStartAt = this.clock.now();
    try {
      const result = await job.fn();
      s.runs++;
      s.lastFailed = false;
      return typeof result === 'number' && Number.isFinite(result) ? Math.max(0, result) : null;
    } catch (err) {
      s.runs++;
      s.failures++;
      s.lastError = err instanceof Error ? err.message : String(err);
      s.lastErrorAt = this.clock.now();
      s.lastFailed = true;
      console.error(`[jobs] ${job.name} failed:`, err);
      return null;
    } finally {
      s.lastMs = this.clock.now() - (s.lastStartAt ?? this.clock.now());
      s.running = false;
    }
  }
}
