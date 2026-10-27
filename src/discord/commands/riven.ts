import { MessageFlags, SlashCommandBuilder, type SlashCommandStringOption } from 'discord.js';
import { getRivenWeapons } from '../../rivens/market.js';
import { gradeFor, rivenStatus, topFor } from '../../rivens/service.js';
import { searchItems } from '../../warframe/market.js';
import type { Command } from '../command.js';
import { rivenGradeEmbed, rivenStatusEmbed, rivenTopEmbed } from '../riven-embeds.js';

/**
 * Riven analyzer. Grades a riven by how common its rolls are among the expensive listings on warframe.market, and shows what sells
 * for a weapon. The listings come from the slow background read (rivens/crawler.ts) or one fresh read when nothing recent is stored.
 */
const weaponOption = (o: SlashCommandStringOption) => o.setName('weapon').setDescription('The weapon').setRequired(true).setAutocomplete(true);

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
    .addSubcommand((s) => s.setName('top').setDescription('Which rolls the expensive rivens of a weapon have').addStringOption(weaponOption))
    .addSubcommand((s) => s.setName('status').setDescription('How much riven data the bot has gathered'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply(sub === 'status' ? { flags: MessageFlags.Ephemeral } : {});
    if (sub === 'status') {
      await interaction.editReply({ embeds: [rivenStatusEmbed(await rivenStatus(ctx))] });
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
