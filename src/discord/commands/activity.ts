import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Activity } from '../../db.js';
import { validImageUrl } from '../../lfg/lifecycle.js';
import { UserError } from '../../errors.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';
import { ACTIVITIES } from './lfg.js';

const IMAGE_HELP = 'a direct https link to an image (right-click the image, copy image address)';

const describeActivity = (a: Activity) =>
  `**${a.name}** · ${a.imageUrl ? '🖼️ picture' : 'no picture'}${a.channelId ? ` · posts in <#${a.channelId}>` : ''}`;

export const activity: Command = {
  data: new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Set the picture and channel for each /lfg activity')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Add an activity, or change an existing one (only the options you give are changed)')
        .addStringOption((o) => o.setName('name').setDescription('Activity name, as people pick it in /lfg').setRequired(true).setMaxLength(100).setAutocomplete(true))
        .addStringOption((o) => o.setName('image').setDescription('Picture for its LFG posts: a direct https link to an image').setMaxLength(1000))
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Post this activity in a fixed channel instead of where /lfg ran').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('clear')
        .setDescription("Remove an activity's picture or channel (or all of its settings)")
        .addStringOption((o) => o.setName('name').setDescription('Activity').setRequired(true).setMaxLength(100).setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('what')
            .setDescription('What to clear (default: everything)')
            .addChoices({ name: 'Picture', value: 'image' }, { name: 'Channel', value: 'channel' }, { name: 'Everything (remove the activity)', value: 'all' }),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show every activity with its picture and channel'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const configured = ctx.store.listActivities();
      const lines = configured.map(describeActivity);
      const plain = ACTIVITIES.filter((n) => !configured.some((a) => a.name.toLowerCase() === n.toLowerCase()));
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle('LFG activities')
        .setDescription(lines.join('\n').slice(0, 3000) || '*No activity has a picture or channel yet. Use `/activity set`.*')
        .addFields({ name: 'Suggestions without settings', value: plain.join(' · ').slice(0, 1024) || '—' });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const name = interaction.options.getString('name', true).trim();
    const existing = ctx.store.getActivity(name);

    if (sub === 'set') {
      const image = interaction.options.getString('image');
      const channel = interaction.options.getChannel('channel');
      if (!image && !channel) throw new UserError('Give at least one thing to change: image or channel.');
      const imageUrl = image ? validImageUrl(image) : (existing?.imageUrl ?? null);
      if (image && !imageUrl) throw new UserError(`The image must be ${IMAGE_HELP}.`);
      const saved: Activity = {
        name: existing?.name ?? name,
        imageUrl,
        channelId: channel?.id ?? existing?.channelId ?? null,
      };
      ctx.store.saveActivity(saved);
      await interaction.reply({ content: `${existing ? 'Updated' : 'Added'} ${describeActivity(saved)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    // clear
    if (!existing) throw new UserError(`"${name}" has no settings.`);
    const what = interaction.options.getString('what') ?? 'all';
    if (what === 'all') {
      ctx.store.removeActivity(existing.name);
      await interaction.reply({ content: `Removed the settings for **${existing.name}**. It still works in /lfg, just without a picture.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const cleared: Activity = {
      ...existing,
      imageUrl: what === 'image' ? null : existing.imageUrl,
      channelId: what === 'channel' ? null : existing.channelId,
    };
    ctx.store.saveActivity(cleared);
    await interaction.reply({ content: `Updated ${describeActivity(cleared)}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },

  async autocomplete(interaction, ctx) {
    const q = interaction.options.getFocused().toLowerCase();
    const sub = interaction.options.getSubcommand(false);
    // `set` can add any new name; `clear` only works on activities that already have settings.
    const pool = sub === 'clear' ? ctx.store.listActivities().map((a) => a.name) : [...new Set([...ctx.store.listActivities().map((a) => a.name), ...ACTIVITIES])];
    await interaction.respond(
      pool
        .filter((n) => n.toLowerCase().includes(q))
        .slice(0, 25)
        .map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })),
    );
  },
};
