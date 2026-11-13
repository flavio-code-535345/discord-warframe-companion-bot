import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  Partials,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { Config } from '../config.js';
import type { AppContext } from '../context.js';
import { UserError } from '../errors.js';
import { handleButton } from './buttons.js';
import { handleFeedSelect } from './feeds/handlers.js';
import { trackMessageActivity, trackVoiceActivity } from '../activity/service.js';
import { handleVoiceStateUpdate } from '../lfg/autovc.js';
import { handleHoneypotMessage } from '../moderation/honeypot.js';
import { handleLevelMessage } from '../leveling/service.js';
import { handleRivenMessage } from '../rivens/channel.js';
import { handleSsMessage } from '../ssroles/service.js';
import { stickyKeeper } from '../sticky/service.js';
import { checkSettings, reportDeletedChannel, reportDeletedRole } from './broken-settings.js';
import { handleChatMessage } from './chat.js';
import { syncChatTopic } from './chat-topic.js';
import { postWelcome } from './welcome.js';
import { syncIdentity } from './identity.js';
import { convertPingRoles } from './ping-roles.js';
import type { Command } from './command.js';
import { ask } from './commands/ask.js';
import { birthday, giveaway, inactive, roles } from './commands/community.js';
import { activity } from './commands/activity.js';
import { backup } from './commands/backup.js';
import { clan } from './commands/clan.js';
import { event } from './commands/event.js';
import { lfg } from './commands/lfg.js';
import { MODERATION_COMMANDS } from './commands/moderation.js';
import { item, wiki } from './commands/lookup.js';
import { ailog } from './commands/ailog.js';
import { LEVEL_COMMANDS } from './commands/levels.js';
import { setup } from './commands/setup.js';
import { handleStickyModal, isStickyModal, sticky } from './commands/sticky.js';
import { track } from './commands/track.js';
import { vc } from './commands/vc.js';
import { riven } from './commands/riven.js';
import { relics } from './commands/relics.js';
import { alecaframe } from './commands/alecaframe.js';
import { drops, price, wf } from './commands/warframe.js';

export const COMMANDS: Command[] = [wf, item, price, relics, riven, alecaframe, drops, wiki, ask, track, clan, event, lfg, activity, giveaway, birthday, roles, inactive, vc, sticky, ailog, ...LEVEL_COMMANDS, setup, ...MODERATION_COMMANDS, backup];

/** What a message may ping when it doesn't say: the members it mentions and the member it replies to, never a role or everyone. */
export const DEFAULT_MENTIONS = { parse: ['users'], repliedUser: true } as const satisfies { parse: readonly ['users']; repliedUser: boolean };

export function createClient(config: Pick<Config, 'ENABLE_WELCOME' | 'ENABLE_MESSAGE_CONTENT' | 'ENABLE_MEMBER_LOGGING'>): Client {
  // GuildMessages and DirectMessages are not privileged; without Message Content the bot still sees the
  // text of messages that mention it and of DMs, which is all mention-based chat needs.
  // GuildVoiceStates is also unprivileged: squad voice upkeep needs to see who is in a channel.
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates];
  // GuildModeration (not privileged) delivers audit log entries: who changed which role, channel or member.
  intents.push(GatewayIntentBits.GuildModeration);
  // These two are privileged: they must also be switched on in the Developer Portal, or login fails.
  if (config.ENABLE_WELCOME || config.ENABLE_MEMBER_LOGGING) intents.push(GatewayIntentBits.GuildMembers);
  if (config.ENABLE_MESSAGE_CONTENT) intents.push(GatewayIntentBits.MessageContent);
  // DM channels aren't cached up front; the Channel partial lets their first message through.
  // Unless a message says otherwise, text Ordis sends never pings @everyone, @here or a role: only the places that mean to ping a
  // role name it in their own allowedMentions. So a name or a reason typed by a member can't make Ordis ping the server.
  return new Client({ intents, partials: [Partials.Channel, Partials.Message], allowedMentions: DEFAULT_MENTIONS });
}

