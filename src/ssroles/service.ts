import { createHash } from 'node:crypto';
import { EmbedBuilder, type Guild, type GuildMember, type Message, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { modLog } from '../moderation/service.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { type CardReading, type RoleInfo, checkClan, earnedNames, masteryRank, norm, planRoles } from './roles.js';
import { type ImageData, readProfileCard } from './vision.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const COOLDOWN_MS = 30_000;

const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
];

const lastTry = new Map<string, number>();

const roleInfos = (guild: Guild): RoleInfo[] =>
  [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id)
    .map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed, dangerous: r.permissions.any(DANGEROUS) }));

/** An image attachment of a usable size and type, or null. */
const firstImage = (message: Message) => message.attachments.find((a) => IMAGE_TYPES.has((a.contentType ?? '').split(';')[0]!) && a.size <= MAX_IMAGE_BYTES) ?? null;

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new UserError("I couldn't download that image.");
  return new Uint8Array(await res.arrayBuffer());
}

function resultEmbed(ctx: AppContext, r: CardReading, mr: number | null, ok: boolean, lines: string[]): EmbedBuilder {
  const title = r.mastery_rank_title ? `${r.mastery_rank_title}${mr !== null ? ` (MR ${mr})` : ''}` : 'not recognized';
  const embed = new EmbedBuilder()
    .setColor(ok ? COLORS.success : COLORS.warn)
    .setAuthor({ name: ctx.config.BOT_NAME, iconURL: brandIcon(ctx) })
    .setTitle(ok ? '✅ Profile card verified' : '🚫 Not verified')
    .addFields({ name: 'Mastery Rank', value: title, inline: true });
  if (r.mastery_points) embed.addFields({ name: 'Mastery Points', value: r.mastery_points, inline: true });
  if (r.next_rank) embed.addFields({ name: 'Next Rank', value: `${r.next_rank}${r.points_to_next_rank ? ` in ${r.points_to_next_rank}` : ''}`, inline: true });
  if (r.clan_name) embed.addFields({ name: 'Clan', value: `${r.clan_name}${r.clan_tag ? `#${r.clan_tag}` : ''}${r.clan_tier_rank ? ` · ${r.clan_tier_rank}` : ''}`, inline: true });
  embed.addFields({ name: 'Clan member', value: ok ? 'yes' : 'no', inline: true });
  embed.setDescription(lines.join('\n').slice(0, 2000) || null);
  return embed;
}

/** Handles a message in the screenshot-roles channel. Returns true when the message belonged to it. */
export async function handleSsMessage(message: Message, ctx: AppContext): Promise<boolean> {
  const { config, store } = ctx;
  if (!message.inGuild() || message.guildId !== config.DISCORD_GUILD_ID || message.author.bot) return false;
  const settings = store.getSettings(config.DISCORD_GUILD_ID);
  if (!settings.ssRolesChannelId || message.channelId !== settings.ssRolesChannelId) return false;

  const image = firstImage(message);
  if (!image) {
    if (message.attachments.size) await message.reply({ content: 'Please post a PNG, JPG or WebP screenshot under 8 MB.', allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }
  const wait = (lastTry.get(message.author.id) ?? 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    await message.reply({ content: `One screenshot at a time, Operator. Try again in ${Math.ceil(wait / 1000)}s.`, allowedMentions: { repliedUser: false } }).catch(() => {});
    return true;
  }
  lastTry.set(message.author.id, Date.now());
  await message.react('⏳').catch(() => {});

  try {
    const guild = message.guild;
    const [member, me] = await Promise.all([message.member ?? guild.members.fetch(message.author.id), guild.members.fetchMe()]);
    const bytes = await download(image.url);
    const submission: ImageData = { mime: (image.contentType ?? 'image/png').split(';')[0]!, data: bytes };
    const stored = store.getSsReference(guild.id);
    const reading = await readProfileCard(config, config.CLAN_NAME, submission, stored ? { mime: stored.mime, data: stored.image } : null);
    const mr = masteryRank(reading);
    const clan = checkClan(reading, config.CLAN_NAME, stored !== null);

    const problems = [...clan.problems];
    if (clan.ok) {
      // The same card, or the same in-game name, can't be used by two Discord accounts.
      const hash = createHash('sha256').update(bytes).digest('hex');
      const ign = reading.in_game_name ? norm(reading.in_game_name) : null;
      const takenBy = store.claimSs(guild.id, 'image', hash, message.author.id) ?? (ign ? store.claimSs(guild.id, 'ign', ign, message.author.id) : null);
      if (takenBy) problems.push('This screenshot or in-game name was already used by another member. If that is a mistake, ask a moderator.');
    }

    if (problems.length) {
      await message.reply({ embeds: [resultEmbed(ctx, reading, mr, false, problems.map((p) => `• ${p}`))], allowedMentions: { repliedUser: false } });
      await modLog(ctx, {
        action: 'Screenshot rejected',
        moderator: ctx.client.user!,
        target: message.author,
        reason: problems.join(' '),
        fields: [{ name: 'Message', value: message.url }],
      });
      return true;
    }

    const earned = earnedNames(reading, mr, config.CLAN_NAME);
    const plan = planRoles(roleInfos(guild), earned, new Set(member.roles.cache.keys()), me.roles.highest.position);
    const reason = 'Screenshot roles: verified profile card';
    const failed: string[] = [];
    const apply = async (m: GuildMember, ids: string[], add: boolean) => {
      for (const id of ids) {
        await (add ? m.roles.add(id, reason) : m.roles.remove(id, reason)).catch(() => failed.push(id));
      }
    };
    await apply(member, plan.add.map((r) => r.id), true);
    await apply(member, plan.remove.map((r) => r.id), false);

    const lines = [
      plan.add.length ? `**Roles added:** ${plan.add.filter((r) => !failed.includes(r.id)).map((r) => `<@&${r.id}>`).join(' ') || '—'}` : 'No new roles to add: you already have everything this card earns.',
      ...(plan.remove.length ? [`**Replaced:** ${plan.remove.map((r) => `~~${r.name}~~`).join(' ')}`] : []),
      ...(plan.skipped.length ? [`Skipped: ${plan.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`] : []),
      ...(failed.length ? ['Some roles could not be changed. A moderator needs to check Ordis\'s role position.'] : []),
    ];
    await message.reply({ embeds: [resultEmbed(ctx, reading, mr, true, lines)], allowedMentions: { repliedUser: false } });
    await modLog(ctx, {
      action: 'Screenshot roles',
      moderator: ctx.client.user!,
      target: message.author,
      reason: `${reading.mastery_rank_title ?? 'rank unknown'} · ${reading.in_game_name ?? 'name not shown'}`,
      fields: [
        { name: 'Added', value: plan.add.map((r) => r.name).join(', ') || '—' },
        { name: 'Message', value: message.url },
      ],
    });
  } catch (err) {
    if (err instanceof UserError) await message.reply({ content: err.message, allowedMentions: { repliedUser: false } }).catch(() => {});
    else {
      console.error('[ssroles] failed:', err);
      await message.reply({ content: 'Something went wrong reading that screenshot. Try again later.', allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  } finally {
    await message.reactions.cache.get('⏳')?.users.remove(ctx.client.user!.id).catch(() => {});
  }
  return true;
}

/** Points screenshot roles at a channel, optionally replaces the reference card, and posts the instructions there. */
export async function setupSsRoles(ctx: AppContext, channelId: string, reference?: { mime: string; data: Uint8Array }): Promise<void> {
  const channel = await getSendableChannel(ctx, channelId);
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if ([settings.chatChannelId, settings.honeypotChannelId, settings.verifyChannelId].includes(channelId)) {
    throw new UserError('That channel is used for something else. Pick a channel just for screenshots.');
  }
  if (reference) {
    if (!IMAGE_TYPES.has(reference.mime)) throw new UserError('The reference must be a PNG, JPG or WebP screenshot.');
    if (reference.data.length > MAX_IMAGE_BYTES) throw new UserError('The reference image is over 8 MB.');
    ctx.store.setSsReference(ctx.config.DISCORD_GUILD_ID, reference.mime, reference.data);
  }
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { ssRolesChannelId: channelId });
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: ctx.config.BOT_NAME, iconURL: brandIcon(ctx) })
    .setTitle('🖼️ Get your roles from a screenshot')
    .setDescription(
      [
        `Open the in-game **Profile** and post a screenshot here. It must show your **Mastery Rank** and your **Clan** panel, which has to be **${ctx.config.CLAN_NAME}** with our emblem.`,
        'Ordis reads it and gives you the roles it earns: your Mastery Rank, the clan role and accolades such as Ten Year Supporter. This channel is for clan members only, and edited screenshots are rejected.',
        'Post a new screenshot after you rank up and your rank role is updated.',
      ].join('\n\n'),
    );
  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

export function disableSsRoles(ctx: AppContext): void {
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { ssRolesChannelId: null });
}
