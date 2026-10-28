/**
 * Rejects with `onTimeout()` when `work` has not settled within `ms`. The timer is cleared as soon as `work` settles, so nothing stays
 * pending after the work is done. The work itself is not cancelled; its late result is simply ignored.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref();
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}
