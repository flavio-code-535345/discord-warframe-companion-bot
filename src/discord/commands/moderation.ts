import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type GuildTextBasedChannel,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { MAX_PURGE, OLD_DELETE_CAP, type PurgeFilter, parseAmount, runPurge } from '../../moderation/purge.js';
import { assertCanAct, auditReason, lockChannel, modContext, modLog, notifyUser, unlockChannel } from '../../moderation/service.js';
import { UserError } from '../../services/clan.js';
import { discordTime, formatDuration, parseDuration } from '../../time.js';
import type { Command } from '../command.js';
import { COLORS, clampLines } from '../embeds.js';

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const MAX_TIMEOUT_MS = 28 * 24 * 3_600_000;
const reply = (interaction: ChatInputCommandInteraction, content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

/** Discord already hides these commands from members without the permission; this also guards against admins re-mapping them. */
function requirePerm(interaction: ChatInputCommandInteraction, perm: bigint, label: string) {
  if (!interaction.memberPermissions?.has(perm)) throw new UserError(`You need the ${label} permission for this.`);
}

function currentTextChannel(interaction: ChatInputCommandInteraction | ButtonInteraction): GuildTextBasedChannel {
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new UserError('Use this in a server text channel.');
  return channel as GuildTextBasedChannel;
}

// --- purge ---

interface PendingPurge {
  userId: string;
  channelId: string;
  amount: number | 'all';
  filter: PurgeFilter;
  expires: number;
}
const pendingPurges = new Map<string, PendingPurge>();

const describeFilter = (f: PurgeFilter) =>
  [f.userId ? `from <@${f.userId}>` : null, f.botsOnly ? 'from bots' : null, f.includePinned ? 'including pinned' : null].filter(Boolean).join(', ');

async function executePurge(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  ctx: AppContext,
  channel: GuildTextBasedChannel,
  amount: number | 'all',
  filter: PurgeFilter,
) {
  const result = await runPurge(channel, amount, filter, (n) =>
    interaction.editReply({ content: `🧹 Deleting… ${n} so far`, components: [] }).then(() => {}, () => {}),
  );
  const notes = [
    result.oldDeleted ? `${result.oldDeleted} were older than 14 days and removed one by one` : null,
    result.capped ? `stopped after ${OLD_DELETE_CAP} older messages; run /purge again to continue` : null,
  ].filter(Boolean);
  await interaction.editReply({
    content: `🧹 Deleted **${result.deleted}** message${result.deleted === 1 ? '' : 's'} in ${channel}${notes.length ? ` (${notes.join('; ')})` : ''}.`,
    components: [],
  });
  await modLog(ctx, {
    action: 'Purge',
    moderator: interaction.user,
    fields: [
      { name: 'Channel', value: `${channel}` },
      { name: 'Deleted', value: String(result.deleted) },
      { name: 'Requested', value: `${amount === 'all' ? 'all' : amount}${describeFilter(filter) ? ` · ${describeFilter(filter)}` : ''}` },
    ],
  });
}

export const purge: Command = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete recent messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addStringOption((o) => o.setName('amount').setDescription(`How many (1-${MAX_PURGE}) or "all"`).setRequired(true).setAutocomplete(true))
    .addUserOption((o) => o.setName('user').setDescription('Only messages from this member'))
    .addBooleanOption((o) => o.setName('bots_only').setDescription('Only messages from bots'))
    .addBooleanOption((o) => o.setName('include_pinned').setDescription('Also delete pinned messages (default: keep them)'))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.ManageMessages, 'Manage Messages');
    const amount = parseAmount(interaction.options.getString('amount', true));
    if (amount === null) throw new UserError(`Amount must be a number from 1 to ${MAX_PURGE}, or "all".`);
    const channel = currentTextChannel(interaction);
    const filter: PurgeFilter = {
      userId: interaction.options.getUser('user')?.id,
      botsOnly: interaction.options.getBoolean('bots_only') ?? undefined,
      includePinned: interaction.options.getBoolean('include_pinned') ?? undefined,
    };

    // Small purges run straight away; "all" and big ones ask first.
    if (amount !== 'all' && amount <= 100) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await executePurge(interaction, ctx, channel, amount, filter);
      return;
    }
    const token = randomBytes(6).toString('hex');
    pendingPurges.set(token, { userId: interaction.user.id, channelId: channel.id, amount, filter, expires: Date.now() + 120_000 });
    const what = amount === 'all' ? '**every message**' : `the last **${amount}** messages`;
    const filterText = describeFilter(filter);
    await interaction.reply({
      content: `⚠️ Delete ${what}${filterText ? ` (${filterText})` : ''} in ${channel}? This can't be undone.`,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`purge:${token}:confirm`).setLabel('Delete').setEmoji('🧹').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`purge:${token}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  },

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().trim();
    const suggestions = ['10', '25', '50', '100', '500', 'all'];
    const list = typed && !suggestions.includes(typed) ? [typed, ...suggestions] : suggestions;
    await interaction.respond(list.filter((s) => parseAmount(s) !== null).slice(0, 25).map((s) => ({ name: s === 'all' ? 'all (every message)' : s, value: s })));
  },
};

/** Handles `purge:<token>:<confirm|cancel>` buttons from the purge confirmation. */
export async function handlePurgeButton(interaction: ButtonInteraction, ctx: AppContext, token: string, action: string): Promise<void> {
  const pending = pendingPurges.get(token);
  if (!pending || pending.expires < Date.now()) {
    pendingPurges.delete(token);
    await interaction.update({ content: 'That purge request expired. Run /purge again.', components: [] });
    return;
  }
  if (pending.userId !== interaction.user.id) throw new UserError('Only the moderator who asked can confirm this.');
  pendingPurges.delete(token);
  if (action !== 'confirm') {
    await interaction.update({ content: 'Purge cancelled.', components: [] });
    return;
  }
  await interaction.update({ content: '🧹 Deleting…', components: [] });
  const channel = currentTextChannel(interaction);
  if (channel.id !== pending.channelId) throw new UserError('Confirm the purge in the channel where you started it.');
  await executePurge(interaction, ctx, channel, pending.amount, pending.filter);
}

// --- member actions ---

export const warn: Command = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Warn a member (recorded, and DMed to them)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(500))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.ModerateMembers, 'Timeout Members');
    const m = await modContext(interaction, ctx);
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const target = await m.guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError(`${user.username} isn't in the server.`);
    assertCanAct(m, target, 'warn');
    ctx.store.addWarning({ guildId: m.guild.id, userId: user.id, moderatorId: interaction.user.id, reason });
    const total = ctx.store.listWarnings(m.guild.id, user.id).length;
    const dmed = await notifyUser(user, m.guild, `⚠️ You received a warning: ${reason}`);
    await modLog(ctx, { action: 'Warn', moderator: interaction.user, target: user, reason, fields: [{ name: 'Total warnings', value: String(total) }] });
    await reply(interaction, `⚠️ Warned ${user} (warning #${total}).${dmed ? '' : ' Their DMs are closed, so they were not notified.'}`);
  },
};

