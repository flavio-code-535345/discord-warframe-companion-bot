import type { AlecaLink } from '../db.js';
import { withTimeout } from '../timeout.js';
import { type OwnedRelic, fetchRelics, shares } from './api.js';

/** Whether a member's relics can be read: `ok`, or why not (no link, a link that does not share them, AlecaFrame not answering). */
export type RelicAccess = 'ok' | 'unlinked' | 'unshared' | 'unreadable';

/** A link that shares the member's relics. A link from before AlecaFrame said what it shares (`parts` 0) is tried. */
export const sharesRelics = (link: Pick<AlecaLink, 'parts'>): boolean => link.parts === 0 || shares(link.parts, 'relics');

/**
 * A member's relics through their AlecaFrame link, for the features that only add them when they can be had (the wishlist, the `/now`
 * card, "crack now"). Never throws: `owned` is null with the reason in `access`. `waitMs` bounds the wait, for an answer that has to
 * be given within Discord's three seconds; the read itself goes on and is in memory for the next ten minutes.
 */
export async function relicsOf(store: { getAlecaLink(userId: string): AlecaLink | null }, userId: string, opts: { waitMs?: number } = {}): Promise<{ access: RelicAccess; owned: OwnedRelic[] | null }> {
  const link = store.getAlecaLink(userId);
  if (!link) return { access: 'unlinked', owned: null };
  if (!sharesRelics(link)) return { access: 'unshared', owned: null };
  try {
    const read = fetchRelics(link.token);
    return { access: 'ok', owned: await (opts.waitMs ? withTimeout(read, opts.waitMs, () => new Error('AlecaFrame is slow')) : read) };
  } catch {
    return { access: 'unreadable', owned: null };
  }
}
