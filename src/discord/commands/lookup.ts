import { SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../services/clan.js';
import { type DropLocation, searchDrops } from '../../warframe/drops.js';
import { lookupItem, suggestItems } from '../../warframe/items.js';
import { searchWiki } from '../../warframe/wiki.js';
import type { Command } from '../command.js';
import { lookupEmbed, showsDrops, wikiEmbed } from '../lookup-embeds.js';

export const item: Command = {
  data: new SlashCommandBuilder()
    .setName('item')
    .setDescription('Stats for a Warframe, weapon, mod, arcane or relic')
    .addStringOption((o) => o.setName('name').setDescription('e.g. "Wisp Prime", "Kuva Bramma", "Neo N16"').setRequired(true).setAutocomplete(true))
    .toJSON(),

  async execute(interaction) {
    const name = interaction.options.getString('name', true);
    await interaction.deferReply();
    const result = await lookupItem(name);
    if (!result) throw new UserError(`Ordis found nothing called "${name}".`);
    let drops: DropLocation[] | undefined;
    if (showsDrops(result) && result.kind === 'item') {
      // The drop-table search is more complete than the item record's own list (e.g. Duviri rewards).
      const groups = await searchDrops(result.item.name, 6, 10).catch(() => []);
      drops = groups.find((g) => g.item.toLowerCase() === result.item.name.toLowerCase())?.locations;
    }
    await interaction.editReply({ embeds: [lookupEmbed(result, drops)] });
  },

  async autocomplete(interaction) {
    const names = await suggestItems(interaction.options.getFocused());
    await interaction.respond(names.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  },
};

export const wiki: Command = {
  data: new SlashCommandBuilder()
    .setName('wiki')
    .setDescription('Search the Warframe wiki')
    .addStringOption((o) => o.setName('query').setDescription('e.g. "Archon Shard", "Helminth"').setRequired(true).setMaxLength(200))
    .toJSON(),

  async execute(interaction) {
    const query = interaction.options.getString('query', true);
    await interaction.deferReply();
    await interaction.editReply({ embeds: [wikiEmbed(query, await searchWiki(query))] });
  },
};
