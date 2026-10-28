import { MessageFlags, SlashCommandBuilder, type VoiceBasedChannel } from 'discord.js';
import { UserError } from '../../services/clan.js';
import type { Command } from '../command.js';

export const vc: Command = {
  data: new SlashCommandBuilder()
    .setName('vc')
    .setDescription('Manage your own voice room (made by joining the lobby channel)')
    .addSubcommand((s) =>
      s
        .setName('rename')
        .setDescription('Rename your room')
        .addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMinLength(1).setMaxLength(90)),
    )
    .addSubcommand((s) =>
      s
        .setName('limit')
        .setDescription('Set how many people can join your room')
        .addIntegerOption((o) => o.setName('users').setDescription('0 means no limit').setRequired(true).setMinValue(0).setMaxValue(99)),
    )
    .addSubcommand((s) => s.setName('lock').setDescription('Stop new people from joining your room'))
    .addSubcommand((s) => s.setName('unlock').setDescription('Let people join your room again'))
    .toJSON(),

  async execute(interaction, ctx) {
    if (!interaction.inCachedGuild()) throw new UserError('This only works in the server.');
    const channel = interaction.member.voice.channel as VoiceBasedChannel | null;
    const room = channel ? ctx.store.getTempVoice(channel.id) : null;
    if (!channel || !room) throw new UserError('Join your own room first. This only works inside a room made from the lobby channel.');
    if (room.ownerId !== interaction.user.id) throw new UserError(`Only <@${room.ownerId}> can change this room.`);

    const sub = interaction.options.getSubcommand();
    let done: string;
    if (sub === 'rename') {
      const name = interaction.options.getString('name', true).trim();
      if (!name) throw new UserError('Give the room a name.');
      await channel.setName(name, `Renamed by ${interaction.user.username}`);
      done = `Renamed your room to **${name}**.`;
    } else if (sub === 'limit') {
      const users = interaction.options.getInteger('users', true);
      await channel.setUserLimit(users, `Limit set by ${interaction.user.username}`);
      done = users ? `Your room now holds up to ${users} people.` : 'Your room has no user limit.';
    } else if (sub === 'lock') {
      await channel.permissionOverwrites.edit(interaction.guildId, { Connect: false }, { reason: `Locked by ${interaction.user.username}` });
      done = '🔒 Your room is locked. People already inside can stay.';
    } else {
      await channel.permissionOverwrites.edit(interaction.guildId, { Connect: null }, { reason: `Unlocked by ${interaction.user.username}` });
      done = '🔓 Your room is open again.';
    }
    await interaction.reply({ content: done, flags: MessageFlags.Ephemeral });
  },
};
