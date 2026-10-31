import { type Message } from 'discord.js';
import { logAnswer } from '../answers/log.js';
import { smartAnswer } from '../answers/smart.js';
import type { AppContext } from '../context.js';
import { handleCorrectionReply } from './corrections.js';
import { addRatingReactions } from './ratings.js';

export const stripMention = (text: string, botId: string) => text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

/**
 * Answers Warframe questions in chat. Triggers: a mention of the bot (or a reply that pings it), anything written in the /setup
 * chat channel (requires the Message Content intent), and DMs from clan members. The answers come from lookups and the wiki
 * (answers/smart.ts), never from a model.
 */
export async function handleChatMessage(message: Message, ctx: AppContext): Promise<void> {
  const { client, config, store } = ctx;
  const botId = client.user?.id;
  if (!botId || message.author.bot) return;

  const isDM = !message.inGuild();
  if (!isDM && message.guildId !== config.DISCORD_GUILD_ID) return;
  const mentioned = !isDM && message.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true });
  const inChatChannel =
    !isDM && config.ENABLE_MESSAGE_CONTENT && store.getSettings(config.DISCORD_GUILD_ID).chatChannelId === message.channelId;
  if (!isDM && !mentioned && !inChatChannel) return;
  if (!message.channel.isSendable()) return;

  const reply = (content: string) => message.reply({ content, allowedMentions: { parse: [], repliedUser: true } });
  const question = stripMention(message.content, botId);
  // A reply to one of Ordis's logged answers: staff replying with the right answer correct him (members suggest a correction for staff to approve).
  const answered = !isDM && message.reference?.messageId ? store.aiLogByMessage(config.DISCORD_GUILD_ID, message.reference.messageId) : null;
  if (answered && (await handleCorrectionReply(message, ctx, answered, question))) return;
  // In the chat channel Ordis stays out of conversations between members (a reply to someone else's message) and of messages
  // with no text (a picture on its own).
  if (inChatChannel && !mentioned && !question) return;
  if (inChatChannel && !mentioned && !answered && message.reference?.messageId) {
    const ref = await message.fetchReference().catch(() => null);
    if (ref && ref.author.id !== botId) return;
  }

  // Ordis is the clan's bot: DMs are for clan members only.
  if (isDM) {
    const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
    if (!(await guild.members.fetch(message.author.id).catch(() => null))) return;
  }

  if (!question) {
    await reply(`Yes, Operator? Ask Ordis anything about Warframe, for example "where does Neo N16 drop?" or "what is Baro selling?"`);
    return;
  }

  try {
    void message.channel.sendTyping().catch(() => {});
    const answer = await smartAnswer(question.slice(0, 500), ctx);
    if (answer.silent) return;
    const sent = await message.reply({ content: answer.content, embeds: answer.embeds, allowedMentions: { parse: [], repliedUser: true } });
    const logged = logAnswer(ctx, { id: message.author.id, name: message.member?.displayName ?? message.author.displayName, channelId: isDM ? null : message.channelId, via: isDM ? 'dm' : 'chat' }, question, answer, sent.id);
    // The ✅ and ❌ under a logged answer are staff's quick rating (see ratings.ts); DMs and staff corrections don't get them.
    if (logged !== null && !isDM && answer.source !== 'correction') void addRatingReactions(sent);
  } catch (err) {
    console.error('[chat] answer failed:', err);
    await reply('Ordis encountered a -- CRITICAL ERROR -- small hiccup, Operator. Please try again shortly.').catch(() => {});
  }
}
