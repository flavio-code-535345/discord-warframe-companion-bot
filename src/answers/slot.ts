import { AsyncLocalStorage } from 'node:async_hooks';
import { questionQueue } from '../queue.js';
import { reportQueue } from './status.js';

/**
 * Answers that use the model wait their turn in the question queue (see queue.ts), so a busy CPU model works on one question at
 * a time instead of slowing every question down. Only the model steps queue: price, drop, world state and clan lookups are plain API
 * calls and are never held up. The asker is carried by the call chain, like the status listener, so no function in between has to
 * pass it along.
 */
const askers = new AsyncLocalStorage<string>();

export const withAsker = <T>(userId: string, fn: () => Promise<T>): Promise<T> => askers.run(userId, fn);

/**
 * Runs `fn` when it is this answer's turn. While it waits, the listener of the answer hears its position (`reportQueue`), and
 * when the turn comes it hears 0, so the notice switches to the normal "thinking" message. Throws `QueueFullError` when this
 * person already has the most allowed waiting or the queue is full.
 */
export async function withModelSlot<T>(fn: () => Promise<T>): Promise<T> {
  const ticket = questionQueue.join(askers.getStore() ?? '', reportQueue);
  const waited = ticket.position() > 0;
  if (waited) reportQueue(ticket.position());
  try {
    await ticket.ready;
    if (waited) reportQueue(0);
    return await fn();
  } finally {
    ticket.release();
  }
}
