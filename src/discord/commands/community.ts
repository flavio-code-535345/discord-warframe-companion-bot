import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { inactivityReport } from '../../activity/service.js';
import { assertValidBirthday, daysUntil, formatBirthday, MONTHS } from '../../birthdays/service.js';
import { endGiveaway, rerollGiveaway, startGiveaway } from '../../giveaways/service.js';
import { addSelfRole, postRolesPanel, removeSelfRole } from '../../selfroles/service.js';
import { UserError } from '../../errors.js';
import { discordTime, parseWhen } from '../../time.js';
import type { Command } from '../command.js';
import { COLORS, clampLines } from '../embeds.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

export const roles: Command = {
  data: new SlashCommandBuilder()
    .setName('roles')
    .setDescription('The self-assign role menu (platform, region, pings...)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add a role to the menu, or change its entry')
        .addRoleOption((o) => o.setName('role').setDescription('A plain role without permissions').setRequired(true))
        .addStringOption((o) => o.setName('group').setDescription('Heading it is listed under, e.g. "Platform" or "Pings"').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('label').setDescription('Button text (default: the role name)').setMaxLength(80))
        .addStringOption((o) => o.setName('emoji').setDescription('An emoji for the button').setMaxLength(60))
        .addStringOption((o) => o.setName('description').setDescription('A few words on what it is for').setMaxLength(100)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Take a role off the menu').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('post')
        .setDescription('Post the menu in a channel (moves it if it was posted before)')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show what is in the menu'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const list = ctx.store.listSelfRoles(ctx.config.DISCORD_GUILD_ID);
      const lines = list.map((r) => `**${r.group}** · ${r.emoji ? `${r.emoji} ` : ''}${r.label} → <@&${r.roleId}>`);
      await interaction.reply({ content: lines.length ? lines.join('\n') : 'The menu is empty. Add a role with `/roles add`.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'add') {
      const entry = await addSelfRole(ctx, {
        roleId: interaction.options.getRole('role', true).id,
        group: interaction.options.getString('group', true),
        label: interaction.options.getString('label'),
        emoji: interaction.options.getString('emoji'),
        description: interaction.options.getString('description'),
      });
      await interaction.editReply(`**${entry.label}** is in the menu under ${entry.group}. Post it with \`/roles post\` if you haven't yet.`);
    } else if (sub === 'remove') {
      const ok = await removeSelfRole(ctx, interaction.options.getRole('role', true).id);
      await interaction.editReply(ok ? 'Removed from the menu.' : 'That role was not in the menu.');
    } else {
      const url = await postRolesPanel(ctx, interaction.options.getChannel('channel', true).id);
      await interaction.editReply(`Role menu posted: ${url}`);
    }
  },
};

export const inactive: Command = {
  data: new SlashCommandBuilder()
    .setName('inactive')
    .setDescription('Leadership: members who have not written or been in voice for a while')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addIntegerOption((o) => o.setName('days').setDescription('Silent for at least this many days (default 30)').setMinValue(1).setMaxValue(365))
    .toJSON(),

  async execute(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const days = interaction.options.getInteger('days') ?? 30;
    const report = await inactivityReport(ctx, days);
    const lines = report.members.map((m) => `<@${m.userId}> · ${m.lastSeen ? `last seen ${discordTime(m.lastSeen)}` : 'not seen since tracking began'}${m.joinedAt ? ` · joined ${discordTime(m.joinedAt, 'D')}` : ''}`);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`💤 Silent for ${days}+ days: ${report.members.length} of ${report.checked}`)
          .setDescription(lines.length ? clampLines(lines) : 'Everyone has been around. 🐀')
          .setFooter({ text: `Messages and voice since ${new Date(report.trackingSince).toISOString().slice(0, 10)}; nothing else is recorded` }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};

export const giveaway: Command = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Give something away to the clan: plat, prime parts, a riven...')
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Start a giveaway with an Enter button')
        .addStringOption((o) => o.setName('prize').setDescription('e.g. "Wisp Prime set" or "100 platinum"').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('duration').setDescription('How long it runs: "1h", "2d", "1d 12h"').setRequired(true).setMaxLength(30))
        .addIntegerOption((o) => o.setName('winners').setDescription('How many winners (default 1)').setMinValue(1).setMaxValue(10))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (default: here)').addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) =>
      s.setName('end').setDescription('End a giveaway now and draw the winners').addIntegerOption((o) => o.setName('id').setDescription('Giveaway number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('reroll')
        .setDescription('Draw a new winner among those who have not won yet')
        .addIntegerOption((o) => o.setName('id').setDescription('Giveaway number').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Giveaways that are running'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const open = ctx.store.openGiveaways(ctx.config.DISCORD_GUILD_ID);
      const lines = open.map((g) => `**#${g.id} ${g.prize}** · by <@${g.hostId}> · ends ${discordTime(g.endsAt)}${g.messageId ? ` · [post](https://discord.com/channels/${g.guildId}/${g.channelId}/${g.messageId})` : ''}`);
      await interaction.reply({ content: lines.length ? lines.join('\n') : 'No giveaways running.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }
    if (sub === 'start') {
      const duration = interaction.options.getString('duration', true);
      const endsAt = parseWhen(duration);
      if (endsAt === null) throw new UserError(`I couldn't read "${duration}" as a length. Try "1h", "2d" or "1d 12h".`);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const g = await startGiveaway(ctx, {
        channelId: interaction.options.getChannel('channel')?.id ?? interaction.channelId,
        hostId: interaction.user.id,
        prize: interaction.options.getString('prize', true),
        winners: interaction.options.getInteger('winners') ?? 1,
        endsAt,
      });
      await interaction.editReply(`Giveaway #${g.id} is running until ${discordTime(g.endsAt, 'f')}.`);
      return;
    }
    const id = interaction.options.getInteger('id', true);
    const g = ctx.store.getGiveaway(id);
    const staff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
    if (g && g.hostId !== interaction.user.id && !staff) throw new UserError('Only the host or staff can do that.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'end') {
      const ended = await endGiveaway(ctx, id);
      await interaction.editReply(`Giveaway #${id} ended: ${ended.winnerIds.length ? ended.winnerIds.map((w) => `<@${w}>`).join(', ') : 'nobody entered'}.`);
    } else {
      const winners = await rerollGiveaway(ctx, id);
      await interaction.editReply(`New winner: ${winners.map((w) => `<@${w}>`).join(', ')}.`);
    }
  },
};

export const birthday: Command = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Tell Ordis your birthday (day and month only) and get a shout-out on the day')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set your birthday')
        .addIntegerOption((o) => o.setName('month').setDescription('Month').setRequired(true).addChoices(...MONTHS.map((m, i) => ({ name: m, value: i + 1 }))))
        .addIntegerOption((o) => o.setName('day').setDescription('Day of the month').setRequired(true).setMinValue(1).setMaxValue(31)),
    )
    .addSubcommand((s) => s.setName('remove').setDescription('Forget your birthday'))
    .addSubcommand((s) => s.setName('list').setDescription('The next birthdays in the den'))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();
    if (sub === 'set') {
      const month = interaction.options.getInteger('month', true);
      const day = interaction.options.getInteger('day', true);
      assertValidBirthday(month, day);
      ctx.store.setBirthday(guildId, interaction.user.id, month, day);
      const where = ctx.store.getSettings(guildId).birthdayChannelId;
      await interaction.reply({ content: `Got it: **${formatBirthday({ month, day })}**.${where ? ` Ordis will wish you a happy birthday in <#${where}>.` : ''}`, flags: MessageFlags.Ephemeral });
    } else if (sub === 'remove') {
      const removed = ctx.store.removeBirthday(guildId, interaction.user.id);
      await interaction.reply({ content: removed ? 'Your birthday is forgotten.' : 'Ordis did not have your birthday.', flags: MessageFlags.Ephemeral });
    } else {
      const now = Date.now();
      const next = ctx.store
        .listBirthdays(guildId)
        .sort((a, b) => daysUntil(a, now) - daysUntil(b, now))
        .slice(0, 15)
        .map((b) => `**${formatBirthday(b)}** · <@${b.userId}>${daysUntil(b, now) === 0 ? ' 🎂 today!' : ''}`);
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('🎂 Upcoming birthdays').setDescription(next.length ? next.join('\n') : 'Nobody has set one yet. Use `/birthday set`.')],
        allowedMentions: { parse: [] },
      });
    }
  },
};
