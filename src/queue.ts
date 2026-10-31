/**
 * A small first-in-first-out queue for the slow jobs that all land on the same CPU model: answering a question with the
 * model, and reading a screenshot. Only `concurrency` jobs run at once (default 1); the rest wait in order, are told their
 * position as it changes, and get a turn when the ones in front finish. Nothing is stored: it is in memory, like the jobs.
 *
 *   const ticket = queue.join(userId, (position) => tellThem(position));
 *   await ticket.ready;          // resolves at once when there is room
 *   try { ...work... } finally { ticket.release(); }
 *
 * A ticket can be released at any time: while waiting it leaves the line, while running it frees its place. A running job that
 * never releases (a hung request) is released after `maxHoldMs`, so one stuck job can't block everybody behind it.
 */

export class QueueFullError extends Error {
  constructor(
    /** user: this person already has the most jobs allowed in the queue; full: too many are waiting overall. */
    readonly reason: 'user' | 'full',
  ) {
    super(reason === 'user' ? 'You already have the most requests allowed waiting in the queue.' : 'The queue is full right now.');
    this.name = 'QueueFullError';
  }
}

export interface QueueLimits {
  /** Jobs running at the same time. */
  concurrency: number;
  /** Jobs allowed to wait. */
  maxWaiting: number;
  /** Jobs one person may have running or waiting. */
  perKey: number;
  /** A running job is released after this long even if it never says it is done. */
  maxHoldMs: number;
}

export interface Ticket {
  /** 0 when the job is running (or was started at once), 1 for the next in line, 2 after that... */
  position(): number;
  /** Resolves when it is this job's turn. */
  ready: Promise<void>;
  /** Gives the place back (or leaves the line). Safe to call more than once. */
  release(): void;
}

interface Entry {
  key: string;
  onPosition: ((position: number) => void) | undefined;
  position: number;
  state: 'waiting' | 'running' | 'done';
  start: () => void;
  timer: NodeJS.Timeout | null;
}

export class WorkQueue {
  private readonly running = new Set<Entry>();
  private waiting: Entry[] = [];
  private limits: QueueLimits;
  /** Counters since the start, for the panel. */
  readonly stats = { served: 0, waitedOnce: 0, refused: 0 };

  constructor(
    readonly name: string,
    limits: Partial<QueueLimits> = {},
  ) {
    this.limits = { concurrency: 1, maxWaiting: 20, perKey: 2, maxHoldMs: 6 * 60_000, ...limits };
  }

  configure(limits: Partial<QueueLimits>): void {
    this.limits = { ...this.limits, ...limits };
    this.pump();
  }

  get config(): Readonly<QueueLimits> {
    return this.limits;
  }

  snapshot(): { running: number; waiting: number } {
    return { running: this.running.size, waiting: this.waiting.length };
  }

  /** Takes a place in line. Throws `QueueFullError` when this person or the queue has too many already. */
  join(key: string, onPosition?: (position: number) => void): Ticket {
    const mine = [...this.running, ...this.waiting].filter((e) => e.key === key).length;
    if (key && mine >= this.limits.perKey) {
      this.stats.refused++;
      throw new QueueFullError('user');
    }
    if (this.waiting.length >= this.limits.maxWaiting) {
      this.stats.refused++;
      throw new QueueFullError('full');
    }
    let resolve!: () => void;
    const ready = new Promise<void>((r) => (resolve = r));
    const entry: Entry = { key, onPosition, position: 0, state: 'waiting', start: resolve, timer: null };
    if (this.running.size < this.limits.concurrency && this.waiting.length === 0) this.begin(entry);
    else {
      this.waiting.push(entry);
      entry.position = this.waiting.length;
      this.stats.waitedOnce++;
    }
    return { position: () => (entry.state === 'waiting' ? entry.position : 0), ready, release: () => this.release(entry) };
  }

  private begin(entry: Entry): void {
    entry.state = 'running';
    entry.position = 0;
    this.running.add(entry);
    this.stats.served++;
    entry.timer = setTimeout(() => this.release(entry), this.limits.maxHoldMs);
    entry.timer.unref();
    entry.start();
  }

  private release(entry: Entry): void {
    if (entry.state === 'done') return;
    if (entry.state === 'waiting') this.waiting = this.waiting.filter((e) => e !== entry);
    else this.running.delete(entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.state = 'done';
    this.pump();
  }

  /** Starts whoever is next while there is room, then tells the ones still waiting where they stand now. */
  private pump(): void {
    while (this.running.size < this.limits.concurrency && this.waiting.length) this.begin(this.waiting.shift()!);
    this.waiting.forEach((e, i) => {
      if (e.position === i + 1) return;
      e.position = i + 1;
      try {
        e.onPosition?.(e.position);
      } catch {
        // A broken listener must never stop the queue.
      }
    });
  }
}

/** The screenshot reads (screenshot roles and riven scans) wait here. Limits come from the config (see index.ts). */
export const screenshotQueue = new WorkQueue('screenshots');
