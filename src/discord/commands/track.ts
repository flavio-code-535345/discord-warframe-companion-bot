import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../services/clan.js';
import {
  CYCLE_CHOICES,
  MAX_TRACKERS_PER_USER,
  MISSION_TYPES,
  type TrackerSpec,
  describeTracker,
  parseSpec,
} from '../../trackers.js';
import { FISSURE_TIERS } from '../../warframe/worldstate.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

export const track: Command = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Get a DM from Ordis when something you want shows up')
    .addSubcommand((s) =>
      s
        .setName('reward')
        .setDescription('Invasions, alerts, events, Darvo, Baro, Varzia or Steel Path rewards containing a word')
        .addStringOption((o) => o.setName('keyword').setDescription('e.g. "Orokin Catalyst", "Nitain", "Forma"').setRequired(true).setMinLength(3).setMaxLength(60)),
    )
    .addSubcommand((s) =>
      s
        .setName('fissure')
        .setDescription('Void fissures matching your filters')
        .addStringOption((o) => o.setName('tier').setDescription('Relic tier').addChoices(...FISSURE_TIERS.map((t) => ({ name: t, value: t }))))
        .addStringOption((o) => o.setName('mission').setDescription('Mission type').setAutocomplete(true))
        .addBooleanOption((o) => o.setName('steel_path').setDescription('Only Steel Path (true) or only normal (false)'))
        .addBooleanOption((o) => o.setName('storm').setDescription('Only Void Storms (true) or no storms (false)')),
    )
    .addSubcommand((s) =>
      s
        .setName('cycle')
        .setDescription('An open-world cycle starting, e.g. Cetus night for Eidolons')
        .addStringOption((o) =>
          o
            .setName('which')
            .setDescription('Cycle')
            .setRequired(true)
            .addChoices(...CYCLE_CHOICES.map((c) => ({ name: c.label, value: `${c.cycle}:${c.state}` }))),
        ),
    )
    .addSubcommand((s) => s.setName('baro').setDescription("Baro Ki'Teer arriving at a relay"))
    .addSubcommand((s) =>
      s
        .setName('arbitration')
        .setDescription('A new Arbitration starting (every hour), optionally only one mission type')
        .addStringOption((o) => o.setName('type').setDescription('Mission type, e.g. Defense or Survival (empty = every arbitration)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('sortie')
        .setDescription('The daily sortie, optionally only when it has a certain mission')
        .addStringOption((o) => o.setName('mission').setDescription('Mission type, e.g. Spy (empty = every sortie)').setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('archon').setDescription('The weekly Archon Hunt resetting'))
    .addSubcommand((s) => s.setName('list').setDescription('Your trackers'))
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Delete one of your trackers')
        .addIntegerOption((o) => o.setName('id').setDescription('Tracker number from /track list').setRequired(true).setMinValue(1)),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();
    const reply = (content: string, embeds: EmbedBuilder[] = []) => interaction.reply({ content, embeds, flags: MessageFlags.Ephemeral });

    if (sub === 'list') {
      const trackers = ctx.store.listTrackers(guildId, userId);
      const lines = trackers.map((t) => {
        const spec = parseSpec(t.spec);
        return `**#${t.id}** ${spec ? describeTracker(spec) : 'unreadable tracker'}`;
      });
      await reply('', [
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`Your trackers (${trackers.length}/${MAX_TRACKERS_PER_USER})`)
          .setDescription(lines.length ? lines.join('\n') : 'None yet. Try `/track cycle which:Cetus night` or `/track reward keyword:Orokin Catalyst`.'),
      ]);
      return;
    }

    if (sub === 'remove') {
      const id = interaction.options.getInteger('id', true);
      if (!ctx.store.deleteTracker(guildId, userId, id)) throw new UserError(`You have no tracker #${id}.`);
      await reply(`Tracker #${id} removed.`);
      return;
    }

    let spec: TrackerSpec;
    if (sub === 'reward') {
      spec = { kind: 'reward', keyword: interaction.options.getString('keyword', true).trim() };
    } else if (sub === 'fissure') {
      const tier = interaction.options.getString('tier') ?? undefined;
      const mission = interaction.options.getString('mission') ?? undefined;
      const steelPath = interaction.options.getBoolean('steel_path') ?? undefined;
      const storm = interaction.options.getBoolean('storm') ?? undefined;
      if (!tier && !mission && steelPath === undefined && storm === undefined) {
        throw new UserError('Pick at least one filter, otherwise Ordis would message you about every fissure.');
      }
      spec = { kind: 'fissure', tier, mission, steelPath, storm };
    } else if (sub === 'cycle') {
      const [cycle, state] = interaction.options.getString('which', true).split(':') as [string, string];
      spec = { kind: 'cycle', cycle, state };
    } else if (sub === 'arbitration') {
      spec = { kind: 'arbitration', type: interaction.options.getString('type')?.trim() || undefined };
    } else if (sub === 'sortie') {
      spec = { kind: 'sortie', mission: interaction.options.getString('mission')?.trim() || undefined };
    } else if (sub === 'archon') {
      spec = { kind: 'archon' };
    } else {
      spec = { kind: 'baro' };
    }

    if (ctx.store.listTrackers(guildId, userId).length >= MAX_TRACKERS_PER_USER) {
      throw new UserError(`You already have ${MAX_TRACKERS_PER_USER} trackers. Remove one with \`/track remove\`.`);
    }
    const created = ctx.store.createTracker(guildId, userId, JSON.stringify(spec));
    await reply(
      `Tracker **#${created.id}** set: ${describeTracker(spec)}. Ordis will DM you when it appears, including anything matching right now. ` +
        'Make sure Privacy Settings → Direct Messages from server members is on for this server.',
    );
  },

  async autocomplete(interaction) {
    const q = interaction.options.getFocused().toLowerCase();
    await interaction.respond(MISSION_TYPES.filter((m) => m.toLowerCase().includes(q)).slice(0, 25).map((m) => ({ name: m, value: m })));
  },
};