export const warnings: Command = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription("Show or clear a member's warnings")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addBooleanOption((o) => o.setName('clear').setDescription('Delete all of their warnings'))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.ModerateMembers, 'Timeout Members');
    const user = interaction.options.getUser('user', true);
    const guildId = ctx.config.DISCORD_GUILD_ID;
    if (interaction.options.getBoolean('clear')) {
      const n = ctx.store.clearWarnings(guildId, user.id);
      await modLog(ctx, { action: 'Warnings cleared', moderator: interaction.user, target: user, fields: [{ name: 'Removed', value: String(n) }] });
      await reply(interaction, `Cleared ${n} warning${n === 1 ? '' : 's'} for ${user}.`);
      return;
    }
    const list = ctx.store.listWarnings(guildId, user.id);
    const embed = new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle(`Warnings for ${user.username} (${list.length})`)
      .setDescription(list.length ? clampLines(list.map((w) => `**#${w.id}** ${discordTime(w.createdAt, 'D')} by <@${w.moderatorId}>: ${w.reason}`)) : 'No warnings. A model Tenno.');
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  },
};

export const timeout: Command = {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Temporarily stop a member from chatting and talking')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 1d (max 28d)').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.ModerateMembers, 'Timeout Members');
    const m = await modContext(interaction, ctx);
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason');
    const ms = parseDuration(interaction.options.getString('duration', true));
    if (!ms || ms > MAX_TIMEOUT_MS) throw new UserError('Duration must be like 10m, 1h or 2d, and at most 28 days.');
    const target = await m.guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError(`${user.username} isn't in the server.`);
    assertCanAct(m, target, 'time out');
    if (!target.moderatable) throw new UserError(`Ordis can't time out ${target.displayName}.`);
    await target.timeout(ms, auditReason(interaction.user, reason));
    const dmed = await notifyUser(user, m.guild, `🔇 You were timed out for ${formatDuration(ms)}${reason ? `: ${reason}` : '.'}`);
    await modLog(ctx, { action: 'Timeout', moderator: interaction.user, target: user, reason, fields: [{ name: 'Duration', value: `${formatDuration(ms)} (until ${discordTime(Date.now() + ms, 'f')})` }] });
    await reply(interaction, `🔇 Timed out ${user} for ${formatDuration(ms)}.${dmed ? '' : ' (DMs closed, not notified.)'}`);
  },

  async autocomplete(interaction) {
    const typed = interaction.options.getFocused().trim();
    const presets = ['60s', '5m', '10m', '1h', '6h', '1d', '3d', '1w', '28d'];
    const list = typed && parseDuration(typed) && !presets.includes(typed) ? [typed, ...presets] : presets;
    await interaction.respond(list.map((d) => ({ name: d, value: d })));
  },
};

