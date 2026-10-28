/**
 * The bot's look in Discord, in one place: the colours, one emoji per kind of information, and the footer every public embed ends with
 * (what the data came from, then the bot's name and avatar). Embeds are built by pure functions that don't know the bot's context, so
 * the name and avatar are set once when the bot is ready (see identity.ts) and read from here.
 */

export const COLORS = {
  /** Crystal blue sampled from the clan logo's glow. */
  brand: 0x3b9ac7,
  info: 0x3b82f6,
  success: 0x22c55e,
  warn: 0xf59e0b,
  danger: 0xef4444,
  void: 0xc9a227,
  /** Cancelled, closed or otherwise finished. */
  muted: 0x6b7280,
} as const;

/** One emoji per kind of information, so the same thing looks the same in a command, in the alerts summary and in chat answers. */
export const ICON = {
  cycles: '🌍',
  fissures: '🌀',
  sortie: '⚔️',
  archon: '🗡️',
  baro: '👑',
  steelPath: '🔱',
  invasions: '🎯',
  alerts: '⚠️',
  nightwave: '🌙',
  deal: '🛒',
  events: '🎉',
  archimedea: '🧩',
  bounties: '🤝',
  resurgence: '♻️',
  price: '💰',
  drops: '📦',
  relic: '🔮',
  wiki: '📖',
  riven: '🎲',
} as const;

export type IconName = keyof typeof ICON;

/** "🌀 Void fissures (12)": the title of an embed. */
export const heading = (icon: IconName, text: string): string => `${ICON[icon]} ${text}`;

let brand: { name: string; icon: string | undefined } = { name: 'Cephalon Ordis', icon: undefined };

/** Called when the bot is ready (and when its name changes). */
export function setBrand(next: { name: string; icon?: string | undefined }): void {
  brand = { name: next.name, icon: next.icon };
}

/** The footer of a public embed: where the data came from (optional), then the bot's name with its avatar. */
export function footer(source?: string | null): { text: string; iconURL?: string } {
  const text = [source, brand.name].filter(Boolean).join(' · ');
  return brand.icon ? { text, iconURL: brand.icon } : { text };
}
