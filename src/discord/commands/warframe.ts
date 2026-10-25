import { SlashCommandBuilder } from 'discord.js';
import { searchDrops } from '../../warframe/drops.js';
import { getItemIndex, priceCheck, searchItems } from '../../warframe/market.js';
import { FISSURE_TIERS, filterFissures, getWorldState } from '../../warframe/worldstate.js';
import type { Command } from '../command.js';
import {
  BOUNTY_SYNDICATES,
  archimedeaEmbed,
  archonEmbed,
  baroEmbed,
  bountiesEmbed,
  cyclesEmbed,
  dealsEmbed,
  dropsEmbed,
  eventsEmbed,
  resurgenceEmbed,
  fissuresEmbed,
  invasionsEmbed,
  nightwaveEmbed,
  priceEmbed,
  sortieEmbed,
  steelPathEmbed,
} from '../embeds.js';

export const wf: Command = {
  data: new SlashCommandBuilder()
    .setName('wf')
    .setDescription('Live Warframe world state')
    .addSubcommand((s) => s.setName('cycles').setDescription('Cetus, Vallis, Cambion, Zariman, Earth and Duviri cycles'))
    .addSubcommand((s) =>
      s
        .setName('fissures')
        .setDescription('Active Void fissures')
        .addStringOption((o) =>
          o.setName('tier').setDescription('Relic tier').addChoices(...FISSURE_TIERS.map((t) => ({ name: t, value: t }))),
        )
        .addBooleanOption((o) => o.setName('steel_path').setDescription('Only Steel Path (true) or only normal (false)'))
        .addBooleanOption((o) => o.setName('storm').setDescription('Only Void Storms (true) or exclude them (false)')),
    )
    .addSubcommand((s) => s.setName('sortie').setDescription("Today's sortie"))
    .addSubcommand((s) => s.setName('archon').setDescription("This week's Archon Hunt"))
    .addSubcommand((s) => s.setName('baro').setDescription("Baro Ki'Teer's arrival or current inventory"))
    .addSubcommand((s) => s.setName('steelpath').setDescription("Teshin's weekly Steel Path reward"))
    .addSubcommand((s) => s.setName('invasions').setDescription('Active invasions and their rewards'))
    .addSubcommand((s) => s.setName('nightwave').setDescription('Current Nightwave challenges'))
    .addSubcommand((s) => s.setName('deals').setDescription("Darvo's daily deal"))
    .addSubcommand((s) => s.setName('events').setDescription('Running in-game events and their rewards'))
    .addSubcommand((s) => s.setName('archimedea').setDescription('Deep and Temporal Archimedea missions, deviations and risks'))
    .addSubcommand((s) =>
      s
        .setName('bounties')
        .setDescription('Syndicate bounties with level ranges, standing and reward pools')
        .addStringOption((o) =>
          o
            .setName('syndicate')
            .setDescription('Syndicate')
            .setRequired(true)
            .addChoices(...BOUNTY_SYNDICATES.map((s) => ({ name: s, value: s }))),
        ),
    )
    .addSubcommand((s) => s.setName('resurgence').setDescription("Varzia's Prime Resurgence stock"))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const ws = await getWorldState();
    const sub = interaction.options.getSubcommand();
    const embed = (() => {
      switch (sub) {
        case 'cycles':
          return cyclesEmbed(ws);
        case 'fissures':
          return fissuresEmbed(
            filterFissures(ws.fissures, {
              tier: interaction.options.getString('tier') ?? undefined,
              steelPath: interaction.options.getBoolean('steel_path') ?? undefined,
              storm: interaction.options.getBoolean('storm') ?? undefined,
            }),
          );
        case 'sortie':
          return sortieEmbed(ws);
        case 'archon':
          return archonEmbed(ws);
        case 'baro':
          return baroEmbed(ws);
        case 'steelpath':
          return steelPathEmbed(ws);
        case 'invasions':
          return invasionsEmbed(ws);
        case 'nightwave':
          return nightwaveEmbed(ws);
        case 'deals':
          return dealsEmbed(ws);
        case 'events':
          return eventsEmbed(ws);
        case 'archimedea':
          return archimedeaEmbed(ws);
        case 'bounties':
          return bountiesEmbed(ws, interaction.options.getString('syndicate', true));
        case 'resurgence':
          return resurgenceEmbed(ws);
        default:
          throw new Error(`Unknown subcommand ${sub}`);
      }
    })();
    await interaction.editReply({ embeds: [embed] });
  },
};

export const price: Command = {
  data: new SlashCommandBuilder()
    .setName('price')
    .setDescription('Check warframe.market prices for an item')
    .addStringOption((o) => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
    .toJSON(),

  async execute(interaction, ctx) {
    await interaction.deferReply();
    const result = await priceCheck(interaction.options.getString('item', true), ctx.config.WARFRAME_PLATFORM);
    await interaction.editReply({ embeds: [priceEmbed(result)] });
  },

  async autocomplete(interaction) {
    const items = await getItemIndex();
    const matches = searchItems(items, interaction.options.getFocused());
    await interaction.respond(matches.map((m) => ({ name: m.name.slice(0, 100), value: m.slug })));
  },
};

export const drops: Command = {
  data: new SlashCommandBuilder()
    .setName('drops')
    .setDescription('Find where an item, mod or relic drops')
    .addStringOption((o) => o.setName('item').setDescription('Item name, e.g. "Neo N16" or "Condition Overload"').setRequired(true))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('item', true);
    await interaction.editReply({ embeds: [dropsEmbed(query, await searchDrops(query))] });
  },
};
