import { ChannelType, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { AppContext } from '../../context.js';
import { REPEAT_DAYS, UserError, cancelClanEvent, createClanEvent, repeatText, setClanEventRepeat } from '../../services/clan.js';
import { discordTime, parseEnd, parseWhen } from '../../time.js';
import type { Command } from '../command.js';
import { COLORS, clampLines } from '../embeds.js';

const REPEAT_CHOICES = REPEAT_DAYS.map((days) => ({ name: repeatText(days).replace(/^e/, 'E'), value: days as number }));

/** Only whoever created an event, or a member with Manage Events, may cancel it or change how it repeats. */
function assertMayManage(interaction: ChatInputCommandInteraction, ctx: AppContext, id: number, what: string): void {
  const existing = ctx.store.getEvent(id);
  const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageEvents) ?? false;
  if (existing && existing.createdBy !== interaction.user.id && !canManage) throw new UserError(`Only the event creator or members with Manage Events can ${what}.`);
}

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
        .addStringOption((o) =>
          o.setName('ends').setDescription('Optional end: a length after the start ("2h", "90m") or a time ("2026-11-02 22:00" UTC)').setMaxLength(40),
        )
        .addStringOption((o) => o.setName('description').setDescription('Details, requirements, etc.').setMaxLength(2000))
        .addIntegerOption((o) =>
          o
            .setName('repeat')
            .setDescription('Post it again with fresh RSVP buttons once it is over, at the same time of day')
            .addChoices(...REPEAT_CHOICES),
        )
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
        .addIntegerOption((o) => o.setName('id').setDescription('Event number').setRequired(true).setMinValue(1))
        .addBooleanOption((o) => o.setName('series').setDescription('For a repeating event: also stop it from repeating (default: only this round is cancelled)')),
    )
    .addSubcommand((s) =>
      s
        .setName('repeat')
        .setDescription('Make an event repeat, change how often, or stop it (creator or event managers only)')
        .addIntegerOption((o) => o.setName('id').setDescription('Event number').setRequired(true).setMinValue(1))
        .addIntegerOption((o) =>
          o
            .setName('every')
            .setDescription('How often it is posted again')
            .setRequired(true)
            .addChoices({ name: 'Never (stop repeating)', value: 0 }, ...REPEAT_CHOICES),
        ),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const when = interaction.options.getString('when', true);
      const startsAt = parseWhen(when);
      if (startsAt === null) throw new UserError(`I couldn't read "${when}" as a time. Try "2h", "1d 4h" or "2026-11-02 20:00".`);
      const ends = interaction.options.getString('ends');
      const endsAt = ends ? parseEnd(ends, startsAt) : null;
      if (ends && endsAt === null) throw new UserError(`I couldn't read "${ends}" as an end. Try a length like "2h" (after the start) or "2026-11-02 22:00".`);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const channelId =
        interaction.options.getChannel('channel')?.id ??
        ctx.store.getSettings(guildId).announcementsChannelId ??
        interaction.channelId;
      const created = await createClanEvent(ctx, {
        title: interaction.options.getString('title', true),
        description: interaction.options.getString('description'),
        startsAt,
        endsAt,
        createdBy: interaction.user.id,
        channelId,
        repeatDays: interaction.options.getInteger('repeat'),
      });
      const repeats = created.repeatDays ? ` It repeats ${repeatText(created.repeatDays)}: the next round is posted once this one is over.` : '';
      await interaction.editReply(`Event #${created.id} posted in <#${created.channelId}> for ${discordTime(startsAt, 'F')}${created.endsAt ? `, ending ${discordTime(created.endsAt, 'F')}` : ''}.${repeats}`);
      return;
    }

    if (sub === 'list') {
      const events = ctx.store.upcomingEvents(guildId);
      const lines = events.map((e) => {
        const going = ctx.store.getRsvps(e.id).going.length;
        const link = e.channelId && e.messageId ? ` · [post](https://discord.com/channels/${guildId}/${e.channelId}/${e.messageId})` : '';
        const running = e.endsAt !== null && e.startsAt <= Date.now();
        const when = running ? `🟢 live, ends ${discordTime(e.endsAt!)}` : `${discordTime(e.startsAt, 'f')} (${discordTime(e.startsAt)})${e.endsAt ? ` → ${discordTime(e.endsAt, 't')}` : ''}`;
        return `**#${e.id} ${e.title}** — ${when}${e.repeatDays ? ` · 🔁 ${repeatText(e.repeatDays)}` : ''} · ${going} going${link}`;
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
      assertMayManage(interaction, ctx, id, 'cancel it');
      const stopSeries = interaction.options.getBoolean('series') ?? false;
      const before = ctx.store.getEvent(id);
      const cancelled = await cancelClanEvent(ctx, id, { stopSeries });
      // What the repetition looked like before the cancel: `series:True` has cleared it by now.
      const repeated = before?.repeatDays ?? null;
      const note = !repeated
        ? ''
        : stopSeries
          ? ' It no longer repeats.'
          : ` Only this round: it repeats ${repeatText(repeated)}, so the next one is posted when this one's time has passed. \`/event repeat id:${cancelled.id} every:Never\` stops that.`;
      await interaction.reply({ content: `Event #${cancelled.id} "${cancelled.title}" was cancelled.${note}`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'repeat') {
      const id = interaction.options.getInteger('id', true);
      assertMayManage(interaction, ctx, id, 'change how it repeats');
      const every = interaction.options.getInteger('every', true);
      const changed = await setClanEventRepeat(ctx, id, every === 0 ? null : every);
      const which = changed.id === id ? `Event #${changed.id}` : `Event #${changed.id} (the newest round of #${id})`;
      await interaction.reply({
        content: changed.repeatDays
          ? `${which} "${changed.title}" now repeats ${repeatText(changed.repeatDays)}: the next round is posted once it is over, at the same time of day (${ctx.config.CLAN_TIMEZONE}).`
          : `${which} "${changed.title}" no longer repeats.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};
