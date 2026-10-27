import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder, type SlashCommandStringOption } from 'discord.js';
import type { AppContext } from '../../context.js';
import { QueueFullError, screenshotQueue } from '../../queue.js';
import { recordResult } from '../../rivens/channel.js';
import { getRivenWeapons } from '../../rivens/market.js';
import { scanCard } from '../../rivens/scan.js';
import { gradeFor, rivenStatus, topFor } from '../../rivens/service.js';
import { UserError } from '../../services/clan.js';
import { searchItems } from '../../warframe/market.js';
import type { Command } from '../command.js';
import { rivenCompactEmbed, rivenGradeEmbed, rivenStatusEmbed, rivenTopEmbed } from '../riven-embeds.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SCAN_LIMIT_MS = 90_000;

/**
 * Riven analyzer. Grades a riven by how common its rolls are among the expensive listings on warframe.market, and shows what sells
 * for a weapon. The listings come from the slow background read (rivens/crawler.ts) or one fresh read when nothing recent is stored.
 */
const weaponOption = (o: SlashCommandStringOption) => o.setName('weapon').setDescription('The weapon').setRequired(true).setAutocomplete(true);

/** Reads a riven from a screenshot: waits its turn in the screenshot queue (a slow reader works on one at a time), then OCRs and grades. */
async function scan(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const image = interaction.options.getAttachment('image', true);
  const mime = (image.contentType ?? '').split(';')[0]!.trim();
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') throw new UserError('Attach a PNG, JPG or WebP screenshot (other formats cannot be read).');
  if (image.size > MAX_IMAGE_BYTES) throw new UserError('That picture is over 8 MB. Crop it to the riven card and try again.');

  const queueText = (n: number) => `⏳ **Ordis is reading other screenshots.** ${n <= 1 ? "You're **next in line**" : `You're **#${n}** in the queue`}.`;
  let ready = false;
  const edit = (content: string) => void interaction.editReply({ content, embeds: [] }).catch(() => {});
  let ticket: ReturnType<typeof screenshotQueue.join>;
  try {
    ticket = screenshotQueue.join(interaction.user.id, (n) => {
      if (n > 0 && !ready) edit(queueText(n));
    });
  } catch (err) {
    if (!(err instanceof QueueFullError)) throw err;
    throw new UserError(err.reason === 'user' ? 'Two of your screenshots are already waiting. Wait for those first.' : 'Too many screenshots are waiting right now. Try again in a few minutes.');
  }
  try {
    edit(ticket.position() > 0 ? queueText(ticket.position()) : '🔎 Reading your riven…');
    const download = fetch(image.url, { signal: AbortSignal.timeout(15_000) }).then(async (res) => {
      if (!res.ok) throw new UserError("I couldn't download that image.");
      return new Uint8Array(await res.arrayBuffer());
    });
    download.catch(() => {});
    await ticket.ready;
    ready = true;
    edit('🔎 Reading your riven…');
    const result = await Promise.race([
      download.then((bytes) => scanCard(ctx, bytes, mime)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new UserError('That took too long, so I gave up. Try again in a minute.')), SCAN_LIMIT_MS).unref()),
    ]);
    recordResult('command', interaction.user.username, result);
    await interaction.editReply({ content: '', embeds: [rivenCompactEmbed(result)] });
  } catch (err) {
    // Replace the "Reading your riven…" placeholder with the problem, otherwise it stays on screen as if still working.
    if (!(err instanceof UserError)) console.error('[riven] /riven scan failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    await interaction.editReply({ content: `❌ ${err instanceof UserError ? err.message : 'Something went wrong reading that. Try again in a minute.'}`, embeds: [] }).catch(() => {});
  } finally {
    ticket.release();
  }
}

export const riven: Command = {
  data: new SlashCommandBuilder()
    .setName('riven')
    .setDescription('Grade a riven by what sells on warframe.market')
    .addSubcommand((s) =>
      s
        .setName('grade')
        .setDescription('Grade a riven roll and see what similar ones are listed for')
        .addStringOption(weaponOption)
        .addStringOption((o) => o.setName('bonuses').setDescription('The 2 or 3 bonus stats, e.g. "cc cd ms" or "Critical Chance 180, Multishot 120"').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('curse').setDescription('The curse, if any, e.g. zoom').setMaxLength(60)),
    )
    .addSubcommand((s) =>
      s
        .setName('scan')
        .setDescription('Grade a riven from a screenshot of its card')
        .addAttachmentOption((o) => o.setName('image').setDescription('A PNG, JPG or WebP of the unveiled riven card (cropped to the card works best)').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('top').setDescription('Which rolls the expensive rivens of a weapon have').addStringOption(weaponOption))
    .addSubcommand((s) => s.setName('status').setDescription('How much riven data the bot has gathered'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply(sub === 'status' ? { flags: MessageFlags.Ephemeral } : {});
    if (sub === 'status') {
      await interaction.editReply({ embeds: [rivenStatusEmbed(await rivenStatus(ctx))] });
    } else if (sub === 'scan') {
      await scan(interaction, ctx);
    } else if (sub === 'top') {
      await interaction.editReply({ embeds: [rivenTopEmbed(await topFor(ctx, interaction.options.getString('weapon', true)))] });
    } else {
      const report = await gradeFor(ctx, {
        weapon: interaction.options.getString('weapon', true),
        positives: interaction.options.getString('bonuses', true),
        negative: interaction.options.getString('curse') ?? undefined,
      });
      await interaction.editReply({ embeds: [rivenGradeEmbed(report)] });
    }
  },

  async autocomplete(interaction) {
    const weapons = await getRivenWeapons();
    const matches = searchItems(weapons, interaction.options.getFocused());
    await interaction.respond(matches.map((w) => ({ name: w.name.slice(0, 100), value: w.slug })));
  },
};
