import { type Message, type MessageReaction, type PartialMessageReaction, PermissionFlagsBits, type PartialUser, type User } from 'discord.js';
import { isStaff } from '../answers/corrections.js';
import type { AppContext } from '../context.js';

/** The two reactions Ordis puts under a logged answer: staff click one to tell the model whether the answer was right. */
export const RIGHT = '✅';
export const WRONG = '❌';

/** Adds ✅ and ❌ under an answer. Never throws: a channel without Add Reactions just has no buttons. */
export async function addRatingReactions(message: Message): Promise<void> {
  try {
    await message.react(RIGHT);
    await message.react(WRONG);
  } catch {
    // Missing permission or a deleted message: the panel's Corrections page still rates it.
  }
}

/**
 * A staff member clicking ✅ or ❌ under a logged answer rates it right or wrong (the same rating the panel's buttons set,
 * used as feedback for related questions); taking the reaction back clears that rating. Reactions from anyone else, from
 * bots, on other messages or with other emoji do nothing.
 */
export async function handleRatingReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, ctx: AppContext, added: boolean): Promise<void> {
  if (user.bot) return;
  const emoji = reaction.emoji.name;
  if (emoji !== RIGHT && emoji !== WRONG) return;
  const message = reaction.message;
  if (message.guildId !== ctx.config.DISCORD_GUILD_ID) return;
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const entry = ctx.store.aiLogByMessage(guildId, message.id);
  if (!entry) return;
  const member = await message.guild?.members.fetch(user.id).catch(() => null);
  if (!isStaff(ctx, user.id, member?.permissions.has(PermissionFlagsBits.ManageGuild) ?? false)) return;
  const rating = emoji === RIGHT ? 'right' : 'wrong';
  if (added) ctx.store.rateAiLog(guildId, entry.id, rating, user.id);
  else if (entry.rating === rating) ctx.store.rateAiLog(guildId, entry.id, null, user.id);
}
