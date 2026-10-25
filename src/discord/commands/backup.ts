import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { type RestoreOptions, currentState, planRestore, restoreBackup } from '../../backup/restore.js';
import { KEEP_AUTO_BACKUPS, summaryOf, takeBackup } from '../../backup/service.js';
import { type ServerBackup, parseBackup, summarize } from '../../backup/snapshot.js';
import type { AppContext } from '../../context.js';
import type { StoredBackup } from '../../db.js';
import { modLog } from '../../moderation/service.js';
import { UserError } from '../../services/clan.js';
import { discordTime } from '../../time.js';
import type { Command } from '../command.js';
import { COLORS, clampLines } from '../embeds.js';

const DOWNLOAD_LIMIT_BYTES = 9.5 * 1024 * 1024;
const kb = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function describe(b: StoredBackup): string {
  const s = summaryOf(b);
  return `**#${b.id}** ${discordTime(b.createdAt, 'f')} · ${b.auto ? 'auto' : 'manual'}${b.label ? ` · ${b.label}` : ''}\n-# ${s.roles} roles · ${s.channels} channels · ${s.emojis} emojis · ${s.bans} bans${s.messages ? ` · ${s.messages} messages` : ''} · ${kb(s.sizeBytes)}`;
}

function load(ctx: AppContext, id: number): { stored: StoredBackup; backup: ServerBackup } {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const stored = ctx.store.listBackups(guildId).find((b) => b.id === id);
  const data = ctx.store.getBackupData(guildId, id);
  if (!stored || !data) throw new UserError(`There is no backup #${id}. See /backup list.`);
  return { stored, backup: parseBackup(data) };
}

function requireAdmin(interaction: ChatInputCommandInteraction | ButtonInteraction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new UserError('Backups are for server administrators.');
}

interface PendingRestore {
  userId: string;
  backupId: number;
  opts: RestoreOptions;
  expires: number;
}
const pendingRestores = new Map<string, PendingRestore>();

