import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  type ModalSubmitInteraction,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import type { Sticky } from '../../db.js';
import { UserError } from '../../services/clan.js';
import { MAX_STICKY_LENGTH, MAX_STICKY_TITLE, checkStickyChannel, removeSticky, saveSticky } from '../../sticky/service.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const MODAL_PREFIX = 'sticky:save:';

const field = (id: string, label: string, style: TextInputStyle, max: number, required: boolean, value?: string | null, placeholder?: string) => {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
};

/** The form for a sticky: heading, message (multi-line, so no `\n` typing) and an optional picture. */
function stickyModal(channelId: string, clean: boolean, current: Sticky | null): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${MODAL_PREFIX}${channelId}:${clean ? 'clean' : 'keep'}`)
    .setTitle(current ? 'Edit sticky message' : 'New sticky message')
    .addComponents(
      field('title', 'Heading (optional)', TextInputStyle.Short, MAX_STICKY_TITLE, false, current?.title),
      field('content', 'Message (Markdown works)', TextInputStyle.Paragraph, MAX_STICKY_LENGTH, true, current?.content),
      field('image', 'Picture links (optional, up to 2, https)', TextInputStyle.Short, 1000, false, current?.imageUrl, 'https://…/picture.png'),
    );
}

export const sticky: Command = {
  data: new SlashCommandBuilder()
    .setName('sticky')
    .setDescription('Keep a message at the bottom of a channel (Ordis reposts it after anyone talks)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Create a sticky message in a channel (opens a form)')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addBooleanOption((o) => o.setName('clean').setDescription('Also delete everything others post there, so only this stays (staff exempt)')),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription("Change a channel's sticky message (opens the form with the current text)")
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS))
        .addBooleanOption((o) => o.setName('clean').setDescription('Turn clean mode on or off (default: keep as it is)')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Stop the sticky message in a channel and delete it')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show the channels that have a sticky message'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set' || sub === 'edit') {
      const channel = interaction.options.getChannel('channel', true);
      const existing = ctx.store.getSticky(channel.id);
      if (sub === 'edit' && !existing) throw new UserError(`<#${channel.id}> has no sticky message yet. Use \`/sticky set\`.`);
      const clean = interaction.options.getBoolean('clean') ?? existing?.deleteOthers ?? false;
      await checkStickyChannel(ctx, channel.id, clean);
      await interaction.showModal(stickyModal(channel.id, clean, sub === 'edit' ? existing : null));
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'list') {
      const all = ctx.store.listStickies(ctx.config.DISCORD_GUILD_ID);
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle('📌 Sticky messages')
        .setDescription(
          all.length
            ? all.map((s) => `<#${s.channelId}>${s.deleteOthers ? ' 🧹' : ''}: ${s.title ? `**${s.title}** · ` : ''}${s.content.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n')
            : 'None yet. Use `/sticky set`.',
        )
        .setFooter({ text: '🧹 = clean channel: everything else posted there is deleted' });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const channel = interaction.options.getChannel('channel', true);
    if (!(await removeSticky(ctx, channel.id))) throw new UserError(`<#${channel.id}> has no sticky message.`);
    await interaction.editReply(`Removed the sticky message from <#${channel.id}>.`);
  },
};

export const isStickyModal = (customId: string) => customId.startsWith(MODAL_PREFIX);

/** Saves the form from `/sticky set` or `/sticky edit`. */
export async function handleStickyModal(interaction: ModalSubmitInteraction, ctx: AppContext): Promise<void> {
  const [channelId, mode] = interaction.customId.slice(MODAL_PREFIX.length).split(':');
  if (!channelId) throw new UserError('That form is out of date. Run the command again.');
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) throw new UserError('You need the Manage Messages permission for this.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const clean = mode === 'clean';
  await saveSticky(ctx, {
    channelId,
    content: interaction.fields.getTextInputValue('content'),
    title: interaction.fields.getTextInputValue('title'),
    imageUrl: interaction.fields.getTextInputValue('image'),
    deleteOthers: clean,
    userId: interaction.user.id,
  });
  await interaction.editReply(`📌 Saved in <#${channelId}>. ${clean ? 'Everything else posted there is deleted (staff are exempt).' : 'Ordis moves it to the bottom whenever someone else posts.'}`);
}
