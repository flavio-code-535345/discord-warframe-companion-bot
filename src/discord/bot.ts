import {
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import type { AppContext } from '../context.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { handleButton } from './buttons.js';
import type { Command } from './command.js';
import { clan } from './commands/clan.js';
import { event } from './commands/event.js';
import { lfg } from './commands/lfg.js';
import { setup } from './commands/setup.js';
import { drops, price, wf } from './commands/warframe.js';

export const COMMANDS: Command[] = [wf, price, drops, clan, event, lfg, setup];

export function createClient(enableWelcome: boolean): Client {
  const intents = [GatewayIntentBits.Guilds];
  // Server Members is a privileged intent: it must also be switched on in the Developer Portal.
  if (enableWelcome) intents.push(GatewayIntentBits.GuildMembers);
  return new Client({ intents });
}

async function replyError(interaction: ChatInputCommandInteraction | ButtonInteraction, err: unknown): Promise<void> {
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
  const { client, config, store } = ctx;
  const byName = new Map(COMMANDS.map((c) => [c.data.name, c]));

  client.once(Events.ClientReady, async (ready) => {
    console.log(`[discord] logged in as ${ready.user.tag}`);
    const guild = await ready.guilds.fetch(config.DISCORD_GUILD_ID).catch(() => null);
    if (!guild) {
      console.error(`[discord] the bot is not in guild ${config.DISCORD_GUILD_ID}; invite it with the applications.commands and bot scopes.`);
      return;
    }
    // Guild-scoped commands update instantly, unlike global ones.
    await guild.commands.set(COMMANDS.map((c) => c.data));
    console.log(`[discord] registered ${COMMANDS.length} slash commands in "${guild.name}"`);
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
    }
  });

  if (config.ENABLE_WELCOME) {
    client.on(Events.GuildMemberAdd, async (member) => {
      if (member.guild.id !== config.DISCORD_GUILD_ID || member.user.bot) return;
      const channelId = store.getSettings(member.guild.id).welcomeChannelId;
      if (!channelId) return;
      try {
        const channel = await getSendableChannel(ctx, channelId);
        await channel.send({
          content:
            `🐀 Welcome to **${config.CLAN_NAME}**, ${member}! ` +
            'Link your Warframe name with `/clan register`, check `/event list` for clan runs, and use `/lfg` to find a squad.',
          allowedMentions: { users: [member.id] },
        });
      } catch (err) {
        console.error('[discord] welcome message failed:', err);
      }
    });
  }
}
