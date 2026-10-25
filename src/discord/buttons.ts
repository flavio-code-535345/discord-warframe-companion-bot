import { type ButtonInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import type { RsvpStatus } from '../db.js';
import { UserError, renderEvent, renderLfg } from '../services/clan.js';
import { handleBackupButton } from './commands/backup.js';
import { handlePurgeButton } from './commands/moderation.js';

const RSVP_STATUSES: RsvpStatus[] = ['going', 'maybe', 'declined'];

/** Handles button custom IDs `rsvp:<eventId>:<status>`, `lfg:<postId>:<action>`, `purge:<token>:<confirm|cancel>` and `backup:<token>:<confirm|cancel>`. */
export async function handleButton(interaction: ButtonInteraction, ctx: AppContext): Promise<void> {
  const [kind, rawId, action] = interaction.customId.split(':');
  const id = Number(rawId);

  if (kind === 'purge') {
    await handlePurgeButton(interaction, ctx, rawId ?? '', action ?? '');
    return;
  }
  if (kind === 'backup') {
    await handleBackupButton(interaction, ctx, rawId ?? '', action ?? '');
    return;
  }

  if (kind === 'rsvp') {
    const event = ctx.store.getEvent(id);
    if (!event || event.cancelled) throw new UserError('This event is no longer open for RSVPs.');
    if (!RSVP_STATUSES.includes(action as RsvpStatus)) throw new UserError('Unknown RSVP option.');
    ctx.store.setRsvp(id, interaction.user.id, action as RsvpStatus);
    await interaction.update(renderEvent(ctx, event));
    return;
  }

  if (kind === 'lfg') {
    const post = ctx.store.getLfg(id);
    if (!post || post.closed) throw new UserError('This squad is closed.');
    const members = ctx.store.lfgMembers(id);
    const isHost = interaction.user.id === post.hostId;

    if (action === 'join') {
      if (members.includes(interaction.user.id)) throw new UserError("You're already in this squad.");
      if (members.length >= post.size) throw new UserError('This squad is full.');
      ctx.store.joinLfg(id, interaction.user.id);
    } else if (action === 'leave') {
      if (!members.includes(interaction.user.id)) throw new UserError("You're not in this squad.");
      // A squad without its host is closed rather than left orphaned.
      if (isHost) ctx.store.closeLfg(id);
      else ctx.store.leaveLfg(id, interaction.user.id);
    } else if (action === 'close') {
      const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
      if (!isHost && !canManage) throw new UserError('Only the host can close this squad.');
      ctx.store.closeLfg(id);
    } else {
      throw new UserError('Unknown squad action.');
    }

    const updated = ctx.store.getLfg(id)!;
    await interaction.update(renderLfg(ctx, updated));

    const now = ctx.store.lfgMembers(id);
    if (action === 'join' && now.length >= updated.size) {
      await interaction.followUp({
        content: `🐀 Squad full for **${updated.activity}**! ${now.map((u) => `<@${u}>`).join(' ')} — host: <@${updated.hostId}>, send invites.`,
        allowedMentions: { users: now },
      });
    }
    return;
  }

  await interaction.reply({ content: 'That button is no longer supported.', flags: MessageFlags.Ephemeral });
}
