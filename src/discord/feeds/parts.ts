import {
  type ActionRowBuilder,
  ContainerBuilder,
  type MessageActionRowComponentBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from 'discord.js';

/**
 * The building blocks of the World State boards (Components V2). A card is one container with an accent colour: text, separators, a
 * text with a thumbnail, and rows of buttons or menus. Discord allows 4000 characters of text and 40 components in one message, so
 * `card` keeps the text inside a budget: a block that doesn't fit is cut at a line ("…and 3 more"), later ones are left out. A busy
 * world state makes a board shorter, never an edit Discord refuses.
 */

export type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
interface Separator {
  separator: true;
  divider: boolean;
  large: boolean;
}
interface Section {
  section: true;
  text: string;
  thumb: string | null;
}
export type Part = string | Separator | Section | Row | null | undefined | false;

/** A line across the card. */
export const DIVIDER: Separator = { separator: true, divider: true, large: false };
/** Space without a line. */
export const GAP: Separator = { separator: true, divider: false, large: false };

/** Text with a small picture on its right (an emoji's image); just the text when there is no picture. */
export const section = (text: string, thumb: string | null): Section => ({ section: true, text, thumb });

/** The text one card may hold; Discord's limit is 4000 for the whole message. */
export const CARD_TEXT_BUDGET = 3900;

/** Cuts `text` at a line so it fits `limit`, saying how many lines were left out. Null when nothing fits or there is nothing. */
export function fit(text: string, limit: number): string | null {
  if (!text || limit <= 0) return null;
  if (text.length <= limit) return text;
  const lines = text.split('\n');
  let out = '';
  for (const [i, line] of lines.entries()) {
    const more = `\n-# …and ${lines.length - i} more`;
    if (out.length + line.length + 1 + more.length > limit) return out ? out + more : `${line.slice(0, Math.max(0, limit - 1))}…`;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

const text = (content: string) => new TextDisplayBuilder().setContent(content);

/** One card. Falsy parts are skipped, separators never start or end a card and never come twice in a row. */
export function card(accent: number, parts: Part[], budget = CARD_TEXT_BUDGET): ContainerBuilder {
  const c = new ContainerBuilder().setAccentColor(accent);
  let left = budget;
  let filled = false;
  let pending: Separator | null = null;
  const flush = () => {
    if (pending && filled) c.addSeparatorComponents(new SeparatorBuilder().setDivider(pending.divider).setSpacing(pending.large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small));
    pending = null;
    filled = true;
  };
  for (const p of parts) {
    if (!p) continue;
    if (typeof p === 'string' || 'section' in p) {
      const content = fit(typeof p === 'string' ? p : p.text, left);
      if (!content) continue;
      flush();
      left -= content.length;
      if (typeof p !== 'string' && p.thumb) c.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(content)).setThumbnailAccessory(new ThumbnailBuilder().setURL(p.thumb)));
      else c.addTextDisplayComponents(text(content));
    } else if ('separator' in p) {
      if (filled) pending = pending ? { separator: true, divider: pending.divider || p.divider, large: pending.large || p.large } : p;
    } else {
      flush();
      c.addActionRowComponents(p);
    }
  }
  if (!filled) c.addTextDisplayComponents(text('-# Nothing to show right now.'));
  return c;
}

/** How much text and how many components a message holds (Discord: at most 4000 and 40), for the tests and the health report. */
export function messageStats(components: { toJSON(): unknown }[]): { text: number; components: number } {
  let chars = 0;
  let count = 0;
  const walk = (c: Record<string, unknown>) => {
    count++;
    if (typeof c.content === 'string') chars += c.content.length;
    for (const child of (c.components as Record<string, unknown>[] | undefined) ?? []) walk(child);
    if (c.accessory) walk(c.accessory as Record<string, unknown>);
  };
  for (const c of components) walk(c.toJSON() as Record<string, unknown>);
  return { text: chars, components: count };
}

/** "Hydron (Sedna)" → "Sedna". */
export const planetOf = (node: string): string | null => /\(([^)]+)\)\s*$/.exec(node)?.[1] ?? null;

/** "Hydron (Sedna)" → "Hydron". */
export const nodeName = (node: string): string => node.replace(/\s*\([^)]*\)\s*$/, '');

/** A 10-step bar for a share from 0 to 100. */
export function bar(percent: number, steps = 10): string {
  const filled = Math.max(0, Math.min(steps, Math.round((percent / 100) * steps)));
  return '▰'.repeat(filled) + '▱'.repeat(steps - filled);
}

export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "1,234" */
export const num = (n: number | string | null | undefined): string => Number(n ?? 0).toLocaleString('en-US');

/** "250k", "1.25M": credit prices in a dense list. */
export function compact(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1e6) return `${Number((v / 1e6).toFixed(2))}M`;
  if (v >= 1e3) return `${Number((v / 1e3).toFixed(1))}k`;
  return String(v);
}
