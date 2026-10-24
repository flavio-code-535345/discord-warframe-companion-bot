import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { UserError, cancelClanEvent, createClanEvent } from '../../services/clan.js';
import { discordTime, parseWhen } from '../../time.js';
import type { Command } from '../command.js';
import { COLORS, clampLines } from '../embeds.js';

export const event: Command = {
  data: new SlashCommandBuilder()
    .setName('event')
    .setDescription('Clan events with RSVPs and reminders')
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Schedule a clan event')
        .addStringOption((o) => o.setName('title').setDescription('e.g. "Eidolon hunt"').setRequired(true).setMaxLength(200))
        .addStringOption((o) =>
          o.setName('when').setDescription('"2h", "1d 4h", "2026-11-02 20:00" (UTC) or a Unix timestamp').setRequired(true),
        )
        .addStringOption((o) => o.setName('description').setDescription('Details, requirements, etc.').setMaxLength(2000))
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Where to post it (defaults to the announcements channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Upcoming clan events'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Cancel an event (creator or event managers only)')
        .addIntegerOption((o) => o.setName('id').setDescription('Event number').setRequired(true).setMinValue(1)),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const when = interaction.options.getString('when', true);
      const startsAt = parseWhen(when);
      if (startsAt === null) throw new UserError(`I couldn't read "${when}" as a time. Try "2h", "1d 4h" or "2026-11-02 20:00".`);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channelId =
        interaction.options.getChannel('channel')?.id ??
        ctx.store.getSettings(guildId).announcementsChannelId ??
        interaction.channelId;
      const created = await createClanEvent(ctx, {
        title: interaction.options.getString('title', true),
        description: interaction.options.getString('description'),
        startsAt,
        createdBy: interaction.user.id,
        channelId,
      });
      await interaction.editReply(`Event #${created.id} posted in <#${created.channelId}> for ${discordTime(startsAt, 'F')}.`);
      return;
    }

    if (sub === 'list') {
      const events = ctx.store.upcomingEvents(guildId);
      const lines = events.map((e) => {
        const going = ctx.store.getRsvps(e.id).going.length;
        const link = e.channelId && e.messageId ? ` · [post](https://discord.com/channels/${guildId}/${e.channelId}/${e.messageId})` : '';
        return `**#${e.id} ${e.title}** — ${discordTime(e.startsAt, 'f')} (${discordTime(e.startsAt)}) · ${going} going${link}`;
      });
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.brand)
            .setTitle('Upcoming clan events')
            .setDescription(events.length ? clampLines(lines) : 'Nothing scheduled. Create one with `/event create`.'),
        ],
      });
      return;
    }

    if (sub === 'cancel') {
      const id = interaction.options.getInteger('id', true);
      const existing = ctx.store.getEvent(id);
      const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
      if (existing && existing.createdBy !== interaction.user.id && !canManage) {
        throw new UserError('Only the event creator or members with Manage Events can cancel it.');
      }
      const cancelled = await cancelClanEvent(ctx, id);
      await interaction.reply({ content: `Event #${cancelled.id} "${cancelled.title}" was cancelled.`, flags: MessageFlags.Ephemeral });
    }
  },
};
