import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { GuildSettings } from '../../db.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

export function settingsEmbed(s: GuildSettings, welcomeEnabled: boolean): EmbedBuilder {
  const ch = (id: string | null) => (id ? `<#${id}>` : '*off*');
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Bot settings')
    .addFields(
      { name: 'Worldstate alerts', value: `${ch(s.alertsChannelId)}${s.alertsRoleId ? ` · pings <@&${s.alertsRoleId}>` : ''}` },
      { name: 'Announcements & events', value: ch(s.announcementsChannelId) },
      {
        name: 'Welcome messages',
        value: `${ch(s.welcomeChannelId)}${welcomeEnabled ? '' : ' · ⚠️ disabled (set ENABLE_WELCOME=true and enable the Server Members intent)'}`,
      },
    );
}

export const setup: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure where the bot posts')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('alerts')
        .setDescription('Channel for automatic Baro, sortie, Archon, Steel Path and invasion alerts')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping with each alert')),
    )
    .addSubcommand((s) =>
      s
        .setName('announcements')
        .setDescription('Default channel for clan events and announcements')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) =>
      s
        .setName('welcome')
        .setDescription('Channel that greets new server members')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) =>
      s
        .setName('off')
        .setDescription('Turn a feature off')
        .addStringOption((o) =>
          o
            .setName('feature')
            .setDescription('Feature')
            .setRequired(true)
            .addChoices(
              { name: 'Worldstate alerts', value: 'alerts' },
              { name: 'Announcements channel', value: 'announcements' },
              { name: 'Welcome messages', value: 'welcome' },
            ),
        ),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show current settings'))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();
    const channelId = () => interaction.options.getChannel('channel', true).id;

    let settings: GuildSettings;
    switch (sub) {
      case 'alerts':
        settings = ctx.store.updateSettings(guildId, {
          alertsChannelId: channelId(),
          alertsRoleId: interaction.options.getRole('ping_role')?.id ?? null,
        });
        break;
      case 'announcements':
        settings = ctx.store.updateSettings(guildId, { announcementsChannelId: channelId() });
        break;
      case 'welcome':
        settings = ctx.store.updateSettings(guildId, { welcomeChannelId: channelId() });
        break;
      case 'off': {
        const feature = interaction.options.getString('feature', true);
        settings = ctx.store.updateSettings(
          guildId,
          feature === 'alerts'
            ? { alertsChannelId: null, alertsRoleId: null }
            : feature === 'announcements'
              ? { announcementsChannelId: null }
              : { welcomeChannelId: null },
        );
        break;
      }
      default:
        settings = ctx.store.getSettings(guildId);
    }
    await interaction.reply({ embeds: [settingsEmbed(settings, ctx.config.ENABLE_WELCOME)], flags: MessageFlags.Ephemeral });
  },
};
