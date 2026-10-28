import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  type GuildMember,
  type InteractionUpdateOptions,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  type Role,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { AppContext } from '../context.js';
import { modLog } from '../moderation/service.js';
import { UserError, assertChannelFree, getSendableChannel } from '../services/clan.js';
import { formatDuration } from '../time.js';
import { VerificationAttempts } from '../verification/attempts.js';
import { renderCaptcha } from '../verification/captcha.js';
import { COLORS } from './embeds.js';
import { brandIcon } from './identity.js';
import { postWelcome } from './welcome.js';

/**
 * Captcha.bot-style verification: a panel with a Verify button in the verify channel, a private image captcha,
 * the code typed into a pop-up, and the verification role on success. The server's channel permissions do the
 * gating (unverified members only see the verify channel); this module only hands out the role.
 */
const attempts = new VerificationAttempts();

/** Permissions a role handed out to strangers must never carry. */
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageWebhooks,
];

export function assertSafeVerifyRole(role: Role, me: GuildMember): void {
  if (role.id === role.guild.id) throw new UserError('Pick a real role, not @everyone.');
  if (role.managed) throw new UserError(`${role.name} belongs to an integration and can't be handed out.`);
  if (role.position >= me.roles.highest.position) throw new UserError(`${role.name} is above Ordis's role, so Ordis can't give it out. Move Ordis's role higher.`);
  if (role.permissions.any(DANGEROUS)) {
    throw new UserError(`${role.name} has moderator or admin permissions. Verification hands it to strangers, so pick a plain member role.`);
  }
}

function panel(ctx: AppContext) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🛡️ Verification')
    .setDescription(
      `Welcome to **${ctx.config.CLAN_NAME}**, Tenno!\n\n` +
        'To keep raid bots out, Ordis asks every newcomer to solve a quick captcha.\n' +
        '**Press Verify**, then type the code from the picture.',
    )
    .setThumbnail(brandIcon(ctx) ?? null)
    .setFooter({ text: 'Only you can see your captcha.' });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  return { embeds: [embed], components: [row] };
}

/** Posts (or re-posts) the panel and stores the settings. Removes Ordis's previous panel if it moved. */
export async function setupVerification(ctx: AppContext, channelId: string, roleId: string, minAccountAgeDays: number | null): Promise<string> {
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  const [me, role] = await Promise.all([guild.members.fetchMe(), guild.roles.fetch(roleId)]);
  if (!role) throw new UserError('That role does not exist.');
  assertSafeVerifyRole(role, me);
  const channel = await getSendableChannel(ctx, channelId);
  assertChannelFree(ctx, { verifyChannelId: channelId });
  const previous = ctx.store.getSettings(guild.id);
  if (previous.verifyChannelId && previous.verifyPanelMessageId) {
    const old = await getSendableChannel(ctx, previous.verifyChannelId).catch(() => null);
    await old?.messages.delete(previous.verifyPanelMessageId).catch(() => {});
  }
  const message = await channel.send(panel(ctx));
  ctx.store.updateSettings(guild.id, {
    verifyChannelId: channel.id,
    verifyPanelMessageId: message.id,
    verifyRoleId: role.id,
    verifyMinAccountAgeDays: minAccountAgeDays,
  });
  return message.url;
}

export async function disableVerification(ctx: AppContext): Promise<void> {
  const s = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if (s.verifyChannelId && s.verifyPanelMessageId) {
    const channel = await getSendableChannel(ctx, s.verifyChannelId).catch(() => null);
    await channel?.messages.delete(s.verifyPanelMessageId).catch(() => {});
  }
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { verifyChannelId: null, verifyPanelMessageId: null, verifyRoleId: null, verifyMinAccountAgeDays: null });
}

