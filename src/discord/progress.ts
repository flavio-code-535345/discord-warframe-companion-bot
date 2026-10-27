/**
 * "Ordis is thinking" notice for slow answers. Discord's typing indicator alone looks like nothing is happening when a model
 * takes 30+ seconds, so after a short delay a message appears with a progress bar, the time spent and what Ordis is doing right
 * now, and is edited every few seconds. Quick answers never show it. When the answer has to wait for the model (see queue.ts) the
 * same message first says where the question is in the line, and turns into the normal "thinking" message when its turn comes.
 */
import type { StatusListener } from '../answers/status.js';

export interface Notice {
  edit(payload: { content: string; [key: string]: unknown }): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface Progress {
  /** What Ordis is doing right now (shown in the notice). */
  set(status: string): void;
  /** Where the answer stands in the line for the model: 1 = next, 2 = after that...; 0 = it is its turn, so show the thinking message. */
  queued(position: number): void;
  /** Passed to smartAnswer: status steps and queue positions in one listener. */
  listener: StatusListener;
  /** Replaces the notice with the final answer. False when no notice was shown (or it could not be edited): send the answer yourself. */
  finish(payload: { content: string; [key: string]: unknown }): Promise<boolean>;
  /** Stops updating the notice and leaves it in place (the caller edits it into the answer itself). */
  stop(): Promise<void>;
  /** Removes the notice (the answer is sent as a new message, or there is none). */
  discard(): Promise<void>;
}

const BAR = 10;
/** The bar fills over about a minute, the time the notice promises. */
const SECONDS_PER_BLOCK = 6;

export function renderNotice(elapsedMs: number, status: string): string {
  const s = Math.round(elapsedMs / 1000);
  const filled = Math.min(BAR, Math.floor(s / SECONDS_PER_BLOCK));
  return `🧠 **Ordis is thinking…** this can take up to a minute.\n\`${'▰'.repeat(filled)}${'▱'.repeat(BAR - filled)}\` ${s} s${status ? ` · ${status}` : ''}\n-# Please don't send the question again.`;
}

export function renderQueued(position: number, waitedMs: number): string {
  const s = Math.round(waitedMs / 1000);
  const place = position <= 1 ? "You're **next in line**" : `You're **#${position}** in the queue`;
  return `⏳ **Ordis is busy with other questions.** ${place}, waiting ${s} s.
-# I'll start on yours as soon as it's your turn. Please don't send the question again.`;
}

export function startProgress(post: (text: string) => Promise<Notice | null | undefined>, opts: { delayMs?: number; everyMs?: number } = {}): Progress {
  const delayMs = opts.delayMs ?? 2500;
  const everyMs = opts.everyMs ?? 4000;
  const started = Date.now();
  let status = '';
  let notice: Notice | null = null;
  let finished = false;
  let begun = false;
  let posting: Promise<void> = Promise.resolve();
  let interval: NodeJS.Timeout | null = null;
  // Waiting in the queue shows the position; once it is the answer's turn the clock for the thinking message starts.
  let position = 0;
  let workStarted = started;

  const render = () => (position > 0 ? renderQueued(position, Date.now() - started) : renderNotice(Date.now() - workStarted, status));
  const show = async () => {
    if (finished) return;
    try {
      if (!notice) notice = (await post(render())) ?? null;
      else await notice.edit({ content: render() });
    } catch {
      // The notice is a courtesy: a failed edit must never stop the answer.
    }
  };
  /** Updates run one after the other, so a queue change can't post a second message while the first is being sent. */
  const refresh = () => {
    posting = posting.then(show);
  };
  const begin = () => {
    if (begun || finished) return;
    begun = true;
    refresh();
    interval = setInterval(refresh, everyMs);
    interval.unref();
  };
  const first = setTimeout(begin, delayMs);
  first.unref();

  const stop = async () => {
    finished = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
    await posting;
  };

  const set = (s: string) => {
    status = s;
  };
  const queued = (p: number) => {
    if (finished) return;
    const wasWaiting = position > 0;
    position = Math.max(0, p);
    if (position > 0) {
      // Waiting: say so at once, not after the usual delay.
      if (!begun) {
        clearTimeout(first);
        begin();
      } else refresh();
    } else if (wasWaiting) {
      // Its turn: from now on the normal thinking message, counted from this moment.
      workStarted = Date.now();
      status = '';
      if (begun) refresh();
    }
  };

  return {
    set,
    queued,
    listener: Object.assign((s: string) => set(s), { queue: queued }),
    stop,
    async finish(payload) {
      await stop();
      if (!notice) return false;
      try {
        await notice.edit(payload);
        return true;
      } catch {
        await notice.delete().catch(() => {});
        return false;
      }
    },
    async discard() {
      await stop();
      await notice?.delete().catch(() => {});
    },
  };
}
