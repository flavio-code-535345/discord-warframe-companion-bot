import { SlashCommandBuilder } from 'discord.js';
import { logAnswer } from '../../answers/log.js';
import { smartAnswer } from '../../answers/smart.js';
import type { Command } from '../command.js';
import { addRatingReactions } from '../ratings.js';

export const ask: Command = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Ordis a Warframe question')
    .addStringOption((o) => o.setName('question').setDescription('e.g. "Where does Neo N16 drop?"').setRequired(true).setMaxLength(1500))
    .toJSON(),

  async execute(interaction, ctx) {
    const question = interaction.options.getString('question', true);
    const quote = `> **${interaction.user.displayName} asked:** ${question.replace(/\n/g, ' ').slice(0, 300)}`;
    await interaction.deferReply();
    const answer = await smartAnswer(question, ctx);
    const content = answer.silent ? 'Ordis has nothing to look up there, Operator. Ask about an item, a mission or anything on the wiki.' : answer.content;
    const sent = await interaction.editReply({ content: `${quote}\n${content}`.slice(0, 2000), embeds: answer.embeds, allowedMentions: { parse: [] } });
    if (answer.silent) return;
    const logged = logAnswer(ctx, { id: interaction.user.id, name: interaction.user.displayName, channelId: interaction.channelId, via: 'ask' }, question, answer, sent.id);
    if (logged !== null && interaction.inGuild() && answer.source !== 'correction') void addRatingReactions(sent);
  },
};
