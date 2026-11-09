import { SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../services/clan.js';
import { REFINEMENTS, type Refinement, type Squad, type VaultFilter, bestRelics, loadRelicBook } from '../../warframe/relics.js';
import type { Command } from '../command.js';
import { bestRelicsEmbed } from '../lookup-embeds.js';

/** /relics: the relics worth the most plat to open, valued with WFInfo's prices (relics.ts), no warframe.market request per relic. */
export const relics: Command = {
  data: new SlashCommandBuilder()
    .setName('relics')
    .setDescription('The relics worth the most platinum to open')
    .addStringOption((o) =>
      o
        .setName('refinement')
        .setDescription('Default: Radiant')
        .addChoices(...REFINEMENTS.map((r) => ({ name: r, value: r }))),
    )
    .addStringOption((o) =>
      o
        .setName('squad')
        .setDescription('Default: a radshare')
        .addChoices({ name: 'Radshare (four of the same relic)', value: 'radshare' }, { name: 'Alone', value: 'solo' }),
    )
    .addStringOption((o) =>
      o
        .setName('vaulted')
        .setDescription('Default: only relics that drop now')
        .addChoices({ name: 'Leave out vaulted relics', value: 'exclude' }, { name: 'Include vaulted relics', value: 'include' }, { name: 'Only vaulted relics', value: 'only' }),
    )
    .addStringOption((o) =>
      o
        .setName('tier')
        .setDescription('Only one tier')
        .addChoices(...['Lith', 'Meso', 'Neo', 'Axi'].map((t) => ({ name: t, value: t }))),
    )
    .toJSON(),

  async execute(interaction) {
    const refinement = (interaction.options.getString('refinement') ?? 'Radiant') as Refinement;
    const squad = (interaction.options.getString('squad') ?? 'radshare') as Squad;
    const vaulted = (interaction.options.getString('vaulted') ?? 'exclude') as VaultFilter;
    const tier = interaction.options.getString('tier');
    await interaction.deferReply();
    const book = await loadRelicBook().catch(() => {
      throw new UserError('The relic price list could not be read right now. Try again later.');
    });
    const list = bestRelics(book, { refinement, squad, vaulted, tier, limit: 10 });
    await interaction.editReply({ embeds: [bestRelicsEmbed(list, { refinement, squad, vaulted, tier }, book)] });
  },
};
