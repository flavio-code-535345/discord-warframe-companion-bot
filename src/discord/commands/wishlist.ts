import { MessageFlags, type SlashCommandStringOption, SlashCommandBuilder } from 'discord.js';
import { addWish, listWishes, removeWish, showWish, wishChoices } from '../../wishlist/service.js';
import { replyCard } from '../card-reply.js';
import type { Command } from '../command.js';

/**
 * /wishlist: the prime sets a member is collecting. Each answer is for the member alone: their list says what they still need, and
 * with AlecaFrame linked, which relics they own.
 */

const itemOption = (description: string) => (o: SlashCommandStringOption) => o.setName('item').setDescription(description).setRequired(true).setAutocomplete(true).setMaxLength(100);

export const wishlist: Command = {
  data: new SlashCommandBuilder()
    .setName('wishlist')
    .setDescription('The prime sets you are collecting: missing parts, their relics and prices, a DM when Varzia has one')
    .addSubcommand((s) => s.setName('add').setDescription('Put a prime set on your wishlist').addStringOption(itemOption('The prime set, e.g. Saryn Prime')))
    .addSubcommand((s) =>
      s
        .setName('show')
        .setDescription('The missing parts of a set, what they cost, the relics that hold them and which of those you own')
        .addStringOption(itemOption('A set on your wishlist, or any other prime set')),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Your wishlist: what is still missing of each set'))
    .addSubcommand((s) => s.setName('remove').setDescription('Take a set off your wishlist').addStringOption(itemOption('The set to take off')))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    if (sub === 'remove') {
      const name = await removeWish(ctx, userId, interaction.options.getString('item', true));
      await interaction.reply({ content: `🗑️ **${name}** is off your wishlist.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const building =
      sub === 'add' ? addWish(ctx, userId, interaction.options.getString('item', true)) : sub === 'show' ? showWish(ctx, userId, interaction.options.getString('item', true)) : listWishes(ctx, userId);
    await replyCard(interaction, building, { ephemeral: true });
  },

  async autocomplete(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const names = await wishChoices(ctx, interaction.user.id, interaction.options.getFocused(), sub === 'remove' ? 'mine' : sub === 'add' ? 'new' : 'all');
    await interaction.respond(names.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
  },
};