async function replyError(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction, err: unknown): Promise<void> {
  const message = err instanceof UserError ? err.message : 'Something went wrong. The error has been logged.';
  if (!(err instanceof UserError)) console.error(`[discord] interaction ${interaction.id} failed:`, err);
  const payload = { content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral } as const;
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    // The interaction token may have expired; nothing more to do.
  }
}

/** Wires interaction routing, command registration and welcome messages onto the client. */
export function attachHandlers(ctx: AppContext): void {
  const { client, config } = ctx;
  const byName = new Map(COMMANDS.map((c) => [c.data.name, c]));

  client.once(Events.ClientReady, async (ready) => {
    console.log(`[discord] logged in as ${ready.user.tag}`);
    await syncIdentity(ctx);
    void syncChatTopic(ctx);
    const guild = await ready.guilds.fetch(config.DISCORD_GUILD_ID).catch(() => null);
    if (!guild) {
      console.error(`[discord] the bot is not in guild ${config.DISCORD_GUILD_ID}; invite it with the applications.commands and bot scopes.`);
      return;
    }
    // Guild-scoped commands update instantly, unlike global ones.
    await guild.commands.set(COMMANDS.map((c) => c.data));
    console.log(`[discord] registered ${COMMANDS.length} slash commands in "${guild.name}"`);
    // Once, after the update that made every notification a DM: the members who held a ping role get the matching notification.
    await convertPingRoles(ctx).catch((err) => console.error('[ping-roles] the move to DM notifications failed:', err));
    // What was deleted while Ordis was offline: the settings that pointed at it are cleared and the staff are told.
    await checkSettings(ctx).catch((err) => console.error('[settings] the check for deleted channels failed:', err));
  });

  // A channel, category or role Ordis uses was deleted: say what is off because of it (discord/broken-settings.ts).
  client.on(Events.ChannelDelete, (channel) => {
    void reportDeletedChannel(ctx, channel).catch((err) => console.error('[settings] could not handle a deleted channel:', err));
  });
  client.on(Events.GuildRoleDelete, (role) => {
    void reportDeletedRole(ctx, role).catch((err) => console.error('[settings] could not handle a deleted role:', err));
  });

  client.on(Events.VoiceStateUpdate, (before, after) => {
    trackVoiceActivity(before, after, ctx);
    void handleVoiceStateUpdate(ctx, before, after);
  });

  client.on(Events.MessageCreate, (message) => {
    stickyKeeper(ctx).onMessage(message);
    trackMessageActivity(message, ctx);
    void handleLevelMessage(message, ctx).catch((err) => console.error('[levels] message handler failed:', err));
    void handleHoneypotMessage(message, ctx)
      .then(async (trapped) => (trapped ? true : (await handleSsMessage(message, ctx)) || (await handleRivenMessage(message, ctx))))
      .then((handled) => (handled ? undefined : handleChatMessage(message, ctx)))
      .catch((err) => console.error('[discord] message handler failed:', err));
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (interaction.guildId !== config.DISCORD_GUILD_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: `This bot only serves the ${config.CLAN_NAME} server.`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      try {
        await byName.get(interaction.commandName)?.autocomplete?.(interaction, ctx);
      } catch (err) {
        console.error(`[discord] autocomplete for /${interaction.commandName} failed:`, err);
        await interaction.respond([]).catch(() => {});
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = byName.get(interaction.commandName);
      if (!command) return;
      try {
        await command.execute(interaction, ctx);
      } catch (err) {
        await replyError(interaction, err);
      }
      return;
    }

    if (interaction.isButton()) {
      try {
        await handleButton(interaction, ctx);
      } catch (err) {
        await replyError(interaction, err);
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('feeds:')) {
      try {
        await handleFeedSelect(interaction, ctx);
      } catch (err) {
        await replyError(interaction, err);
      }
      return;
    }

    if (interaction.isModalSubmit() && isStickyModal(interaction.customId)) {
      try {
        await handleStickyModal(interaction, ctx);
      } catch (err) {
        await replyError(interaction, err);
      }
    }
  });

  if (config.ENABLE_WELCOME) {
    client.on(Events.GuildMemberAdd, async (member) => {
      if (member.guild.id !== config.DISCORD_GUILD_ID || member.user.bot) return;
      await postWelcome(ctx, member);
    });
  }
}
