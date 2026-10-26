import { SlashCommandBuilder } from 'discord.js';
import { splitForDiscord } from '../../ai/ordis.js';
import { logAnswer } from '../../answers/log.js';
import { smartAnswer } from '../../answers/smart.js';
import { UserError } from '../../services/clan.js';
import { limitMessage } from '../chat.js';
import type { Command } from '../command.js';

export const ask: Command = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Ordis a Warframe question')
    .addStringOption((o) => o.setName('question').setDescription('e.g. "Where does Neo N16 drop?"').setRequired(true).setMaxLength(1500))
    .toJSON(),

  async execute(interaction, ctx) {
    const question = interaction.options.getString('question', true);
    // Quoting the question keeps it in the reply chain, so replying to the answer continues the conversation.
    const quote = `> **${interaction.user.displayName} asked:** ${question.replace(/\n/g, ' ').slice(0, 300)}`;

    // Without an AI key, Ordis answers from live data and the wiki (free).
    if (!ctx.ai) {
      await interaction.deferReply();
      const answer = await smartAnswer(question, ctx, { id: interaction.user.id, name: interaction.user.displayName });
      await interaction.editReply({ content: `${quote}\n${answer.content}`.slice(0, 2000), embeds: answer.embeds, allowedMentions: { parse: [] } });
      logAnswer(ctx, { id: interaction.user.id, name: interaction.user.displayName, channelId: interaction.channelId, via: 'ask' }, question, answer);
      return;
    }

    const limit = ctx.ai.limiter.take(interaction.user.id);
    if (!limit.ok) throw new UserError(limitMessage(limit.reason, limit.retryAfterMs));
    await interaction.deferReply();
    const member = ctx.store.getMember(ctx.config.DISCORD_GUILD_ID, interaction.user.id);
    const answer = await ctx.ai.brain.ask({
      question,
      history: [],
      askerName: interaction.member && 'displayName' in interaction.member ? interaction.member.displayName : interaction.user.displayName,
      askerIgn: member?.ign ?? null,
      where: interaction.channel && 'name' in interaction.channel ? `#${interaction.channel.name} via /ask` : '/ask',
    });
    const [first, ...rest] = splitForDiscord(`${quote}\n\n${answer.text}`);
    await interaction.editReply({ content: first ?? '…', allowedMentions: { parse: [] } });
    for (const chunk of rest) await interaction.followUp({ content: chunk, allowedMentions: { parse: [] } });
  },
};
