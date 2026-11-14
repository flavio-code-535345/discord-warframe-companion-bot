import { type ChatInputCommandInteraction, type ContainerBuilder, MessageFlags } from 'discord.js';
import { withTimeout } from '../timeout.js';

/** How long a card may take before the reply is deferred: Discord gives a command three seconds to answer. */
const QUICK_MS = 1500;

class StillBuilding extends Error {}

/**
 * Answers a slash command with one Components V2 card. When the card is ready within `quickMs` it is the reply itself; when what it
 * is drawn from is slow (a source being read at that very moment), the reply says "thinking" first and gets the card afterwards.
 * A failure while building is thrown on, so the command's caller answers it like any other (a `UserError` privately).
 */
export async function replyCard(
  interaction: Pick<ChatInputCommandInteraction, 'reply' | 'deferReply' | 'editReply'>,
  building: Promise<ContainerBuilder>,
  opts: { ephemeral: boolean; quickMs?: number },
): Promise<void> {
  let ready: ContainerBuilder | null = null;
  try {
    ready = await withTimeout(building, opts.quickMs ?? QUICK_MS, () => new StillBuilding());
  } catch (err) {
    if (!(err instanceof StillBuilding)) throw err;
  }
  if (ready) {
    await interaction.reply({ components: [ready], flags: opts.ephemeral ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    return;
  }
  // Deferring takes no Components V2 flag; the edit that brings the card does.
  await interaction.deferReply(opts.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
  await interaction.editReply({ components: [await building], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
}
