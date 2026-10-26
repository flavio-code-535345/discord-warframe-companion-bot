/**
 * "Ordis is thinking" notice for slow answers. Discord's typing indicator alone looks like nothing is happening when a model
 * takes 30+ seconds, so after a short delay a message appears with a progress bar, the time spent and what Ordis is doing right
 * now, and is edited every few seconds. Quick answers never show it.
 */

export interface Notice {
  edit(payload: { content: string; [key: string]: unknown }): Promise<unknown>;
  delete(): Promise<unknown>;
}

export interface Progress {
  /** What Ordis is doing right now (shown in the notice). */
  set(status: string): void;
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

export function startProgress(post: (text: string) => Promise<Notice | null | undefined>, opts: { delayMs?: number; everyMs?: number } = {}): Progress {
  const delayMs = opts.delayMs ?? 2500;
  const everyMs = opts.everyMs ?? 4000;
  const started = Date.now();
  let status = '';
  let notice: Notice | null = null;
  let finished = false;
  let posting: Promise<void> | null = null;
  let interval: NodeJS.Timeout | null = null;

  const show = async () => {
    if (finished) return;
    try {
      if (!notice) notice = (await post(renderNotice(Date.now() - started, status))) ?? null;
      else await notice.edit({ content: renderNotice(Date.now() - started, status) });
    } catch {
      // The notice is a courtesy: a failed edit must never stop the answer.
    }
  };
  const first = setTimeout(() => {
    posting = show().then(() => {
      if (!finished) {
        interval = setInterval(() => void show(), everyMs);
        interval.unref();
      }
    });
  }, delayMs);
  first.unref();

  const stop = async () => {
    finished = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
    await posting;
  };

  return {
    set: (s) => {
      status = s;
    },
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
