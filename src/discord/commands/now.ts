import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { withTimeout } from '../../timeout.js';
import type { Command } from '../command.js';
import type { FeedInput } from '../feeds/types.js';
import { nowCard, nowInput } from '../now.js';

/** How long the card may take before the reply is deferred: Discord gives a command three seconds to answer. */
const QUICK_MS = 1500;

/**
 * Answers with the card. Both sources are cached, so the card is nearly always ready at once and is the reply itself; only when one
 * of them is being read at this very moment and is slow does the reply say "thinking" first and get the card afterwards.
 */
export async function answerNow(
  interaction: Pick<ChatInputCommandInteraction, 'reply' | 'deferReply' | 'editReply'>,
  reading: Promise<FeedInput>,
  share: boolean,
  quickMs = QUICK_MS,
): Promise<void> {
  const ready = await withTimeout(reading, quickMs, () => new Error('still reading')).catch(() => null);
  if (ready) {
    await interaction.reply({ components: [nowCard(ready)], flags: share ? MessageFlags.IsComponentsV2 : MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }
  await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
  await interaction.editReply({ components: [nowCard(await reading)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
}

/** `/now`: what is worth doing in the game right now, on one card. Only the member who asked sees it unless they share it. */
export const now: Command = {
  data: new SlashCommandBuilder()
    .setName('now')
    .setDescription('What is worth doing in Warframe right now: Arbitration, quick fissures, rewards, cycles, Baro')
    .addBooleanOption((o) => o.setName('share').setDescription('Post it in the channel for everyone (default: only you see it)'))
    .toJSON(),

  async execute(interaction, ctx) {
    await answerNow(interaction, nowInput(ctx), interaction.options.getBoolean('share') ?? false);
  },
};
