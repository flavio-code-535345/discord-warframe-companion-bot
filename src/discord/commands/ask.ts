import { SlashCommandBuilder } from 'discord.js';
import { splitForDiscord } from '../../ai/ordis.js';
import { UserError } from '../../services/clan.js';
import { limitMessage } from '../chat.js';
import type { Command } from '../command.js';

export const ask: Command = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Ordis a Warframe question')
    .addStringOption((o) => o.setName('question').setDescription('e.g. "How do I get Archon Shards?"').setRequired(true).setMaxLength(1500))
    .toJSON(),

  async execute(interaction, ctx) {
    if (!ctx.ai) throw new UserError("Ordis's conversation matrix is offline: the bot's AI chat isn't configured.");
    const limit = ctx.ai.limiter.take(interaction.user.id);
    if (!limit.ok) throw new UserError(limitMessage(limit.reason, limit.retryAfterMs));

    const question = interaction.options.getString('question', true);
    await interaction.deferReply();
    const member = ctx.store.getMember(ctx.config.DISCORD_GUILD_ID, interaction.user.id);
    const answer = await ctx.ai.brain.ask({
      question,
      history: [],
      askerName: interaction.member && 'displayName' in interaction.member ? interaction.member.displayName : interaction.user.displayName,
      askerIgn: member?.ign ?? null,
      where: interaction.channel && 'name' in interaction.channel ? `#${interaction.channel.name} via /ask` : '/ask',
    });
    // Quoting the question keeps it in the reply chain, so replying to this answer continues the conversation.
    const quoted = `> **${interaction.user.displayName} asked:** ${question.replace(/\n/g, ' ').slice(0, 300)}\n\n${answer.text}`;
    const [first, ...rest] = splitForDiscord(quoted);
    await interaction.editReply({ content: first ?? '…', allowedMentions: { parse: [] } });
    for (const chunk of rest) await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
  },
};