export const backup: Command = {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Back up and restore the server (roles, channels, permissions, emojis, bans)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s
        .setName('create')
        .setDescription('Take a backup now')
        .addStringOption((o) => o.setName('label').setDescription('e.g. "before renovation"').setMaxLength(80)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Stored backups, newest first'))
    .addSubcommand((s) =>
      s
        .setName('info')
        .setDescription('What a backup contains')
        .addIntegerOption((o) => o.setName('id').setDescription('Backup').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('download')
        .setDescription('Get a backup as a file to keep somewhere safe')
        .addIntegerOption((o) => o.setName('id').setDescription('Backup').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('import')
        .setDescription('Add a downloaded backup file back into Ordis')
        .addAttachmentOption((o) => o.setName('file').setDescription('A .json file from /backup download').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('load')
        .setDescription('Restore the server from a backup (shows a preview first)')
        .addIntegerOption((o) => o.setName('id').setDescription('Backup').setRequired(true).setAutocomplete(true))
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('What to restore')
            .addChoices(
              { name: 'Missing only: recreate what was deleted, leave everything else (default)', value: 'missing' },
              { name: 'Full sync: also reset existing roles, channels and settings to the backup', value: 'sync' },
            ),
        )
        .addBooleanOption((o) => o.setName('bans').setDescription('Re-apply bans from the backup (default: yes)'))
        .addBooleanOption((o) => o.setName('messages').setDescription('Re-post saved messages into recreated channels (default: yes)')),
    )
    .addSubcommand((s) =>
      s
        .setName('delete')
        .setDescription('Delete a stored backup')
        .addIntegerOption((o) => o.setName('id').setDescription('Backup').setRequired(true).setAutocomplete(true)),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    requireAdmin(interaction);
    const sub = interaction.options.getSubcommand();
    const guildId = ctx.config.DISCORD_GUILD_ID;

    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const stored = await takeBackup(ctx, interaction.options.getString('label'), false);
      await interaction.editReply(`💾 Backup saved.\n${describe(stored)}\nKeep a copy outside the server with \`/backup download id:${stored.id}\`.`);
      return;
    }

    if (sub === 'list') {
      const list = ctx.store.listBackups(guildId);
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(`Server backups (${list.length})`)
        .setDescription(list.length ? clampLines(list.map(describe)) : 'No backups yet. `/backup create` takes one; Ordis also takes one automatically every day.')
        .setFooter({ text: `Automatic backups run daily; the newest ${KEEP_AUTO_BACKUPS} are kept. Manual ones stay until deleted.` });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'info') {
      const { stored, backup: data } = load(ctx, interaction.options.getInteger('id', true));
      const categories = data.channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
      const tree = categories.map((cat) => {
        const children = data.channels.filter((c) => c.parentId === cat.id).sort((a, b) => a.position - b.position);
        return `**${cat.name}**: ${children.map((c) => c.name).join(', ') || '—'}`;
      });
      const embed = new EmbedBuilder()
        .setColor(COLORS.brand)
        .setTitle(`Backup #${stored.id}${stored.label ? ` · ${stored.label}` : ''}`)
        .setDescription(`${describe(stored)}\nFrom server **${data.guild.name}** (\`${data.guild.id}\`). Messages ${data.includesMessages ? 'included' : 'not included (needs ENABLE_MESSAGE_CONTENT)'}.`)
        .addFields(
          { name: 'Channels', value: clampLines(tree, 1000) },
          {
            name: 'Roles',
            value: clampLines(
              [data.roles.filter((r) => !r.everyone && !r.managed).sort((a, b) => b.position - a.position).map((r) => r.name).join(', ')],
              1000,
            ),
          },
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'download') {
      const id = interaction.options.getInteger('id', true);
      const { stored } = load(ctx, id);
      const data = ctx.store.getBackupData(guildId, id)!;
      if (Buffer.byteLength(data) > DOWNLOAD_LIMIT_BYTES) throw new UserError('This backup is too large for a Discord upload.');
      const date = new Date(stored.createdAt).toISOString().slice(0, 10);
      await interaction.reply({
        content: `💾 Backup #${id}. Keep this file somewhere safe; \`/backup import\` brings it back, even on a new server.`,
        files: [new AttachmentBuilder(Buffer.from(data), { name: `ordis-backup-${id}-${date}.json` })],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === 'import') {
      const file = interaction.options.getAttachment('file', true);
      if (file.size > 25 * 1024 * 1024) throw new UserError('That file is too large to be an Ordis backup.');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const text = await fetch(file.url, { signal: AbortSignal.timeout(30_000) }).then((r) => r.text());
      let data: ServerBackup;
      try {
        data = parseBackup(text);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
      const stored = ctx.store.saveBackup({
        guildId,
        label: `imported: ${file.name}`.slice(0, 80),
        auto: false,
        summary: JSON.stringify(summarize(data, Buffer.byteLength(text))),
        data: text,
        createdAt: data.createdAt,
      });
      await interaction.editReply(`📥 Imported.\n${describe(stored)}\nRestore it with \`/backup load id:${stored.id}\`.`);
      return;
    }

    if (sub === 'delete') {
      const id = interaction.options.getInteger('id', true);
      if (!ctx.store.deleteBackup(guildId, id)) throw new UserError(`There is no backup #${id}.`);
      await interaction.reply({ content: `🗑️ Backup #${id} deleted.`, flags: MessageFlags.Ephemeral });
      return;
    }

    // load: preview, then confirm
    const id = interaction.options.getInteger('id', true);
    const { stored, backup: data } = load(ctx, id);
    const opts: RestoreOptions = {
      mode: (interaction.options.getString('mode') as RestoreOptions['mode'] | null) ?? 'missing',
      bans: interaction.options.getBoolean('bans') ?? true,
      messages: interaction.options.getBoolean('messages') ?? true,
    };
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = await ctx.client.guilds.fetch(guildId);
    const plan = planRestore(await currentState(guild), data, opts);
    const changes = plan.rolesCreate.length + plan.rolesUpdate.length + plan.channelsCreate.length + plan.channelsUpdate.length + plan.emojisCreate.length + plan.bansAdd;
    const list = (names: string[]) => (names.length ? clampLines([names.join(', ')], 900) : '—');
    const embed = new EmbedBuilder()
      .setColor(opts.mode === 'sync' ? COLORS.danger : COLORS.warn)
      .setTitle(`Restore preview: backup #${stored.id} (${opts.mode === 'sync' ? 'full sync' : 'missing only'})`)
      .setDescription(
        `${describe(stored)}\n\n${changes ? `Ordis will make **${changes}** change${changes === 1 ? '' : 's'}. Nothing gets deleted, and Ordis takes a fresh backup first so this can be undone.` : '✅ Nothing is missing: the server already matches this backup.'}`,
      )
      .addFields(
        { name: `Recreate roles (${plan.rolesCreate.length})`, value: list(plan.rolesCreate) },
        { name: `Recreate channels (${plan.channelsCreate.length})`, value: list(plan.channelsCreate) },
        ...(opts.mode === 'sync'
          ? [
              { name: `Reset roles (${plan.rolesUpdate.length})`, value: list(plan.rolesUpdate) },
              { name: `Reset channels (${plan.channelsUpdate.length})`, value: list(plan.channelsUpdate) },
            ]
          : []),
        { name: 'Emojis · bans · messages', value: `${plan.emojisCreate.length} emojis · ${plan.bansAdd} bans · ${plan.messageChannels} channels with messages` },
        ...(plan.rolesSkipped.length ? [{ name: 'Bot roles that come back when those bots are re-invited', value: list(plan.rolesSkipped) }] : []),
      );
    if (!changes) {
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    const token = randomBytes(6).toString('hex');
    pendingRestores.set(token, { userId: interaction.user.id, backupId: id, opts, expires: Date.now() + 5 * 60_000 });
    await interaction.editReply({
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`backup:${token}:confirm`).setLabel('Restore').setEmoji('♻️').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`backup:${token}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  },

  async autocomplete(interaction, ctx) {
    const q = interaction.options.getFocused().toString();
    const list = ctx.store.listBackups(ctx.config.DISCORD_GUILD_ID).filter((b) => !q || String(b.id).startsWith(q) || (b.label ?? '').toLowerCase().includes(q.toLowerCase()));
    await interaction.respond(
      list.slice(0, 25).map((b) => ({
        name: `#${b.id} · ${new Date(b.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${b.auto ? 'auto' : 'manual'}${b.label ? ` · ${b.label}` : ''}`.slice(0, 100),
        value: b.id,
      })),
    );
  },
};

/** Handles `backup:<token>:<confirm|cancel>` from the restore preview. */
export async function handleBackupButton(interaction: ButtonInteraction, ctx: AppContext, token: string, action: string): Promise<void> {
  requireAdmin(interaction);
  const pending = pendingRestores.get(token);
  if (!pending || pending.expires < Date.now()) {
    pendingRestores.delete(token);
    await interaction.update({ content: 'That restore preview expired. Run /backup load again.', embeds: [], components: [] });
    return;
  }
  if (pending.userId !== interaction.user.id) throw new UserError('Only the administrator who asked can confirm this.');
  pendingRestores.delete(token);
  if (action !== 'confirm') {
    await interaction.update({ content: 'Restore cancelled.', embeds: [], components: [] });
    return;
  }

  await interaction.update({ content: '💾 Taking a safety backup first…', embeds: [], components: [] });
  const safety = await takeBackup(ctx, `before restoring #${pending.backupId}`, false);
  const { backup: data } = load(ctx, pending.backupId);
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  const progress = (step: string) => interaction.editReply({ content: `♻️ ${step}` }).then(() => {}, () => {});
  const result = await restoreBackup(guild, data, pending.opts, ctx.store, progress);

  const lines = [
    `♻️ Restore from backup #${pending.backupId} finished.`,
    `Roles: ${result.rolesCreated} recreated${pending.opts.mode === 'sync' ? `, ${result.rolesUpdated} reset` : ''} · Channels: ${result.channelsCreated} recreated${pending.opts.mode === 'sync' ? `, ${result.channelsUpdated} reset` : ''}`,
    `Emojis: ${result.emojisCreated} · Bans: ${result.bansAdded} · Messages re-posted: ${result.messagesPosted}`,
    `The state before this restore is saved as backup #${safety.id}.`,
    ...(result.errors.length ? [`⚠️ ${result.errors.length} item${result.errors.length === 1 ? '' : 's'} failed:`, ...result.errors.slice(0, 8).map((e) => `• ${e}`)] : []),
  ];
  const text = lines.join('\n').slice(0, 2000);
  // The interaction may have outlived its 15-minute token on a big restore; fall back to the channel.
  await interaction.editReply({ content: text }).catch(async () => {
    if (interaction.channel?.isSendable()) await interaction.channel.send({ content: text, allowedMentions: { parse: [] } });
  });
  await modLog(ctx, {
    action: 'Backup restored',
    moderator: interaction.user,
    fields: [
      { name: 'Backup', value: `#${pending.backupId} (${pending.opts.mode})` },
      { name: 'Recreated', value: `${result.rolesCreated} roles · ${result.channelsCreated} channels` },
      { name: 'Undo', value: `backup #${safety.id}` },
    ],
  });
}
