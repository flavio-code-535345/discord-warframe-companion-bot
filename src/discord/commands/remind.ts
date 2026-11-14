import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { MAX_MESSAGE, MAX_PENDING, addReminder, cancelReminder, neutralise } from '../../reminders/service.js';
import { discordTime } from '../../time.js';
import type { Command } from '../command.js';

const NO_PINGS = { parse: [] as never[] };

export const remindme: Command = {
  data: new SlashCommandBuilder()
    .setName('remindme')
    .setDescription('Ordis sends you a DM with a note at a time you pick')
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Set a reminder')
        .addStringOption((o) => o.setName('when').setDescription('In 2h, 3 days, 1w 2d... or tomorrow 9am, 2026-12-01 18:00 (clan time zone)').setRequired(true).setMaxLength(60))
        .addStringOption((o) => o.setName('message').setDescription('What to remind you of').setRequired(true).setMaxLength(MAX_MESSAGE)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Your pending reminders'))
    .addSubcommand((s) =>
      s
        .setName('cancel')
        .setDescription('Cancel one of your reminders')
        .addIntegerOption((o) => o.setName('reminder').setDescription('Which one').setRequired(true).setAutocomplete(true)),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: NO_PINGS });
    if (sub === 'set') {
      const r = addReminder(ctx, {
        userId: interaction.user.id,
        channelId: interaction.inGuild() ? interaction.channelId : null,
        when: interaction.options.getString('when', true),
        message: interaction.options.getString('message', true),
      });
      await reply(
        `⏰ Got it. I will DM you ${discordTime(r.dueAt, 'F')} (${discordTime(r.dueAt)}):\n> ${neutralise(r.message)}\n-# Times without a zone are read in ${ctx.config.CLAN_TIMEZONE}. ${interaction.inGuild() ? 'If your DMs are closed I answer in this channel instead.' : 'Keep this DM open, so I can reach you.'}`,
      );
    } else if (sub === 'list') {
      const list = ctx.store.listReminders(guildId, interaction.user.id);
      if (!list.length) return void (await reply('You have no reminders waiting. Set one with `/remindme set`.'));
      const lines = list.map((r) => `**#${r.id}** · ${discordTime(r.dueAt, 'F')} (${discordTime(r.dueAt)}) · ${neutralise(r.message).slice(0, 80)}`);
      await reply(`${lines.join('\n')}\n-# ${list.length} of ${MAX_PENDING}. Cancel one with \`/remindme cancel\`.`);
    } else {
      const r = cancelReminder(ctx, interaction.user.id, interaction.options.getInteger('reminder', true));
      await reply(`Cancelled the reminder for ${discordTime(r.dueAt, 'F')}:\n> ${neutralise(r.message).slice(0, 200)}`);
    }
  },

  async autocomplete(interaction, ctx) {
    const q = interaction.options.getFocused().toString().toLowerCase();
    const list = ctx.store.listReminders(ctx.config.DISCORD_GUILD_ID, interaction.user.id).filter((r) => !q || String(r.id).startsWith(q) || r.message.toLowerCase().includes(q));
    await interaction.respond(
      list.slice(0, 25).map((r) => ({
        name: `#${r.id} · ${new Date(r.dueAt).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${r.message}`.slice(0, 100),
        value: r.id,
      })),
    );
  },
};
