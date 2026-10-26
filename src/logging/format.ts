import { EmbedBuilder } from 'discord.js';

/** Pure builders for the audit log embeds, so what gets written is tested without a Discord connection. */

const COLOR = { delete: 0xef4444, edit: 0xf59e0b, create: 0x22c55e, change: 0x3b9ac7, voice: 0x6b7280, leave: 0xf97316 } as const;

export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const stamp = (embed: EmbedBuilder): EmbedBuilder => embed.setTimestamp(new Date());

export interface DeletedMessage {
  authorId: string | null;
  authorName: string | null;
  channelId: string;
  content: string | null;
  attachments: string[];
  createdAt: number | null;
}

export function messageDeleteEmbed(m: DeletedMessage): EmbedBuilder {
  const who = m.authorId ? `<@${m.authorId}>${m.authorName ? ` · ${m.authorName}` : ''}` : 'unknown (message was not cached)';
  const embed = new EmbedBuilder()
    .setColor(COLOR.delete)
    .setTitle('🗑️ Message deleted')
    .addFields({ name: 'Author', value: who, inline: true }, { name: 'Channel', value: `<#${m.channelId}>`, inline: true });
  if (m.createdAt) embed.addFields({ name: 'Sent', value: `<t:${Math.floor(m.createdAt / 1000)}:R>`, inline: true });
  embed.setDescription(m.content ? clip(m.content, 3500) : m.attachments.length ? null : '*no text, or the content was not cached*');
  if (m.attachments.length) embed.addFields({ name: 'Attachments', value: clip(m.attachments.join('\n'), 1000) });
  return stamp(embed);
}

export interface EditedMessage {
  authorId: string;
  authorName: string | null;
  channelId: string;
  messageUrl: string;
  before: string;
  after: string;
}

export function messageEditEmbed(m: EditedMessage): EmbedBuilder {
  return stamp(
    new EmbedBuilder()
      .setColor(COLOR.edit)
      .setTitle('✏️ Message edited')
      .setURL(m.messageUrl)
      .addFields(
        { name: 'Author', value: `<@${m.authorId}>${m.authorName ? ` · ${m.authorName}` : ''}`, inline: true },
        { name: 'Channel', value: `<#${m.channelId}>`, inline: true },
        { name: 'Before', value: clip(m.before || '*empty*', 1000) },
        { name: 'After', value: clip(m.after || '*empty*', 1000) },
        { name: 'Jump', value: `[to the message](${m.messageUrl})`, inline: true },
      ),
  );
}

export function bulkDeleteEmbed(channelId: string, total: number, lines: string[]): EmbedBuilder {
  const shown = lines.slice(0, 15);
  return stamp(
    new EmbedBuilder()
      .setColor(COLOR.delete)
      .setTitle(`🧹 ${total} messages deleted at once`)
      .addFields({ name: 'Channel', value: `<#${channelId}>`, inline: true })
      .setDescription(clip(shown.join('\n') + (total > shown.length ? `\n… and ${total - shown.length} more` : ''), 3800) || null),
  );
}

export interface AuditChange {
  key: string;
  old?: unknown;
  new?: unknown;
}

export interface AuditShape {
  /** AuditLogEvent name, e.g. "MemberRoleUpdate". */
  actionName: string;
  executorId: string | null;
  targetId: string | null;
  reason: string | null;
  changes: AuditChange[];
  /** Extra detail Discord attaches to some entries (e.g. how many messages were deleted). */
  extra: string | null;
}

/** "MemberRoleUpdate" → "Member role update". */
export const humanAction = (name: string): string => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);

const EMOJI: [RegExp, string][] = [
  [/^MemberRole/, '🏷️'],
  [/^MemberBan|^MemberKick|^MemberPrune/, '🔨'],
  [/^Member/, '👤'],
  [/^Role/, '🎭'],
  [/^Channel|^Thread|^StageInstance/, '📁'],
  [/^Invite/, '🔗'],
  [/^Emoji|^Sticker/, '😀'],
  [/^Webhook|^Integration|^Bot/, '🔌'],
  [/^Message/, '🗑️'],
  [/^Guild/, '⚙️'],
];

