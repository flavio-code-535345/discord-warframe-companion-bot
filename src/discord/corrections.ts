import { type Message, PermissionFlagsBits } from 'discord.js';
import { addCorrection, isStaff } from '../answers/corrections.js';
import type { AppContext } from '../context.js';
import type { AiLogEntry } from '../db.js';

/** Replies that are only manners, not a correction. */
const CHATTER = /^(thanks|thank you|thx|ty|ok|okay|lol|nice|great|good bot|cool|got it|cheers|wow|haha)\b/i;
const MIN_CHARS = 12;

/**
 * A reply to one of Ordis's logged answers that is not itself a question counts as a correction: from staff (an operator,
 * a panel admin or anyone with Manage Server) it is saved and takes effect at once (✅), from anyone else it becomes a
 * suggestion for staff to approve on the admin panel (📝). A reply that ends in "?" is a follow-up question instead and
 * returns false, as does anything that is only thanks or too short to be an answer.
 *
 * `entry` is the logged answer the message replies to, `text` the message without the bot mention.
 */
export async function handleCorrectionReply(message: Message, ctx: AppContext, entry: AiLogEntry, text: string): Promise<boolean> {
  const t = text.trim();
  if (t.length < MIN_CHARS || /\?\s*$/.test(t) || CHATTER.test(t)) return false;
  const staff = isStaff(ctx, message.author.id, message.member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false);
  const saved = addCorrection(ctx, {
    entry,
    text: t,
    authorId: message.author.id,
    authorName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
    staff,
    source: staff ? 'staff_reply' : 'member_reply',
  });
  if (!saved) return false;
  const emoji = saved.status === 'approved' ? '✅' : '📝';
  await message.react(emoji).catch(async () => {
    await message.reply({ content: saved.status === 'approved' ? 'Noted, Operator. Ordis will answer that way from now on.' : 'Ordis has passed your suggestion to the admins, Operator.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
  });
  return true;
}
