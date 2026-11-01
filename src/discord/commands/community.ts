import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { inactivityReport } from '../../activity/service.js';
import { assertValidBirthday, daysUntil, formatBirthday, MONTHS } from '../../birthdays/service.js';
import { endGiveaway, rerollGiveaway, startGiveaway } from '../../giveaways/service.js';
import { LABS, addResearch, finishResearch, listResearch, postResearchBoard, removeResearch, updateResearch } from '../../research/service.js';
import { addSelfRole, postRolesPanel, removeSelfRole } from '../../selfroles/service.js';
import { UserError } from '../../services/clan.js';
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

/** The parts of /research that change the board are for staff (Manage Messages); listing it is for everyone. */
const canManage = (perms: { has(p: bigint): boolean } | null) => perms?.has(PermissionFlagsBits.ManageMessages) ?? false;

export const research: Command = {
  data: new SlashCommandBuilder()
    .setName('research')
    .setDescription('The dojo research board: what the clan researches and what it still needs')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Staff: add a research to the board')
        .addStringOption((o) => o.setName('name').setDescription('e.g. "Kuva Nukor" or "Vauban"').setRequired(true).setMaxLength(100))
        .addStringOption((o) => o.setName('lab').setDescription('Lab').addChoices(...LABS.map((l) => ({ name: l, value: l }))))
        .addStringOption((o) => o.setName('needs').setDescription('What is still missing, e.g. "Forma 2, Nitain 10"').setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s
        .setName('update')
        .setDescription('Staff: change what a research still needs')
        .addIntegerOption((o) => o.setName('id').setDescription('Number on the board').setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName('needs').setDescription('What is still missing (empty: nothing)').setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s.setName('done').setDescription('Staff: mark a research as finished').addIntegerOption((o) => o.setName('id').setDescription('Number on the board').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Staff: take a research off the board').addIntegerOption((o) => o.setName('id').setDescription('Number on the board').setRequired(true).setMinValue(1)),
    )
    .addSubcommand((s) =>
      s
        .setName('board')
        .setDescription('Staff: post the live board in a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true).addChannelTypes(...TEXT_CHANNELS)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('What the clan is researching right now'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const open = listResearch(ctx).filter((r) => r.doneAt === null);
      const lines = open.map((r) => `**#${r.id} ${r.name}**${r.lab ? ` · ${r.lab}` : ''}${r.needs ? `\nNeeds: ${r.needs}` : ''}`);
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('🔬 Dojo research').setDescription(lines.length ? clampLines(lines) : 'Nothing is being researched right now.')],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!canManage(interaction.memberPermissions)) throw new UserError('Only staff (Manage Messages) can change the research board.');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const id = interaction.options.getInteger('id') ?? 0;
    if (sub === 'add') {
      const r = await addResearch(ctx, { name: interaction.options.getString('name', true), lab: interaction.options.getString('lab'), needs: interaction.options.getString('needs'), addedBy: interaction.user.id });
      await interaction.editReply(`Research **#${r.id} ${r.name}** added.`);
    } else if (sub === 'update') {
      const r = await updateResearch(ctx, id, interaction.options.getString('needs'));
      await interaction.editReply(`**#${r.id} ${r.name}** now needs: ${r.needs ?? 'nothing'}.`);
    } else if (sub === 'done') {
      const r = await finishResearch(ctx, id);
      await interaction.editReply(`**${r.name}** marked as finished.`);
    } else if (sub === 'remove') {
      await removeResearch(ctx, id);
      await interaction.editReply(`Research #${id} removed.`);
    } else {
      const url = await postResearchBoard(ctx, interaction.options.getChannel('channel', true).id);
      await interaction.editReply(`Research board posted: ${url}`);
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
