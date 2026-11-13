import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError } from '../../errors.js';
import { DEFAULT_GRACE_MINUTES, parseDuration } from '../../lfg/lifecycle.js';
import { createSquad } from '../../lfg/squads.js';
import type { Command } from '../command.js';

export const ACTIVITIES = [
  'Eidolon hunt',
  'Archon Hunt',
  'Sortie',
  'Steel Path Circuit',
  'Netracells',
  'Elite Deep Archimedea',
  'Elite Temporal Archimedea',
  'Relic radshares',
  'Profit-Taker',
  'Exploiter Orb',
  'Kuva Lich / Sister hunt',
  'Railjack',
  'Arbitrations',
  'Void Cascade',
  'Index credit farm',
  'Steel Path Survival',
  'Mastery / leveling',
  'Clan dojo help',
];

const MAX_EXPIRY_MS = 7 * 86_400_000;

export const lfg: Command = {
  data: new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Post a looking-for-group squad that clanmates can join (gets its own voice channel when set up)')
    .addStringOption((o) => o.setName('activity').setDescription('What are you running?').setRequired(true).setMaxLength(100).setAutocomplete(true))
    .addStringOption((o) => o.setName('details').setDescription('Requirements, relics, voice channel…').setMaxLength(1000))
    .addIntegerOption((o) => o.setName('size').setDescription('Squad size including you (default 4)').setMinValue(2).setMaxValue(4))
    .addStringOption((o) => o.setName('expires').setDescription('End the squad after this long, like 30m, 2h or 1d (default: no limit)').setMaxLength(6))
    .toJSON(),

  async execute(interaction, ctx) {
    const guildId = ctx.config.DISCORD_GUILD_ID;
    const activityName = interaction.options.getString('activity', true);
    const size = interaction.options.getInteger('size') ?? 4;
    const expiresText = interaction.options.getString('expires');
    let expiresAt: number | null = null;
    if (expiresText) {
      let ms: number;
      try {
        ms = parseDuration(expiresText);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
      if (ms > MAX_EXPIRY_MS) throw new UserError('A squad can last at most 7 days.');
      expiresAt = Date.now() + ms;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const squad = await createSquad(ctx, {
      hostId: interaction.user.id,
      hostName: interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username,
      activity: activityName,
      details: interaction.options.getString('details'),
      size,
      expiresAt,
      channel: interaction.channel?.isSendable() ? interaction.channel : null,
    });
    const grace = ctx.store.getSettings(guildId).lfgVoiceGraceMinutes ?? DEFAULT_GRACE_MINUTES;
    await interaction.editReply({
      content: `LFG #${squad.post.id} posted in <#${squad.channelId}>.${squad.voiceChannelId ? ` Join <#${squad.voiceChannelId}> within ${grace} minutes or the squad ends.` : ''}`,
    });
  },

  async autocomplete(interaction, ctx) {
    const q = interaction.options.getFocused().toLowerCase();
    const known = [...new Set([...ctx.store.listActivities().map((a) => a.name), ...ACTIVITIES])];
    const matches = known.filter((a) => a.toLowerCase().includes(q));
    // Let people post anything, not only the suggestions.
    const options = q && !matches.some((m) => m.toLowerCase() === q) ? [interaction.options.getFocused(), ...matches] : matches;
    await interaction.respond(options.slice(0, 25).map((a) => ({ name: a.slice(0, 100), value: a.slice(0, 100) })));
  },
};
