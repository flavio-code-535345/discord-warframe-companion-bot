import { AttachmentBuilder, type EmbedBuilder } from 'discord.js';
import { rivenCompactEmbed } from '../discord/riven-embeds.js';
import { compareRivens } from './compare.js';
import { rivenPicture } from './picture.js';
import type { ScanResult } from './scan.js';

/**
 * What the bot answers for a scanned riven: the picture with every stat graded next to the card; when there is nothing to draw (the card
 * could not be read, nothing to compare with) or drawing fails, the short text card says why. Never throws. `label` ("#1") marks the
 * picture when several rivens are answered together.
 */
export async function rivenReply(result: ScanResult, name = 'riven.png', label?: string): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  try {
    const picture = result.report ? await rivenPicture(result, label ? { label } : {}) : null;
    if (picture) return { embeds: [], files: [new AttachmentBuilder(picture, { name })] };
  } catch (err) {
    console.error('[riven] drawing the picture failed:', err instanceof Error ? err.message : err);
  }
  const embed = rivenCompactEmbed(result);
  if (label) embed.setAuthor({ name: label });
  return { embeds: [embed], files: [] };
}

/**
 * The answer to several screenshots at once: one picture (or text card) each, numbered #1, #2… when there is more than one, and when they
 * are all graded rivens of one weapon, which of them to keep (the reroll question) as the message text.
 */
export async function rivenReplies(results: ScanResult[]): Promise<{ content: string; embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  const many = results.length > 1;
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];
  for (const [i, result] of results.entries()) {
    const part = await rivenReply(result, `riven-${i + 1}.png`, many ? `#${i + 1}` : undefined);
    embeds.push(...part.embeds);
    files.push(...part.files);
  }
  return { content: (many && compareRivens(results)) || '', embeds, files };
}
