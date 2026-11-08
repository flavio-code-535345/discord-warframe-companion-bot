import type { GuildSettings } from '../../db.js';
import type { ArbitrationData, ArbitrationView } from '../../warframe/arbitrations.js';
import type { WorldState } from '../../warframe/worldstate.js';

/** The World State channels, one board each. */
export const FEED_IDS = ['alerts', 'arbitrations', 'fissures', 'sortie', 'cycles', 'traders', 'invasions'] as const;
export type FeedId = (typeof FEED_IDS)[number];

/** What every board is drawn from: one snapshot per round, so all boards agree with each other. */
export interface FeedInput {
  now: number;
  /** Null when the world state is switched off or has never been read. */
  ws: WorldState | null;
  /** Now, the next 48 hours and the week's S, A and B tier hours (see warframe/arbitrations.ts). */
  arby: ArbitrationView;
  arbyData: ArbitrationData | null;
  /** True when the world state source is lagging or not answering: the boards say so, without minutes, so the text stays the same. */
  stale: boolean;
  settings: GuildSettings;
  /** The roles of the self-assign menu: a board offers a role button only for one of these (the button runs the same toggle). */
  selfRoles: ReadonlySet<string>;
}

/** Something new that the feed's role is pinged for: `key` is remembered (once ever), the note stays until `until`. */
export interface FeedPing {
  key: string;
  text: string;
  until: number;
}

/** The line every board ends with when its data may be old. */
export const STALE_NOTE = '⚠️ Live data may be outdated: the world state source is lagging or not answering.';
