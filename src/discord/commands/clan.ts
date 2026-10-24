import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../services/clan.js';
import type { Command } from '../command.js';
import { COLORS, clampLines } from '../embeds.js';

export const PLATFORMS = ['PC', 'PlayStation', 'Xbox', 'Switch', 'Mobile'] as const;

export const clan: Command = {
  data: new SlashCommandBuilder()
    .setName('clan')
    .setDescription('Clan roster and info')
    .addSubcommand((s) => s.setName('info').setDescription('Clan overview'))
    .addSubcommand((s) =>
      s
        .setName('register')
        .setDescription('Link your Warframe in-game name to your Discord account')
        .addStringOption((o) => o.setName('ign').setDescription('In-game name').setRequired(true).setMaxLength(32))
        .addIntegerOption((o) => o.setName('mastery_rank').setDescription('Mastery rank (Legendary 1 = 31)').setMinValue(0).setMaxValue(60))
        .addStringOption((o) =>
          o.setName('platform').setDescription('Main platform').addChoices(...PLATFORMS.map((p) => ({ name: p, value: p }))),
        ),
    )
    .addSubcommand((s) => s.setName('unregister').setDescription('Remove your roster entry'))
    .addSubcommand((s) =>
      s
        .setName('whois')
        .setDescription("Look up a clanmate's in-game name, or who uses an in-game name")
        .addUserOption((o) => o.setName('user').setDescription('Discord member'))
        .addStringOption((o) => o.setName('ign').setDescription('In-game name')),
    )
    .addSubcommand((s) => s.setName('roster').setDescription('Everyone registered in the clan roster'))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();

    if (sub === 'info') {
      const guild = await ctx.client.guilds.fetch(guildId);
      const settings = ctx.store.getSettings(guildId);
      const ch = (id: string | null) => (id ? `<#${id}>` : '*not set*');
      const next = ctx.store.upcomingEvents(guildId)[0];
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(`🐀 ${ctx.config.CLAN_NAME}`)
        .setThumbnail(guild.iconURL())
        .addFields(
          { name: 'Discord members', value: String(guild.memberCount), inline: true },
          { name: 'Registered Tenno', value: String(ctx.store.listMembers(guildId).length), inline: true },
          { name: 'Upcoming events', value: String(ctx.store.upcomingEvents(guildId).length), inline: true },
          { name: 'Next event', value: next ? `${next.title} <t:${Math.floor(next.startsAt / 1000)}:R>` : '—' },
          { name: 'Worldstate alerts', value: ch(settings.alertsChannelId), inline: true },
          { name: 'Announcements', value: ch(settings.announcementsChannelId), inline: true },
          { name: 'Welcome', value: ch(settings.welcomeChannelId), inline: true },
        );
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (sub === 'register') {
      const member = ctx.store.upsertMember({
        guildId,
        userId: interaction.user.id,
        ign: interaction.options.getString('ign', true).trim(),
        masteryRank: interaction.options.getInteger('mastery_rank'),
        platform: interaction.options.getString('platform'),
      });
      await interaction.reply({
        content: `Registered as **${member.ign}**${member.masteryRank !== null ? ` (MR ${member.masteryRank})` : ''}. Welcome to the den, Tenno.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'unregister') {
      const removed = ctx.store.removeMember(guildId, interaction.user.id);
      await interaction.reply({
        content: removed ? 'Your roster entry was removed.' : "You weren't registered.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'whois') {
      const ign = interaction.options.getString('ign');
      const user = interaction.options.getUser('user') ?? (ign ? null : interaction.user);
      const member = ign ? ctx.store.findMemberByIgn(guildId, ign) : ctx.store.getMember(guildId, user!.id);
      if (!member) throw new UserError(ign ? `Nobody has registered "${ign}".` : `<@${user!.id}> hasn't registered yet (/clan register).`);
      const extras = [member.masteryRank !== null ? `MR ${member.masteryRank}` : null, member.platform].filter(Boolean).join(' · ');
      await interaction.reply({
        content: `<@${member.userId}> is **${member.ign}**${extras ? ` — ${extras}` : ''}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === 'roster') {
      const members = ctx.store.listMembers(guildId);
      const lines = members.map(
        (m) => `**${m.ign}** — <@${m.userId}>${m.masteryRank !== null ? ` · MR ${m.masteryRank}` : ''}${m.platform ? ` · ${m.platform}` : ''}`,
      );
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(`${ctx.config.CLAN_NAME} roster (${members.length})`)
        .setDescription(members.length ? clampLines(lines) : 'Nobody has registered yet. Use `/clan register`.');
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
    }
  },
};
