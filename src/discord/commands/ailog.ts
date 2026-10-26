import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { formatAiLog, sourceLabel } from '../../answers/log.js';
import type { AiSource } from '../../db.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

const STAT_ORDER: AiSource[] = ['local', 'cloud', 'excerpt', 'lookup', 'cache'];

/** Staff: what members asked Ordis and which model answered. */
export const ailog: Command = {
  data: new SlashCommandBuilder()
    .setName('ailog')
    .setDescription('Staff: recent questions members asked Ordis and which model answered')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('count').setDescription('How many entries (default 8)').setMinValue(1).setMaxValue(25))
    .addUserOption((o) => o.setName('member').setDescription('Only this member'))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const entries = ctx.store.recentAiLog(guildId, interaction.options.getInteger('count') ?? 8, interaction.options.getUser('member')?.id);
    const stats = ctx.store.aiLogStats(guildId, Date.now() - 86_400_000);
    const summary = STAT_ORDER.filter((s) => stats[s]).map((s) => `${sourceLabel({ source: s, model: null })} ${stats[s]}`).join(' · ');
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('🧠 Ordis question log')
      .setDescription(formatAiLog(entries) || 'No questions logged yet.')
      .setFooter({ text: `Last 24 h: ${summary || 'none'} · kept for 30 days` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};
