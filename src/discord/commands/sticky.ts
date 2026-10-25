import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { MAX_STICKY_LENGTH, removeSticky, setSticky } from '../../sticky/service.js';
import { UserError } from '../../services/clan.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

export const sticky: Command = {
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Keep a message at the bottom of a channel (Ordis reposts it after anyone talks)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set or replace the sticky message of a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addStringOption((o) => o.setName('message').setDescription('The text. Type \n for a new line. Markdown works.').setRequired(true).setMaxLength(MAX_STICKY_LENGTH))
        .addStringOption((o) => o.setName('title').setDescription('Optional heading').setMaxLength(200))
        .addBooleanOption((o) => o.setName('clean').setDescription('Also delete everything others post there, so only this stays (staff exempt)')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Stop the sticky message in a channel and delete it')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show the channels that have a sticky message'))
    .toJSON(),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const all = ctx.store.listStickies(ctx.config.DISCORD_GUILD_ID);
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle('📌 Sticky messages')
        .setDescription(all.length ? all.map((s) => `<#${s.channelId}>: ${s.deleteOthers ? '🧹 ' : ''}${s.title ? `**${s.title}** · ` : ''}${s.content.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n') : 'None yet. Use `/sticky set`.');
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    const channel = interaction.options.getChannel('channel', true);
    if (sub === 'set') {
      await setSticky(ctx, channel.id, interaction.options.getString('message', true), interaction.options.getString('title'), interaction.user.id, interaction.options.getBoolean('clean') ?? false);
      await interaction.editReply(`📌 Sticky set in <#${channel.id}>. ${interaction.options.getBoolean('clean') ? 'Everything else posted there is deleted (staff are exempt).' : 'Ordis moves it to the bottom whenever someone else posts.'}`);
      return;
    }
    if (!(await removeSticky(ctx, channel.id))) throw new UserError(`<#${channel.id}> has no sticky message.`);
    await interaction.editReply(`Removed the sticky message from <#${channel.id}>.`);
  },
};
