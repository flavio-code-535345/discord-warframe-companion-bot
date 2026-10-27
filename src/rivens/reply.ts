import { AttachmentBuilder, type EmbedBuilder } from 'discord.js';
import { rivenCompactEmbed } from '../discord/riven-embeds.js';
import { rivenPicture } from './picture.js';
import type { ScanResult } from './scan.js';

/**
 * What the bot answers for a scanned riven: the picture with every stat graded next to the card; when there is nothing to draw (the card
 * could not be read, nothing to compare with) or drawing fails, the short text card says why. Never throws.
 */
export async function rivenReply(result: ScanResult, name = 'riven.png'): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  try {
    const picture = result.report ? await rivenPicture(result) : null;
    if (picture) return { embeds: [], files: [new AttachmentBuilder(picture, { name })] };
  } catch (err) {
    console.error('[riven] drawing the picture failed:', err instanceof Error ? err.message : err);
  }
  return { embeds: [rivenCompactEmbed(result)], files: [] };
}
