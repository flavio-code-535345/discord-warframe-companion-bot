import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { UserError, getSendableChannel, renderLfg } from '../../services/clan.js';
import { DEFAULT_GRACE_MINUTES, parseDuration } from '../../lfg/lifecycle.js';
import { createSquadVoice, deleteSquadVoice, squadVoiceCategory } from '../../lfg/voice.js';
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

    const activity = ctx.store.getActivity(activityName);
    // An activity can have its own channel; otherwise the squad is posted where the command ran.
    const channel = activity?.channelId ? await getSendableChannel(ctx, activity.channelId) : interaction.channel;
    if (!channel?.isSendable()) throw new UserError("I can't post in this channel.");

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const categoryId = await squadVoiceCategory(ctx);
    let voiceId: string | null = null;
    if (categoryId) {
      const existing = ctx.store.openVoiceLfgByHost(guildId, interaction.user.id);
      if (existing) throw new UserError(`You already have an open squad (#${existing.id}). Close it before starting another.`);
      const hostName = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
      try {
        voiceId = (await createSquadVoice(ctx, { categoryId, hostId: interaction.user.id, hostName, activity: activityName, size })).id;
      } catch (err) {
        console.error('[lfg] could not create the squad voice channel:', err);
        throw new UserError("I couldn't create the voice channel. Check that Ordis can manage channels in that category.");
      }
    }

    const post = ctx.store.createLfg({
      guildId,
      channelId: channel.id,
      hostId: interaction.user.id,
      activity: activityName,
      details: interaction.options.getString('details'),
      size,
    });
    // The host counts as absent from creation, so a squad whose host never joins voice still ends.
    if (voiceId) ctx.store.setLfgVoice(post.id, voiceId, Date.now());
    if (expiresAt) ctx.store.setLfgExpiry(post.id, expiresAt);
    const stored = ctx.store.getLfg(post.id)!;

    try {
      const message = await channel.send({
        ...renderLfg(ctx, stored),
        content: activity?.roleId ? `<@&${activity.roleId}>` : undefined,
        allowedMentions: { parse: [], roles: activity?.roleId ? [activity.roleId] : [] },
      });
      ctx.store.setLfgMessage(post.id, message.id);
    } catch (err) {
      ctx.store.closeLfg(post.id);
      if (voiceId) await deleteSquadVoice(ctx, stored);
      throw err;
    }

    const grace = ctx.store.getSettings(guildId).lfgVoiceGraceMinutes ?? DEFAULT_GRACE_MINUTES;
    await interaction.editReply({
      content: `LFG #${post.id} posted in ${channel}.${voiceId ? ` Join <#${voiceId}> within ${grace} minutes or the squad ends.` : ''}`,
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
