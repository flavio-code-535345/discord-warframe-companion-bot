import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Config } from '../../config.js';
import type { GuildSettings } from '../../db.js';
import { disableHoneypot, honeypotAction, setupHoneypot } from '../../moderation/honeypot.js';
import { disableVerification, setupVerification } from '../verification.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

type Flags = Pick<Config, 'ENABLE_WELCOME' | 'ENABLE_MESSAGE_CONTENT' | 'ANTHROPIC_API_KEY'>;

export function settingsEmbed(s: GuildSettings, flags: Flags): EmbedBuilder {
  const ch = (id: string | null) => (id ? `<#${id}>` : '*off*');
  const chatWarnings = [
    flags.ANTHROPIC_API_KEY ? null : 'AI chat is off (no ANTHROPIC_API_KEY)',
    s.chatChannelId && !flags.ENABLE_MESSAGE_CONTENT ? 'needs ENABLE_MESSAGE_CONTENT=true and the Message Content intent' : null,
  ].filter(Boolean);
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Bot settings')
    .addFields(
      { name: 'Worldstate alerts', value: `${ch(s.alertsChannelId)}${s.alertsRoleId ? ` · pings <@&${s.alertsRoleId}>` : ''}` },
      { name: 'Announcements & events', value: ch(s.announcementsChannelId) },
      {
        name: 'Welcome messages',
        value: `${ch(s.welcomeChannelId)}${flags.ENABLE_WELCOME ? '' : ' · ⚠️ disabled (set ENABLE_WELCOME=true and enable the Server Members intent)'}`,
      },
      { name: 'Moderation log', value: ch(s.modLogChannelId) },
      {
        name: 'Squad voice',
        value: s.lfgVoiceCategoryId ? `category <#${s.lfgVoiceCategoryId}> · host grace ${s.lfgVoiceGraceMinutes ?? 5} min` : '*off* (squads post without a voice channel)',
      },
      { name: 'Honeypot', value: s.honeypotChannelId ? `${ch(s.honeypotChannelId)} · ${honeypotAction(s.honeypotAction)}` : '*off*' },
      {
        name: 'Verification',
        value: s.verifyRoleId
          ? `panel in ${ch(s.verifyChannelId)} · grants <@&${s.verifyRoleId}>${s.verifyMinAccountAgeDays ? ` · accounts older than ${s.verifyMinAccountAgeDays} days` : ''}`
          : '*off*',
      },
      {
        name: 'Ordis chat channel',
        value: `${ch(s.chatChannelId)} · mentions, replies, /ask and DMs always work${chatWarnings.length ? `
⚠️ ${chatWarnings.join('; ')}` : ''}`,
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
        .setName('verification')
        .setDescription('Captcha verification: posts a Verify panel that gives a role on success')
        .addChannelOption((o) => o.setName('channel').setDescription('Where newcomers verify').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addRoleOption((o) => o.setName('role').setDescription('Role to give verified members').setRequired(true))
        .addIntegerOption((o) => o.setName('min_account_age_days').setDescription('Refuse Discord accounts younger than this (default: no limit)').setMinValue(0).setMaxValue(365)),
    )
    .addSubcommand((s) =>
      s
        .setName('modlog')
        .setDescription('Channel where purges, warnings, timeouts, kicks and bans are logged')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) =>
      s
        .setName('honeypot')
        .setDescription('Trap channel: anyone without moderator powers who posts there is removed (for spam bots)')
        .addChannelOption((o) => o.setName('channel').setDescription('A channel nobody should write in').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What happens to the poster (default: softban)')
            .addChoices(
              { name: 'Softban: remove and clear the last hour of messages, they can rejoin', value: 'softban' },
              { name: 'Ban: permanent', value: 'ban' },
              { name: 'Kick: remove, messages stay', value: 'kick' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('lfgvoice')
        .setDescription('Give every /lfg squad its own voice channel in a category (made and removed automatically)')
        .addChannelOption((o) => o.setName('category').setDescription('Category for the squad voice channels').setRequired(true).addChannelTypes(ChannelType.GuildCategory))
        .addIntegerOption((o) => o.setName('grace_minutes').setDescription('Minutes the host may be out of voice before the squad ends (default 5)').setMinValue(1).setMaxValue(60)),
    )
    .addSubcommand((s) =>
      s
        .setName('chat')
        .setDescription('Channel where Ordis answers every message, not only mentions')
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
              { name: 'Ordis chat channel', value: 'chat' },
              { name: 'Moderation log', value: 'modlog' },
              { name: 'Verification', value: 'verification' },
              { name: 'Honeypot', value: 'honeypot' },
              { name: 'Squad voice channels', value: 'lfgvoice' },
            ),
        ),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Show current settings'))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();
    const channelId = (option = 'channel') => interaction.options.getChannel(option, true).id;

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
      case 'chat':
        settings = ctx.store.updateSettings(guildId, { chatChannelId: channelId() });
        break;
      case 'modlog':
        settings = ctx.store.updateSettings(guildId, { modLogChannelId: channelId() });
        break;
      case 'verification': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const url = await setupVerification(
          ctx,
          channelId(),
          interaction.options.getRole('role', true).id,
          interaction.options.getInteger('min_account_age_days') || null,
        );
        await interaction.editReply({ content: `🛡️ Verification panel posted: ${url}`, embeds: [settingsEmbed(ctx.store.getSettings(guildId), ctx.config)] });
        return;
      }
      case 'lfgvoice':
        settings = ctx.store.updateSettings(guildId, {
          lfgVoiceCategoryId: channelId('category'),
          lfgVoiceGraceMinutes: interaction.options.getInteger('grace_minutes'),
        });
        break;
      case 'honeypot': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await setupHoneypot(ctx, channelId(), honeypotAction(interaction.options.getString('action')));
        await interaction.editReply({ embeds: [settingsEmbed(ctx.store.getSettings(guildId), ctx.config)] });
        return;
      }
      case 'off': {
        const feature = interaction.options.getString('feature', true);
        if (feature === 'verification') {
          await disableVerification(ctx);
          settings = ctx.store.getSettings(guildId);
          break;
        }
        if (feature === 'lfgvoice') {
          settings = ctx.store.updateSettings(guildId, { lfgVoiceCategoryId: null, lfgVoiceGraceMinutes: null });
          break;
        }
        if (feature === 'honeypot') {
          disableHoneypot(ctx);
          settings = ctx.store.getSettings(guildId);
          break;
        }
        settings = ctx.store.updateSettings(
          guildId,
          feature === 'alerts'
            ? { alertsChannelId: null, alertsRoleId: null }
            : feature === 'announcements'
              ? { announcementsChannelId: null }
              : feature === 'chat'
                ? { chatChannelId: null }
                : feature === 'modlog'
                  ? { modLogChannelId: null }
                  : { welcomeChannelId: null },
        );
        break;
      }
      default:
        settings = ctx.store.getSettings(guildId);
    }
    await interaction.reply({ embeds: [settingsEmbed(settings, ctx.config)], flags: MessageFlags.Ephemeral });
  },
};
