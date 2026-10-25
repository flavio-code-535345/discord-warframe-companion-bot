import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { AppContext } from '../../context.js';
import { levelingOn, syncLevelRoles } from '../../leveling/service.js';
import { levelOf, progressBar, progressOf, xpForLevel } from '../../leveling/xp.js';
import { UserError } from '../../services/clan.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

const PAGE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];
const fmt = (n: number) => n.toLocaleString('en-US');

function requireOn(ctx: AppContext): void {
  if (!levelingOn(ctx)) throw new UserError('Leveling is switched off on this server.');
}

export const rank: Command = {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show your level and XP (or another member\'s)')
    .addUserOption((o) => o.setName('member').setDescription('Member to look up (default: you)'))
    .toJSON(),

  async execute(interaction, ctx) {
    requireOn(ctx);
    const user = interaction.options.getUser('member') ?? interaction.user;
    if (user.bot) throw new UserError('Bots don\'t level up.');
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const row = ctx.store.getMemberXp(guildId, user.id);
    const p = progressOf(row?.xp ?? 0);
    const position = ctx.store.xpPosition(guildId, user.id);
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor({ name: (await interaction.guild?.members.fetch(user.id).catch(() => null))?.displayName ?? user.username, iconURL: user.displayAvatarURL() })
      .addFields(
        { name: 'Level', value: `**${p.level}**`, inline: true },
        { name: 'Rank', value: position ? `#${position}` : '–', inline: true },
        { name: 'Messages', value: fmt(row?.messages ?? 0), inline: true },
        { name: `Progress to level ${p.level + 1}`, value: `${progressBar(p.into / p.needed)}\n${fmt(p.into)} / ${fmt(p.needed)} XP · ${fmt(row?.xp ?? 0)} XP in total` },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

export const leaderboard: Command = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('The most active members by level')
    .addIntegerOption((o) => o.setName('page').setDescription('Page (10 members each)').setMinValue(1))
    .toJSON(),

  async execute(interaction, ctx) {
    requireOn(ctx);
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const total = ctx.store.countXpMembers(guildId);
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const page = Math.min(interaction.options.getInteger('page') ?? 1, pages);
    const rows = ctx.store.topXp(guildId, PAGE, (page - 1) * PAGE);
    const lines = rows.map((r, i) => {
      const n = (page - 1) * PAGE + i;
      return `${MEDALS[n] ?? `**${n + 1}.**`} <@${r.userId}> · level **${levelOf(r.xp)}** · ${fmt(r.xp)} XP`;
    });
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('🏆 Leaderboard')
      .setDescription(lines.join('\n') || 'Nobody has earned XP yet. Start talking!')
      .setFooter({ text: `Page ${page}/${pages} · ${total} members ranked` });
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

/** Staff controls for the leveling system. */
export const xp: Command = {
  data: new SlashCommandBuilder()
    .setName('xp')
    .setDescription('Staff: adjust XP and choose where XP is earned')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('give')
        .setDescription('Add XP to a member (negative takes it away)')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('XP to add or remove').setRequired(true).setMinValue(-1_000_000).setMaxValue(1_000_000)),
    )
    .addSubcommand((s) =>
      s
        .setName('setlevel')
        .setDescription('Set a member to exactly this level')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(0).setMaxValue(200)),
    )
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Reset a member to zero XP and remove their level role')
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('ignore')
        .setDescription('Toggle whether a channel (text or voice) earns XP')
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('sync').setDescription('Re-apply everyone\'s level role (after creating or renaming the Level roles)'))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    if (!guild) throw new UserError('Use this in the server.');

    if (sub === 'ignore') {
      const channel = interaction.options.getChannel('channel', true);
      const ignored = ctx.store.toggleXpIgnored(guildId, channel.id);
      await interaction.editReply(ignored ? `<#${channel.id}> no longer earns XP.` : `<#${channel.id}> earns XP again.`);
      return;
    }

    if (sub === 'sync') {
      let changed = 0;
      for (const row of ctx.store.topXp(guildId, 10_000)) {
        const member = await guild.members.fetch(row.userId).catch(() => null);
        if (member && (await syncLevelRoles(guild, member, levelOf(row.xp)))) changed++;
      }
      await interaction.editReply(`Level roles checked for everyone with XP; ${changed} members got a new role.`);
      return;
    }

    const user = interaction.options.getUser('member', true);
    if (user.bot) throw new UserError('Bots don\'t level up.');
    const member = await guild.members.fetch(user.id).catch(() => null);

    if (sub === 'reset') {
      ctx.store.resetXp(guildId, user.id);
      if (member) await syncLevelRoles(guild, member, 0);
      await interaction.editReply(`Reset ${user}. Their level role was removed.`);
      return;
    }

    const current = ctx.store.getMemberXp(guildId, user.id)?.xp ?? 0;
    const target = sub === 'give' ? Math.max(0, current + interaction.options.getInteger('amount', true)) : xpForLevel(interaction.options.getInteger('level', true));
    ctx.store.setXp(guildId, user.id, target);
    const level = levelOf(target);
    if (member) await syncLevelRoles(guild, member, level);
    await interaction.editReply({ content: `${user} now has ${fmt(target)} XP (level ${level}).`, allowedMentions: { parse: [] } });
  },
};

export const LEVEL_COMMANDS: Command[] = [rank, leaderboard, xp];
