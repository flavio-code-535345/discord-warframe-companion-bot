import { type ContainerBuilder, SlashCommandBuilder } from 'discord.js';
import type { AppContext } from '../../context.js';
import { replyCard } from '../card-reply.js';
import type { Command } from '../command.js';
import { personalLines } from '../crack.js';
import { nowCard, nowInput } from '../now.js';

/** How long the card waits for the member's own relics (AlecaFrame): it is answered within Discord's three seconds either way. */
const PERSONAL_WAIT_MS = 1100;

/** The card for one member: the snapshot everyone gets, and, unless it is shared, what their own relics add to it. */
async function buildNow(ctx: AppContext, userId: string, share: boolean): Promise<ContainerBuilder> {
  const input = await nowInput(ctx);
  const personal = share ? [] : await personalLines(ctx, userId, input.ws, input.now, { waitMs: PERSONAL_WAIT_MS });
  return nowCard(input, { personal });
}

/** `/now`: what is worth doing in the game right now, on one card. Only the member who asked sees it unless they share it. */
export const now: Command = {
  data: new SlashCommandBuilder()
    .setName('now')
    .setDescription('What is worth doing in Warframe right now: Arbitration, quick fissures, rewards, cycles, Baro')
    .addBooleanOption((o) => o.setName('share').setDescription('Post it in the channel for everyone (default: only you see it)'))
    .toJSON(),

  async execute(interaction, ctx) {
    const share = interaction.options.getBoolean('share') ?? false;
    // Both sources are cached, so the card is nearly always ready at once and is the reply itself.
    await replyCard(interaction, buildNow(ctx, interaction.user.id, share), { ephemeral: !share });
  },
};