function challenge(code: string, attemptsLeft: number): InteractionUpdateOptions & { flags?: MessageFlags.Ephemeral } {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Type the code from the picture')
    .setDescription(`Press **Enter code** and type the ${code.length} characters you see (no 0, O, 1, I or L). ${attemptsLeft} tr${attemptsLeft === 1 ? 'y' : 'ies'} left.`)
    .setImage('attachment://captcha.png');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('verify:answer').setLabel('Enter code').setEmoji('⌨️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('verify:refresh').setLabel('New picture').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );
  return { content: '', embeds: [embed], components: [row], files: [new AttachmentBuilder(renderCaptcha(code), { name: 'captcha.png' })], attachments: [] };
}

async function memberAndRole(ctx: AppContext, userId: string) {
  const s = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if (!s.verifyRoleId) throw new UserError('Verification is not set up on this server.');
  const guild = await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID);
  const member = await guild.members.fetch(userId);
  return { settings: s, member, roleId: s.verifyRoleId };
}

/** Handles `verify:start`, `verify:refresh` and `verify:answer` buttons. */
export async function handleVerifyButton(interaction: ButtonInteraction, ctx: AppContext, action: string): Promise<void> {
  const { settings, member, roleId } = await memberAndRole(ctx, interaction.user.id);
  if (member.roles.cache.has(roleId)) {
    await interaction.reply({ content: "You're already verified. Welcome back, Operator!", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === 'answer') {
    const input = new TextInputBuilder().setCustomId('code').setLabel('Code from the picture').setStyle(TextInputStyle.Short).setMinLength(4).setMaxLength(10).setRequired(true);
    await interaction.showModal(
      new ModalBuilder().setCustomId('verify:modal').setTitle('Verification').addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input)),
    );
    return;
  }

  const minDays = settings.verifyMinAccountAgeDays ?? 0;
  const ageMs = Date.now() - interaction.user.createdTimestamp;
  if (minDays > 0 && ageMs < minDays * 86_400_000) {
    await modLog(ctx, { action: 'Verification failed', moderator: interaction.client.user, target: interaction.user, reason: `Account is ${formatDuration(ageMs)} old (minimum ${minDays} days)` });
    await interaction.reply({
      content: `Your Discord account is too new to join yet (it must be at least ${minDays} day${minDays === 1 ? '' : 's'} old). Please try again in ${formatDuration(minDays * 86_400_000 - ageMs)}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const started = attempts.start(interaction.user.id);
  if (!started.ok) {
    const text = `Too many wrong codes. Try again in ${formatDuration(started.cooldownMs)}.`;
    if (action === 'refresh') await interaction.update({ content: text, embeds: [], components: [], attachments: [] });
    else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    return;
  }
  const reply = challenge(started.code, started.attemptsLeft);
  if (action === 'refresh') await interaction.update(reply);
  else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral } as Parameters<ButtonInteraction['reply']>[0]);
}

/** Handles the `verify:modal` code submission. */
export async function handleVerifyModal(interaction: ModalSubmitInteraction, ctx: AppContext): Promise<void> {
  if (!interaction.isFromMessage()) throw new UserError('Press Verify again to get a captcha.');
  const { member, roleId } = await memberAndRole(ctx, interaction.user.id);
  const check = attempts.check(interaction.user.id, interaction.fields.getTextInputValue('code'));

  if (check.result === 'ok') {
    await member.roles.add(roleId, 'Passed Ordis verification');
    await interaction.update({ content: `✅ Verified! Welcome to **${ctx.config.CLAN_NAME}**, Operator. The rest of the server is open to you now.`, embeds: [], components: [], attachments: [] });
    await modLog(ctx, { action: 'Verified', moderator: interaction.client.user, target: interaction.user });
    await postWelcome(ctx, member);
    return;
  }
  if (check.result === 'wrong') {
    const next = attempts.start(interaction.user.id);
    if (next.ok) {
      const retry = challenge(next.code, check.attemptsLeft);
      await interaction.update({ ...retry, content: '❌ That code was wrong. Here is a new picture.' });
      return;
    }
  }
  if (check.result === 'locked') {
    await modLog(ctx, { action: 'Verification failed', moderator: interaction.client.user, target: interaction.user, reason: 'Too many wrong captcha codes' });
    await interaction.update({ content: `❌ Too many wrong codes. Try again in ${formatDuration(check.cooldownMs)}.`, embeds: [], components: [], attachments: [] });
    return;
  }
  await interaction.update({ content: 'That captcha expired. Press **Verify** in the channel again.', embeds: [], components: [], attachments: [] });
}