/** How the target of an entry is shown: members, roles and channels become mentions, anything else its id. */
export function targetLabel(actionName: string, targetId: string | null): string | null {
  if (!targetId) return null;
  if (/^Member/.test(actionName)) return `<@${targetId}>`;
  if (/^Role/.test(actionName)) return `<@&${targetId}>`;
  if (/^Channel/.test(actionName)) return `<#${targetId}>`;
  return `\`${targetId}\``;
}

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '—' : clip(v, 120);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return clip(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x)) ?? '—', 160);
};

/** One line per change; role additions and removals are listed by name. */
export function describeChange(c: AuditChange): string {
  if (c.key === '$add' || c.key === '$remove') {
    const roles = (Array.isArray(c.new) ? c.new : []) as { id?: string; name?: string }[];
    const text = roles.map((r) => (r.id ? `<@&${r.id}>` : (r.name ?? '?'))).join(' ') || '—';
    return `${c.key === '$add' ? '➕ Added' : '➖ Removed'}: ${text}`;
  }
  return `**${c.key}**: ${show(c.old)} → ${show(c.new)}`;
}

export function auditEntryEmbed(e: AuditShape): EmbedBuilder {
  const emoji = EMOJI.find(([re]) => re.test(e.actionName))?.[1] ?? '📝';
  const created = /Create|Add$/.test(e.actionName);
  const removed = /Delete|Remove|Kick|Ban$|Prune/.test(e.actionName) && !/Unban|BanRemove/.test(e.actionName);
  const embed = new EmbedBuilder().setColor(created ? COLOR.create : removed ? COLOR.delete : COLOR.change).setTitle(`${emoji} ${humanAction(e.actionName)}`);
  const target = targetLabel(e.actionName, e.targetId);
  embed.addFields({ name: 'By', value: e.executorId ? `<@${e.executorId}>` : 'unknown', inline: true });
  if (target) embed.addFields({ name: 'Target', value: target, inline: true });
  if (e.reason) embed.addFields({ name: 'Reason', value: clip(e.reason, 500), inline: true });
  const lines = e.changes.map(describeChange);
  if (e.extra) lines.push(e.extra);
  if (lines.length) embed.setDescription(clip(lines.join('\n'), 3800));
  return stamp(embed);
}

export function voiceEmbed(userId: string, from: string | null, to: string | null): EmbedBuilder | null {
  if (from === to) return null;
  const text = from && to ? `moved from <#${from}> to <#${to}>` : to ? `joined <#${to}>` : `left <#${from}>`;
  return stamp(new EmbedBuilder().setColor(COLOR.voice).setDescription(`🔊 <@${userId}> ${text}`));
}

export function memberJoinEmbed(userId: string, name: string, accountCreatedAt: number): EmbedBuilder {
  return stamp(
    new EmbedBuilder()
      .setColor(COLOR.create)
      .setTitle('📥 Member joined')
      .addFields({ name: 'Member', value: `<@${userId}> · ${name} · \`${userId}\``, inline: false }, { name: 'Account created', value: `<t:${Math.floor(accountCreatedAt / 1000)}:R>`, inline: true }),
  );
}

export function memberLeaveEmbed(userId: string, name: string, roles: string[]): EmbedBuilder {
  return stamp(
    new EmbedBuilder()
      .setColor(COLOR.leave)
      .setTitle('📤 Member left')
      .addFields({ name: 'Member', value: `<@${userId}> · ${name} · \`${userId}\``, inline: false }, { name: 'Roles', value: clip(roles.map((r) => `<@&${r}>`).join(' ') || '—', 1000), inline: false }),
  );
}