export const untimeout: Command = {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription("Lift a member's timeout")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.ModerateMembers, 'Timeout Members');
    const m = await modContext(interaction, ctx);
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason');
    const target = await m.guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError(`${user.username} isn't in the server.`);
    if (!target.isCommunicationDisabled()) throw new UserError(`${target.displayName} isn't timed out.`);
    await target.timeout(null, auditReason(interaction.user, reason));
    await modLog(ctx, { action: 'Timeout removed', moderator: interaction.user, target: user, reason });
    await reply(interaction, `🔊 ${user} can talk again.`);
  },
};

export const kick: Command = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Remove a member from the server (they can rejoin with an invite)')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.KickMembers, 'Kick Members');
    const m = await modContext(interaction, ctx);
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason');
    const target = await m.guild.members.fetch(user.id).catch(() => null);
    if (!target) throw new UserError(`${user.username} isn't in the server.`);
    assertCanAct(m, target, 'kick');
    if (!target.kickable) throw new UserError(`Ordis can't kick ${target.displayName}.`);
    // DM first: once they're gone, the bot shares no server with them and can't message them.
    const dmed = await notifyUser(user, m.guild, `👢 You were kicked${reason ? `: ${reason}` : '.'}`);
    await target.kick(auditReason(interaction.user, reason));
    await modLog(ctx, { action: 'Kick', moderator: interaction.user, target: user, reason });
    await reply(interaction, `👢 Kicked ${user.username}.${dmed ? '' : ' (DMs closed, not notified.)'}`);
  },
};

export const ban: Command = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user from the server')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500))
    .addIntegerOption((o) =>
      o
        .setName('delete_messages')
        .setDescription('Also delete their recent messages')
        .addChoices(
          { name: "Don't delete any", value: 0 },
          { name: 'Last hour', value: 3600 },
          { name: 'Last 24 hours', value: 86400 },
          { name: 'Last 7 days', value: 604800 },
        ),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.BanMembers, 'Ban Members');
    const m = await modContext(interaction, ctx);
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason');
    const target = await m.guild.members.fetch(user.id).catch(() => null);
    if (target) {
      assertCanAct(m, target, 'ban');
      if (!target.bannable) throw new UserError(`Ordis can't ban ${target.displayName}.`);
    }
    const dmed = target ? await notifyUser(user, m.guild, `🔨 You were banned${reason ? `: ${reason}` : '.'}`) : false;
    await m.guild.members.ban(user.id, {
      deleteMessageSeconds: interaction.options.getInteger('delete_messages') ?? 0,
      reason: auditReason(interaction.user, reason),
    });
    await modLog(ctx, { action: 'Ban', moderator: interaction.user, target: user, reason });
    await reply(interaction, `🔨 Banned ${user.username}.${target && !dmed ? ' (DMs closed, not notified.)' : ''}`);
  },
};

