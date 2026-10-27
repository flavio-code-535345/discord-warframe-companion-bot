/** One stat on a riven: the market's slug for the attribute (e.g. critical_chance), its rolled value and whether it is a bonus. */
export interface RivenStat {
  slug: string;
  value: number | null;
  positive: boolean;
}

/** One riven someone is selling on warframe.market. Nothing about the seller is kept. */
export interface RivenListing {
  id: string;
  /** The market's slug for the weapon (e.g. kuva_bramma). */
  weapon: string;
  /** Asking price in platinum: the buyout when there is one, else the starting price. */
  price: number;
  polarity: string;
  rerolls: number;
  stats: RivenStat[];
}

/** When a weapon's listings were last read, and how that went. */
export interface RivenCrawlRow {
  weapon: string;
  /** Last successful read (epoch ms), null when never. */
  fetchedAt: number | null;
  /** Last try, successful or not. */
  attemptedAt: number;
  listings: number;
  error: string | null;
}

export interface RivenWeapon {
  slug: string;
  name: string;
}

export interface RivenAttribute {
  slug: string;
  name: string;
  positiveOnly: boolean;
  negativeOnly: boolean;
}
