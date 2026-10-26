import { AuditLogEvent, type EmbedBuilder, Events, type Message, type PartialMessage, type VoiceState } from 'discord.js';
import type { AppContext } from '../context.js';
import {
  type AuditChange,
  auditEntryEmbed,
  bulkDeleteEmbed,
  clip,
  memberJoinEmbed,
  memberLeaveEmbed,
  messageDeleteEmbed,
  messageEditEmbed,
  voiceEmbed,
} from './format.js';

/**
 * Server audit log: deleted and edited messages, bulk deletes, role / channel / member changes (from Discord's own audit
 * log, so each one says who did it), voice movement and, when the member intent is on, joins and leaves. Posted to the
 * /setup auditlog channel, or the moderation log channel when none is set. Never throws: logging must not break the bot.
 */

/** Where entries go: the audit log channel, else the moderation log channel. */
export function auditChannelId(ctx: Pick<AppContext, 'store' | 'config'>): string | null {
  const s = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  return s.auditLogChannelId ?? s.modLogChannelId;
}

export async function sendAudit(ctx: AppContext, embed: EmbedBuilder): Promise<void> {
  const id = auditChannelId(ctx);
  if (!id) return;
  try {
    const channel = await ctx.client.channels.fetch(id);
    if (channel?.isSendable()) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn('[audit] could not post to the log channel:', err instanceof Error ? err.message : err);
  }
}

/** Messages that should not be logged: other servers, Ordis's own, the screenshot channel (screenshots are never kept), clean channels and the log channels themselves. */
export function skipMessage(ctx: Pick<AppContext, 'store' | 'config' | 'client'>, m: { guildId: string | null; channelId: string; authorId: string | null }): boolean {
  if (m.guildId !== ctx.config.DISCORD_GUILD_ID) return true;
  if (m.authorId && m.authorId === ctx.client.user?.id) return true;
  const s = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if ([s.ssRolesChannelId, s.auditLogChannelId, s.modLogChannelId].includes(m.channelId)) return true;
  return ctx.store.getSticky(m.channelId)?.deleteOthers === true;
}

const textOf = (m: Message | PartialMessage): string => [m.content ?? '', ...m.embeds.map((e) => e.description ?? '')].filter(Boolean).join('\n');

export function attachAuditLogging(ctx: AppContext): void {
  const { client } = ctx;
  const guarded = <A extends unknown[]>(name: string, fn: (...args: A) => Promise<void> | void) => (...args: A) => {
    void Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => console.warn(`[audit] ${name} failed:`, err instanceof Error ? err.message : err));
  };

  client.on(
    Events.MessageDelete,
    guarded('messageDelete', async (message) => {
      if (skipMessage(ctx, { guildId: message.guildId, channelId: message.channelId, authorId: message.author?.id ?? null })) return;
      await sendAudit(
        ctx,
        messageDeleteEmbed({
          authorId: message.author?.id ?? null,
          authorName: message.author?.username ?? null,
          channelId: message.channelId,
          content: message.partial ? null : textOf(message) || null,
          attachments: message.partial ? [] : [...message.attachments.values()].map((a) => a.name),
          createdAt: message.createdTimestamp ?? null,
        }),
      );
    }),
  );

  client.on(
    Events.MessageBulkDelete,
    guarded('messageBulkDelete', async (messages, channel) => {
      if (skipMessage(ctx, { guildId: channel.guildId, channelId: channel.id, authorId: null })) return;
      const lines = [...messages.values()].reverse().map((m) => `**${m.author?.username ?? 'unknown'}**: ${clip(m.partial ? '*not cached*' : textOf(m).replace(/\s+/g, ' ') || '*attachment or embed*', 140)}`);
      await sendAudit(ctx, bulkDeleteEmbed(channel.id, messages.size, lines));
    }),
  );

  client.on(
    Events.MessageUpdate,
    guarded('messageUpdate', async (before, after) => {
      if (before.partial || after.author?.bot || !after.author) return;
      if (skipMessage(ctx, { guildId: after.guildId, channelId: after.channelId, authorId: after.author.id })) return;
      const [a, b] = [before.content ?? '', after.content ?? ''];
      if (a === b) return;
      await sendAudit(ctx, messageEditEmbed({ authorId: after.author.id, authorName: after.author.username, channelId: after.channelId, messageUrl: after.url, before: a, after: b }));
    }),
  );

  client.on(
    Events.GuildAuditLogEntryCreate,
    guarded('auditEntry', async (entry, guild) => {
      if (guild.id !== ctx.config.DISCORD_GUILD_ID) return;
      const actionName = AuditLogEvent[entry.action] ?? `Action${entry.action}`;
      // Ordis's own role and nickname changes (screenshot roles, levels) are reported where they happen.
      if (entry.executorId === client.user?.id && /^Member(RoleUpdate|Update)$/.test(actionName)) return;
      // Message deletions are logged with their content above; this adds who removed another member's message.
      const extra = entry.extra && typeof entry.extra === 'object' && 'count' in entry.extra && 'channel' in entry.extra ? `${String(entry.extra.count)} message(s) in <#${(entry.extra.channel as { id: string }).id}>` : null;
      const changes: AuditChange[] = entry.changes.map((c) => ({ key: c.key, old: c.old, new: c.new }));
      await sendAudit(
        ctx,
        auditEntryEmbed({ actionName, executorId: entry.executorId, targetId: entry.targetId, reason: entry.reason, changes, extra }),
      );
    }),
  );

  client.on(
    Events.VoiceStateUpdate,
    guarded('voiceState', async (before: VoiceState, after: VoiceState) => {
      if (after.guild.id !== ctx.config.DISCORD_GUILD_ID || after.member?.user.bot) return;
      const embed = voiceEmbed(after.id, before.channelId, after.channelId);
      if (embed) await sendAudit(ctx, embed);
    }),
  );

  // The next two only fire when the Server Members intent is on (ENABLE_MEMBER_LOGGING or ENABLE_WELCOME).
  client.on(
    Events.GuildMemberAdd,
    guarded('memberAdd', async (member) => {
      if (member.guild.id !== ctx.config.DISCORD_GUILD_ID) return;
      await sendAudit(ctx, memberJoinEmbed(member.id, member.user.username, member.user.createdTimestamp));
    }),
  );
  client.on(
    Events.GuildMemberRemove,
    guarded('memberRemove', async (member) => {
      if (member.guild.id !== ctx.config.DISCORD_GUILD_ID) return;
      await sendAudit(ctx, memberLeaveEmbed(member.id, member.user.username, [...member.roles.cache.keys()].filter((id) => id !== member.guild.id)));
    }),
  );
}