export const unban: Command = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Lift a ban')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user').setDescription('Banned user').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(500))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.BanMembers, 'Ban Members');
    const m = await modContext(interaction, ctx);
    const id = interaction.options.getString('user', true).trim();
    const reason = interaction.options.getString('reason');
    const entry = await m.guild.bans.fetch(id).catch(() => null);
    if (!entry) throw new UserError('That user is not banned. Pick one from the list.');
    await m.guild.members.unban(id, auditReason(interaction.user, reason));
    await modLog(ctx, { action: 'Unban', moderator: interaction.user, target: entry.user, reason });
    await reply(interaction, `🕊️ Unbanned ${entry.user.username}.`);
  },

  async autocomplete(interaction, ctx) {
    const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
    const q = interaction.options.getFocused().toLowerCase();
    const bans = await guild.bans.fetch().catch(() => null);
    const list = [...(bans?.values() ?? [])].filter((b) => !q || b.user.username.toLowerCase().includes(q) || b.user.id.includes(q));
    await interaction.respond(list.slice(0, 25).map((b) => ({ name: `${b.user.username} (${b.user.id})`.slice(0, 100), value: b.user.id })));
  },
};

// --- channel actions ---

export const slowmode: Command = {
  data: new SlashCommandBuilder()
    .setName('slowmode')
    .setDescription('Limit how often members can post in a channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption((o) => o.setName('interval').setDescription('"off", or e.g. 5s, 30s, 2m (max 6h)').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(...TEXT_CHANNELS))
    .toJSON(),

  async execute(interaction, ctx) {
    requirePerm(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
    const raw = interaction.options.getString('interval', true).trim().toLowerCase();
    const ms = raw === 'off' || raw === '0' ? 0 : parseDuration(raw);
    if (ms === null || ms > 21_600_000) throw new UserError('Interval must be "off" or a duration like 10s, 1m or 1h (max 6h).');
    const picked = interaction.options.getChannel('channel');
    const channel = (picked ? await interaction.guild!.channels.fetch(picked.id) : currentTextChannel(interaction)) as GuildTextBasedChannel;
    if (!('setRateLimitPerUser' in channel)) throw new UserError('Slowmode only works in text channels.');
    await channel.setRateLimitPerUser(Math.round(ms / 1000), auditReason(interaction.user, null));
    await modLog(ctx, { action: 'Slowmode', moderator: interaction.user, fields: [{ name: 'Channel', value: `${channel}` }, { name: 'Interval', value: ms ? formatDuration(ms) : 'off' }] });
    await reply(interaction, ms ? `🐢 Slowmode in ${channel}: one message per ${Math.round(ms / 1000)}s.` : `Slowmode is off in ${channel}.`);
  },
};

function lockCommand(name: 'lock' | 'unlock'): Command {
  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(name === 'lock' ? 'Stop members from posting in a channel (moderators still can)' : 'Reopen a locked channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .addChannelOption((o) => o.setName('channel').setDescription('Defaults to this channel').addChannelTypes(...TEXT_CHANNELS))
      .addStringOption((o) => o.setName('reason').setDescription('Shown in the channel').setMaxLength(300))
      .toJSON(),

    async execute(interaction, ctx) {
      requirePerm(interaction, PermissionFlagsBits.ManageChannels, 'Manage Channels');
      const picked = interaction.options.getChannel('channel');
      const channel = (picked ? await interaction.guild!.channels.fetch(picked.id) : currentTextChannel(interaction)) as GuildTextBasedChannel;
      const reason = interaction.options.getString('reason');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const audit = auditReason(interaction.user, reason);
      const changed = name === 'lock' ? await lockChannel(ctx, channel, audit) : await unlockChannel(ctx, channel, audit);
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(name === 'lock' ? 0x6b7280 : COLORS.success)
            .setDescription(name === 'lock' ? `🔒 This channel is locked${reason ? `: ${reason}` : '.'}` : `🔓 This channel is open again${reason ? `: ${reason}` : '.'}`),
        ],
      });
      await modLog(ctx, { action: name === 'lock' ? 'Lock' : 'Unlock', moderator: interaction.user, reason, fields: [{ name: 'Channel', value: `${channel}` }] });
      await interaction.editReply(`${name === 'lock' ? '🔒 Locked' : '🔓 Unlocked'} ${channel} (${changed} permission rule${changed === 1 ? '' : 's'} ${name === 'lock' ? 'changed' : 'restored'}).`);
    },
  };
}

export const lock = lockCommand('lock');
export const unlock = lockCommand('unlock');

export const MODERATION_COMMANDS: Command[] = [purge, warn, warnings, timeout, untimeout, kick, ban, unban, slowmode, lock, unlock];
