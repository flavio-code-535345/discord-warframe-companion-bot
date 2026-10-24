import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError, renderLfg } from '../../services/clan.js';
import type { Command } from '../command.js';

const ACTIVITIES = [
  'Eidolon hunt',
  'Archon Hunt',
  'Sortie',
  'Steel Path Circuit',
  'Netracells',
  'Elite Deep Archimedea',
  'Elite Temporal Archimedea',
  'Relic radshares',
  'Profit-Taker',
  'Exploiter Orb',
  'Kuva Lich / Sister hunt',
  'Railjack',
  'Arbitrations',
  'Void Cascade',
  'Index credit farm',
  'Steel Path Survival',
  'Mastery / leveling',
  'Clan dojo help',
];

export const lfg: Command = {
  data: new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Post a looking-for-group squad that clanmates can join')
    .addStringOption((o) => o.setName('activity').setDescription('What are you running?').setRequired(true).setMaxLength(100).setAutocomplete(true))
    .addStringOption((o) => o.setName('details').setDescription('Requirements, relics, voice channel…').setMaxLength(1000))
    .addIntegerOption((o) => o.setName('size').setDescription('Squad size including you (default 4)').setMinValue(2).setMaxValue(4))
    .toJSON(),

  async execute(interaction, ctx) {
    if (!interaction.channel?.isSendable()) throw new UserError("I can't post in this channel.");
    const post = ctx.store.createLfg({
      guildId: ctx.config.DISCORD_GUILD_ID,
      channelId: interaction.channelId,
      hostId: interaction.user.id,
      activity: interaction.options.getString('activity', true),
      details: interaction.options.getString('details'),
      size: interaction.options.getInteger('size') ?? 4,
    });
    const message = await interaction.channel.send(renderLfg(ctx, post));
    ctx.store.setLfgMessage(post.id, message.id);
    await interaction.reply({ content: `LFG #${post.id} posted.`, flags: MessageFlags.Ephemeral });
  },

  async autocomplete(interaction) {
    const q = interaction.options.getFocused().toLowerCase();
    const matches = ACTIVITIES.filter((a) => a.toLowerCase().includes(q));
    // Let people post anything, not only the suggestions.
    const options = q && !matches.some((m) => m.toLowerCase() === q) ? [interaction.options.getFocused(), ...matches] : matches;
    await interaction.respond(options.slice(0, 25).map((a) => ({ name: a.slice(0, 100), value: a.slice(0, 100) })));
  },
};
