import { type Message, type SendableChannels } from 'discord.js';
import type { ChatTurn } from '../ai/ordis.js';
import { splitForDiscord } from '../ai/ordis.js';
import type { AppContext } from '../context.js';
import { formatDuration } from '../time.js';

const HISTORY_TURNS = 8;
const TYPING_INTERVAL_MS = 8_000;

export const stripMention = (text: string, botId: string) => text.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();

/** Earlier turns of a conversation, followed through Discord replies (oldest first). */
async function replyChain(message: Message, botId: string): Promise<ChatTurn[]> {
  const turns: ChatTurn[] = [];
  let ref = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  while (ref && turns.length < HISTORY_TURNS) {
    const fromBot = ref.author.id === botId;
    const text = fromBot ? ref.content : stripMention(ref.content, botId);
    if (text) turns.unshift({ role: fromBot ? 'assistant' : 'user', text });
    ref = ref.reference?.messageId ? await ref.fetchReference().catch(() => null) : null;
  }
  return turns;
}

/** Shows "Ordis is typing…" until `work` settles (Discord clears the indicator after ~10s). */
export async function withTyping<T>(channel: SendableChannels, work: Promise<T>): Promise<T> {
  void channel.sendTyping().catch(() => {});
  const timer = setInterval(() => void channel.sendTyping().catch(() => {}), TYPING_INTERVAL_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

export function limitMessage(reason: 'user' | 'daily', retryAfterMs: number): string {
  return reason === 'daily'
    ? `Ordis has answered so many questions today that his processors need rest, Operator. Ask again in ${formatDuration(retryAfterMs)}.`
    : `Ordis needs a moment to cool his processors, Operator. You can ask again in ${formatDuration(retryAfterMs)}.`;
}

/**
 * Answers Warframe questions in chat. Triggers: a mention of the bot (or a reply that pings it), any
 * message in the /setup chat channel (requires the Message Content intent), and DMs from clan members.
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

  if (!ctx.ai) {
    if (mentioned || isDM) await reply("Ordis's conversation matrix is offline, Operator. The bot's AI chat isn't configured.");
    return;
  }
  // DMs cost API credits too, so only clan members may use them.
  if (isDM) {
    const guild = await client.guilds.fetch(config.DISCORD_GUILD_ID);
    if (!(await guild.members.fetch(message.author.id).catch(() => null))) return;
  }

  const question = stripMention(message.content, botId);
  if (!question) {
    await reply(`Yes, Operator? Ask Ordis anything about Warframe, for example "where does Neo N16 drop?" or "what is Baro selling?"`);
    return;
  }

  const limit = ctx.ai.limiter.take(message.author.id);
  if (!limit.ok) {
    await reply(limitMessage(limit.reason, limit.retryAfterMs));
    return;
  }

  try {
    const history = await replyChain(message, botId);
    const member = store.getMember(config.DISCORD_GUILD_ID, message.author.id);
    const where = isDM ? 'direct message' : `#${'name' in message.channel ? message.channel.name : 'channel'}`;
    const answer = await withTyping(
      message.channel,
      ctx.ai.brain.ask({
        question: question.slice(0, 4000),
        history,
        askerName: message.member?.displayName ?? message.author.displayName,
        askerIgn: member?.ign ?? null,
        where,
      }),
    );
    // Each chunk replies to the previous one, so replying to any chunk continues the same conversation.
    let target: Message = message;
    for (const chunk of splitForDiscord(answer.text)) {
      target = await target.reply({ content: chunk, allowedMentions: { parse: [], repliedUser: target === message } });
    }
  } catch (err) {
    console.error('[ai] chat answer failed:', err);
    await reply('Ordis encountered a -- CRITICAL ERROR -- small hiccup, Operator. Please try again shortly.').catch(() => {});
  }
}
