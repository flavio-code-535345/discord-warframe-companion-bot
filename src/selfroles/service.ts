import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  type GuildMember,
  MessageFlags,
  type MessageCreateOptions,
  type Role,
} from 'discord.js';
import type { AppContext } from '../context.js';
import type { SelfRole } from '../db.js';
import { DANGEROUS } from '../discord/verification.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { levelTier } from '../leveling/xp.js';
import { UserError } from '../services/clan.js';
import { editLive, postLive } from '../discord/live-message.js';
import { isStaffRoleName, masteryOfRoleName } from '../ssroles/roles.js';

/**
 * The self-assign role menu: one message with a button per role (platform, region, pings...), grouped in the embed. A tap gives the
 * role, a second tap takes it away; the answer is ephemeral. Custom IDs are `roles:<roleId>`, so old panels keep working after a
 * restart. Where the panel is lives in bot_meta, and every change to the list edits it in place.
 */

/** Discord allows 5 rows of 5 buttons under one message. */
export const MAX_SELF_ROLES = 25;
const PANEL_META = 'roles_panel';

/** Roles Ordis must never hand out on request: staff, earned ones (mastery, level, clan rank) and anything with real powers. */
export function assertSelfAssignable(role: Role, me: GuildMember): void {
  if (role.id === role.guild.id) throw new UserError('Pick a real role, not @everyone.');
  if (role.managed) throw new UserError(`${role.name} belongs to an integration and can't be handed out.`);
  if (role.position >= me.roles.highest.position) throw new UserError(`${role.name} is above Ordis's role, so Ordis can't give it out.`);
  if (role.permissions.any(DANGEROUS)) throw new UserError(`${role.name} has moderator or admin permissions, so it can't be self-assigned.`);
  if (isStaffRoleName(role.name) || /^rat (squire|knight)$/i.test(role.name)) throw new UserError(`${role.name} is a clan rank, which members earn instead of picking.`);
  if (masteryOfRoleName(role.name) !== null || levelTier(role.name) !== null) throw new UserError(`${role.name} is earned (mastery or level), so it can't be picked.`);
}

/** The panel: groups as embed fields and one button per role, in the same order. Pure apart from the brand icon. */
export function rolesPanel(ctx: AppContext, roles: SelfRole[]): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const groups = new Map<string, SelfRole[]>();
  for (const r of roles.slice(0, MAX_SELF_ROLES)) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🎭 Pick your roles')
    .setDescription(roles.length ? 'Tap a button to get a role, tap it again to drop it. Only you see the answer.' : 'No roles to pick yet.')
    .setFooter({ text: ctx.config.CLAN_NAME, iconURL: brandIcon(ctx) });
  for (const [group, list] of groups) {
    embed.addFields({ name: group, value: list.map((r) => `${r.emoji ? `${r.emoji} ` : ''}**${r.label}**${r.description ? ` · ${r.description}` : ''}`).join('\n').slice(0, 1024) });
  }
  const buttons = [...groups.values()].flat().map((r) => {
    const b = new ButtonBuilder().setCustomId(`roles:${r.roleId}`).setLabel(r.label.slice(0, 80)).setStyle(ButtonStyle.Secondary);
    if (r.emoji) b.setEmoji(r.emoji);
    return b;
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
  return { embeds: [embed], components: rows };
}

/** Posts the panel in a channel (the previous one is removed) and remembers it. Returns its link. */
export async function postRolesPanel(ctx: AppContext, channelId: string): Promise<string> {
  return postLive(ctx, PANEL_META, channelId, rolesPanel(ctx, ctx.store.listSelfRoles(ctx.config.DISCORD_GUILD_ID)));
}

/** Edits the posted panel after the list changed. */
export async function refreshRolesPanel(ctx: AppContext): Promise<void> {
  await editLive(ctx, PANEL_META, rolesPanel(ctx, ctx.store.listSelfRoles(ctx.config.DISCORD_GUILD_ID)));
}

export interface SelfRoleInput {
  roleId: string;
  group: string;
  label?: string | null;
  emoji?: string | null;
  description?: string | null;
}

/** Adds a role to the menu (or changes its entry) after the safety checks, and updates the panel. */
export async function addSelfRole(ctx: AppContext, input: SelfRoleInput): Promise<SelfRole> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const guild = await ctx.client.guilds.fetch(guildId);
  const role = await guild.roles.fetch(input.roleId).catch(() => null);
  if (!role) throw new UserError('That role does not exist in the server.');
  assertSelfAssignable(role, await guild.members.fetchMe());
  const existing = ctx.store.listSelfRoles(guildId);
  if (!existing.some((r) => r.roleId === role.id) && existing.length >= MAX_SELF_ROLES) throw new UserError(`The menu holds at most ${MAX_SELF_ROLES} roles. Remove one first.`);
  const entry: SelfRole = {
    roleId: role.id,
    group: input.group.trim().slice(0, 40) || 'Roles',
    label: (input.label?.trim() || role.name).slice(0, 80),
    emoji: input.emoji?.trim() || null,
    description: input.description?.trim().slice(0, 100) || null,
    position: existing.find((r) => r.roleId === role.id)?.position ?? existing.length,
  };
  ctx.store.upsertSelfRole(guildId, entry);
  await refreshRolesPanel(ctx);
  return entry;
}

export async function removeSelfRole(ctx: AppContext, roleId: string): Promise<boolean> {
  const removed = ctx.store.deleteSelfRole(ctx.config.DISCORD_GUILD_ID, roleId);
  if (removed) await refreshRolesPanel(ctx);
  return removed;
}

/** A tap on `roles:<roleId>`: toggles the role for the member who tapped. */
export async function handleRoleButton(interaction: ButtonInteraction, ctx: AppContext, roleId: string): Promise<void> {
  const entry = ctx.store.listSelfRoles(ctx.config.DISCORD_GUILD_ID).find((r) => r.roleId === roleId);
  if (!entry) throw new UserError('That role is no longer in the menu.');
  const guild = interaction.guild ?? (await ctx.client.guilds.fetch(ctx.config.DISCORD_GUILD_ID));
  const role = await guild.roles.fetch(roleId).catch(() => null);
  if (!role) throw new UserError('That role no longer exists.');
  // Checked again on every tap: the role may have gained permissions since it was added.
  assertSelfAssignable(role, await guild.members.fetchMe());
  const member = await guild.members.fetch(interaction.user.id);
  if (member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId, 'Self-assign menu');
    await interaction.reply({ content: `Removed **${role.name}**.`, flags: MessageFlags.Ephemeral });
  } else {
    await member.roles.add(roleId, 'Self-assign menu');
    await interaction.reply({ content: `You now have **${role.name}**. Tap again to drop it.`, flags: MessageFlags.Ephemeral });
  }
}
