import { createHash } from 'node:crypto';
import { EmbedBuilder, type Guild, type GuildMember, type Message, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { modLog } from '../moderation/service.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { MATCH_THRESHOLD, decodeImage, findEmblem, fingerprint, similarity } from './emblem.js';
import { ocr } from './ocr.js';
import { type RankRow, parseCard, parseRankRow } from './parse.js';
import { type CardReading, type RoleInfo, checkClan, clanRankRoleName, earnedNames, masteryRank, norm, planClanRank, planRoles } from './roles.js';
import { readProfileCard } from './vision.js';
import { saveSticky } from '../sticky/service.js';

/**
 * Screenshots are processed in memory only: nothing is written to disk or the database (just a hash and the
 * in-game name, to stop a card being shared), and the member's message is deleted once it has been read.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const COOLDOWN_MS = 30_000;
/** Mastery points on the example card in assets/ss-roles-example.png (normalized, no separators). */
const EXAMPLE_POINTS = '2692721';

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

/** The example card is public, so its mastery total is reserved for Ordis: posting a copy of it gets nobody roles. */
const reserveExample = (ctx: AppContext): void => void ctx.store.claimSs(ctx.config.DISCORD_GUILD_ID, 'points', EXAMPLE_POINTS, ctx.client.user!.id);

/** Clears who has used which in-game name, screenshot and mastery total, so every card is accepted again. */
export function resetSsClaims(ctx: AppContext, keepExample = false): number {
  const cleared = ctx.store.resetSsClaims(ctx.config.DISCORD_GUILD_ID);
  if (keepExample) reserveExample(ctx);
  lastTry.clear();
  return cleared;
}

const mimeOf = (contentType: string | null) => (contentType ?? '').split(';')[0]!.trim();

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new UserError("I couldn't download that image.");
  return new Uint8Array(await res.arrayBuffer());
}

type Reference = { fingerprint: Uint8Array; clanText: string };

export interface CardRead {
  reading: CardReading;
  /** Which reader produced it, for the log. */
  reader: 'ocr' | 'gemini';
  /** The emblem as a fingerprint, when the OCR reader found it. */
  emblem: Uint8Array | null;
  /** Set when the image is a clan roster row (name and clan rank) instead of a profile card. */
  rankRow?: RankRow | null;
}

/** OCR first; Gemini only when OCR can't make sense of the image (unsupported format, unusual layout, unreadable). */
export async function readCard(ctx: AppContext, bytes: Uint8Array, mime: string, reference: Reference | null): Promise<CardRead> {
  const pixels = decodeImage(bytes, mime);
  if (pixels) {
    try {
      const lines = await ocr.recognize(bytes);
      const parsed = parseCard(lines);
      const rankRow = parsed.complete ? null : parseRankRow(lines);
      if (rankRow) return { reading: parsed.reading, reader: 'ocr', emblem: null, rankRow };
      if (!parsed.complete || !parsed.clanLine) {
        const r = parsed.reading;
        console.log(`[ssroles] OCR incomplete (${pixels.width}x${pixels.height}, ${lines.length} lines): card=${r.is_profile_card} rank=${r.mastery_rank_title} points=${r.mastery_points} clan=${r.clan_name}`);
      } else {
        const box = findEmblem(pixels, parsed.clanLine);
        const emblem = box ? fingerprint(pixels, box) : null;
        if (!emblem) console.log(`[ssroles] emblem not found above the clan line at ${JSON.stringify(parsed.clanLine)} in ${pixels.width}x${pixels.height}`);
        // Without an emblem to compare, a stored reference can't be honoured: let the fallback reader look.
        if (emblem || !reference) return { reading: withReference(parsed.reading, reference, emblem), reader: 'ocr', emblem };
      }
    } catch (err) {
      console.error('[ssroles] OCR failed, using the fallback reader:', err instanceof Error ? err.message : err);
    }
  }
  const reading = await readProfileCard(ctx.config, { mime, data: bytes });
  return { reading: withReference(reading, reference, null), reader: 'gemini', emblem: null };
}

/** Fills in the clan text and emblem verdicts by comparing with the stored reference. */
function withReference(r: CardReading, reference: Reference | null, emblem: Uint8Array | null): CardReading {
  if (!reference) return r;
  const text = r.clan_name && r.clan_tag ? norm(`${r.clan_name}${r.clan_tag}`) === norm(reference.clanText) : false;
  return {
    ...r,
    clan_text_matches_reference: text,
    emblem_matches_reference: emblem ? similarity(emblem, reference.fingerprint) >= MATCH_THRESHOLD : null,
  };
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
  embed.setFooter({ text: 'Your screenshot was deleted after reading. Ordis keeps no copy.' });
  embed.setDescription(lines.join('\n').slice(0, 2000) || null);
  return embed;
}

export type NicknameResult = { name: string; status: 'set' | 'same' | 'failed' } | null;

/** Sets the member's server nickname to their in-game name. Never throws: Discord refuses for the owner and for members above Ordis. */
export async function syncNickname(member: GuildMember, inGameName: string | null): Promise<NicknameResult> {
  const name = inGameName?.trim() ?? '';
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) return null;
  if (member.nickname === name) return { name, status: 'same' };
  return member.setNickname(name, 'Screenshot roles: in-game name').then(
    () => ({ name, status: 'set' as const }),
    () => ({ name, status: 'failed' as const }),
  );
}

const nicknameLine = (r: NicknameResult): string[] =>
  r === null || r.status === 'same' ? [] : [r.status === 'set' ? `**Nickname:** ${r.name}` : `I couldn't change your nickname to ${r.name} (Discord doesn't let me rename you), so do that yourself.`];

/** True when the roster's in-game name ("TheRareGamer") is one this member verified with a profile card ("TheRareGamer#1234"). */
export function ownsName(verified: string[], rosterName: string): boolean {
  const n = norm(rosterName);
  return n.length >= 3 && verified.some((k) => k === n || (k.startsWith(n) && /^\d{3,4}$/.test(k.slice(n.length))));
}

/** A clan roster screenshot: gives Rat Squire or Rat Knight to the member whose verified in-game name is on the row. */
async function handleRankRow(
  ctx: AppContext,
  message: Message<true>,
  member: GuildMember,
  me: GuildMember,
  bytes: Uint8Array,
  row: RankRow,
  finish: (payload: { content: string; embeds?: EmbedBuilder[] }, ttlMs?: number) => Promise<void>,
): Promise<void> {
  const { store, config } = ctx;
  const guild = message.guild;
  const problems: string[] = [];
  if (!row.name) problems.push("I couldn't read the in-game name next to the rank.");
  else if (!ownsName(store.ssNamesOf(guild.id, message.author.id), row.name)) {
    problems.push(`"${row.name}" is not an in-game name you verified. Post your profile card first (it shows your name), then this screenshot.`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!problems.length && store.claimSs(guild.id, 'image', hash, message.author.id)) problems.push('This screenshot was already used by another member.');

  const plan = problems.length ? null : planClanRank(roleInfos(guild), row.rank, new Set(member.roles.cache.keys()), me.roles.highest.position);
  if (plan) problems.push(...plan.problems);

  const rankName = clanRankRoleName(row.rank);
  const embed = new EmbedBuilder()
    .setAuthor({ name: config.BOT_NAME, iconURL: brandIcon(ctx) })
    .addFields({ name: 'Clan rank', value: rankName, inline: true }, { name: 'In-game name', value: row.name ?? 'not read', inline: true })
    .setFooter({ text: 'Your screenshot was deleted after reading. Ordis keeps no copy.' });

  if (problems.length || !plan) {
    embed.setColor(COLORS.warn).setTitle('🚫 Clan rank not verified').setDescription(problems.map((p) => `• ${p}`).join('\n'));
    await finish({ content: `<@${message.author.id}>`, embeds: [embed] }, 60_000);
    await modLog(ctx, { action: 'Screenshot rejected', moderator: ctx.client.user!, target: message.author, reason: problems.join(' '), fields: [{ name: 'Clan rank screenshot', value: `${rankName} · ${row.name ?? 'name not read'}` }] });
    return;
  }

  const failed: string[] = [];
  if (plan.add) await member.roles.add(plan.add.id, 'Screenshot roles: clan rank').catch(() => failed.push(plan.add!.id));
  for (const r of plan.remove) await member.roles.remove(r.id, 'Screenshot roles: clan rank').catch(() => failed.push(r.id));
  embed
    .setColor(COLORS.success)
    .setTitle('✅ Clan rank verified')
    .setDescription(
      [
        plan.add ? `**Role added:** <@&${plan.add.id}>` : 'You already have this role.',
        ...(plan.remove.length ? [`**Replaced:** ${plan.remove.map((r) => `~~${r.name}~~`).join(' ')}`] : []),
        ...(failed.length ? ["Some roles could not be changed. A moderator needs to check Ordis's role position."] : []),
        ...nicknameLine(await syncNickname(member, row.name)),
      ].join('\n'),
    );
  await finish({ content: `<@${message.author.id}>`, embeds: [embed] }, 20_000);
  await modLog(ctx, {
    action: 'Screenshot roles',
    moderator: ctx.client.user!,
    target: message.author,
    reason: `Verified clan rank: ${rankName}`,
    fields: [
      { name: 'In-game name', value: row.name ?? '—' },
      { name: 'Roles added', value: plan.add?.name ?? '—' },
      { name: 'Roles removed', value: plan.remove.map((r) => r.name).join(', ') || '—' },
      { name: 'Reader', value: 'OCR' },
    ],
  });
}

/** Handles a message in the screenshot-roles channel. Returns true when the message belonged to it. */
export async function handleSsMessage(message: Message, ctx: AppContext): Promise<boolean> {
  const { config, store } = ctx;
  if (!message.inGuild() || message.guildId !== config.DISCORD_GUILD_ID || message.author.bot) return false;
  const settings = store.getSettings(config.DISCORD_GUILD_ID);
  if (!settings.ssRolesChannelId || message.channelId !== settings.ssRolesChannelId) return false;

  const channel = message.channel;
  const say = (payload: Parameters<typeof channel.send>[0]) => channel.send(payload).catch(() => {});
  const mention = { users: [message.author.id] };

  // Only screenshots belong here: anything else is removed, and the member is told why for a moment.
  const image = message.attachments.find((a) => IMAGE_TYPES.has(mimeOf(a.contentType)) && a.size <= MAX_IMAGE_BYTES) ?? null;
  if (!image) {
    if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
    await message.delete().catch(() => {});
    const notice = await channel.send({ content: `<@${message.author.id}> this channel is only for profile screenshots (PNG, JPG or WebP under 8 MB).`, allowedMentions: mention }).catch(() => null);
    if (notice) setTimeout(() => void notice.delete().catch(() => {}), 8000).unref();
    return true;
  }
  const wait = (lastTry.get(message.author.id) ?? 0) + COOLDOWN_MS - Date.now();
  if (wait > 0) {
    await message.delete().catch(() => {});
    await say({ content: `<@${message.author.id}> one screenshot at a time, Operator. Try again in ${Math.ceil(wait / 1000)}s.`, allowedMentions: mention });
    return true;
  }
  lastTry.set(message.author.id, Date.now());

  // Answer at once so the member always sees something, then turn that message into the result (or the error).
  const progress = await channel.send({ content: `<@${message.author.id}> 🔎 Reading your screenshot…`, allowedMentions: mention }).catch(() => null);
  // The reply only has to be seen for a moment: the full record goes to the mod log, so the channel stays clean.
  const finish = async (payload: { content: string; embeds?: EmbedBuilder[] }, ttlMs = 30_000) => {
    const edited = progress ? await progress.edit({ content: payload.content, embeds: payload.embeds ?? [], allowedMentions: mention }).then(() => progress, () => null) : null;
    const shown = edited ?? (await channel.send({ ...payload, allowedMentions: mention }).catch(() => null));
    if (shown) setTimeout(() => void shown.delete().catch(() => {}), ttlMs).unref();
  };
  const work = async () => {
    const guild = message.guild;
    const [member, me] = await Promise.all([message.member ?? guild.members.fetch(message.author.id), guild.members.fetchMe()]);
    const bytes = await download(image.url);
    // The screenshot is in memory now; take it off Discord straight away, whatever happens next.
    await message.delete().catch(() => {});

    const reference = store.getSsReference(guild.id);
    const read = await readCard(ctx, bytes, mimeOf(image.contentType), reference);
    if (read.rankRow) {
      await handleRankRow(ctx, message, member, me, bytes, read.rankRow, finish);
      return;
    }
    const reading = read.reading;
    const mr = masteryRank(reading);
    const clan = checkClan(reading, config.CLAN_NAME, reference !== null);

    const problems = [...clan.problems];
    console.log(`[ssroles] ${message.author.username}: read by ${read.reader}, ${reading.mastery_rank_title ?? 'no rank'}, clan ${reading.clan_name ?? 'none'}, ${problems.length ? `rejected (${problems.length})` : 'accepted'}`);
    if (clan.ok) {
      // The same card, or the same in-game name, can't be used by two Discord accounts.
      const hash = createHash('sha256').update(bytes).digest('hex');
      const ign = reading.in_game_name ? norm(reading.in_game_name) : null;
      // An exact mastery point total belongs to one account, so a card copied from someone else is refused.
      const points = reading.mastery_points ? norm(reading.mastery_points) : null;
      const takenBy =
        store.claimSs(guild.id, 'image', hash, message.author.id) ??
        (ign ? store.claimSs(guild.id, 'ign', ign, message.author.id) : null) ??
        (points ? store.claimSs(guild.id, 'points', points, message.author.id) : null);
      if (takenBy) problems.push('This screenshot, in-game name or exact mastery total was already used by another member. If that is a mistake, ask a moderator.');
    }

    if (problems.length) {
      await finish({ content: `<@${message.author.id}>`, embeds: [resultEmbed(ctx, reading, mr, false, problems.map((p) => `• ${p}`))] }, 60_000);
      await modLog(ctx, {
        action: 'Screenshot rejected',
        moderator: ctx.client.user!,
        target: message.author,
        reason: problems.join(' '),
        fields: [{ name: 'Reader', value: read.reader }],
      });
      return true;
    }

    const earned = earnedNames(reading, mr, config.CLAN_NAME);
    const plan = planRoles(roleInfos(guild), earned, new Set(member.roles.cache.keys()), me.roles.highest.position);
    const reason = 'Screenshot roles: verified profile card';
    const failed: string[] = [];
    const apply = async (m: GuildMember, ids: string[], add: boolean) => {
      for (const id of ids) await (add ? m.roles.add(id, reason) : m.roles.remove(id, reason)).catch(() => failed.push(id));
    };
    await apply(member, plan.add.map((r) => r.id), true);
    await apply(member, plan.remove.map((r) => r.id), false);

    const lines = [
      plan.add.length ? `**Roles added:** ${plan.add.filter((r) => !failed.includes(r.id)).map((r) => `<@&${r.id}>`).join(' ') || '—'}` : 'No new roles to add: you already have everything this card earns.',
      ...(plan.remove.length ? [`**Replaced:** ${plan.remove.map((r) => `~~${r.name}~~`).join(' ')}`] : []),
      ...(plan.skipped.length ? [`Skipped: ${plan.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}`] : []),
      ...(failed.length ? ["Some roles could not be changed. A moderator needs to check Ordis's role position."] : []),
      ...nicknameLine(await syncNickname(member, reading.in_game_name?.split('#')[0] ?? null)),
    ];
    await finish({ content: `<@${message.author.id}>`, embeds: [resultEmbed(ctx, reading, mr, true, lines)] }, 20_000);
    await modLog(ctx, {
      action: 'Screenshot roles',
      moderator: ctx.client.user!,
      target: message.author,
      reason: `Verified: ${reading.mastery_rank_title ?? 'rank unknown'}${mr !== null ? ` (MR ${mr})` : ''}`,
      fields: [
        { name: 'Mastery points', value: reading.mastery_points ?? '—' },
        { name: 'Clan', value: `${reading.clan_name ?? '—'}${reading.clan_tag ? `#${reading.clan_tag}` : ''}${reading.clan_tier_rank ? ` · ${reading.clan_tier_rank}` : ''}` },
        { name: 'In-game name', value: reading.in_game_name ?? 'not shown' },
        { name: 'Accolades', value: reading.accolades.join(', ') || '—' },
        { name: 'Roles added', value: plan.add.map((r) => r.name).join(', ') || '—' },
        { name: 'Roles removed', value: plan.remove.map((r) => r.name).join(', ') || '—' },
        { name: 'Reader', value: read.reader === 'ocr' ? 'OCR' : 'Gemini (OCR could not read it; emblem not compared)' },
      ],
    });
  };
  try {
    await Promise.race([work(), new Promise<never>((_, reject) => setTimeout(() => reject(new UserError("that took too long, so I gave up. Try again in a minute.")), 90_000).unref())]);
  } catch (err) {
    console.error('[ssroles] failed:', err instanceof Error ? err.message : err);
    await message.delete().catch(() => {});
    await finish({ content: `<@${message.author.id}> ${err instanceof UserError ? err.message : 'something went wrong reading that screenshot. Try again later.'}` });
  }
  return true;
}

/** Learns what a genuine clan card looks like from one screenshot, keeping only a fingerprint of the emblem and the clan's name line. */
export async function learnReference(ctx: AppContext, bytes: Uint8Array, mime: string): Promise<string> {
  const pixels = decodeImage(bytes, mime);
  if (!pixels) throw new UserError('The reference must be a PNG or JPG screenshot (not WebP).');
  const parsed = await ocr.recognize(bytes).then(parseCard);
  const { reading } = parsed;
  if (!parsed.complete || !parsed.clanLine || !reading.clan_name || !reading.clan_tag) throw new UserError("I couldn't read a clan name on that screenshot. It must show the Clan panel clearly.");
  if (norm(reading.clan_name) !== norm(ctx.config.CLAN_NAME)) throw new UserError(`That card says the clan is "${reading.clan_name}", not ${ctx.config.CLAN_NAME}.`);
  const box = findEmblem(pixels, parsed.clanLine);
  if (!box) throw new UserError("I couldn't find the clan emblem above the clan name. Use an uncropped screenshot of the Clan panel.");
  const clanText = `${reading.clan_name}#${reading.clan_tag}`;
  ctx.store.setSsReference(ctx.config.DISCORD_GUILD_ID, fingerprint(pixels, box), clanText);
  return clanText;
}

/** Points screenshot roles at a channel, optionally learns the reference card, and posts the instructions there. */
export async function setupSsRoles(ctx: AppContext, channelId: string, reference?: { mime: string; data: Uint8Array }): Promise<string | null> {
  await getSendableChannel(ctx, channelId);
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if ([settings.chatChannelId, settings.honeypotChannelId, settings.verifyChannelId].includes(channelId)) {
    throw new UserError('That channel is used for something else. Pick a channel just for screenshots.');
  }
  if (reference && reference.data.length > MAX_IMAGE_BYTES) throw new UserError('The reference image is over 8 MB.');
  const learned = reference ? await learnReference(ctx, reference.data, reference.mime) : null;
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { ssRolesChannelId: channelId });
  // The example card is public, so its mastery total is reserved for Ordis: posting a copy of the example gets nobody roles.
  reserveExample(ctx);
  const exampleUrl = ctx.config.PUBLIC_URL ? `${ctx.config.PUBLIC_URL}/ss-example.png?v=2 ${ctx.config.PUBLIC_URL}/ss-example-rank.png?v=1` : null;
  // The instructions are the channel's sticky message: always the last thing posted, so new members see them.
  await saveSticky(ctx, {
    channelId,
    userId: ctx.client.user!.id,
    title: '🖼️ Get your roles from a screenshot',
    imageUrl: exampleUrl,
    content: [
      `Open the in-game **Profile** and post a screenshot here. It must show your **Mastery Rank** and your **Clan** panel, which has to be **${ctx.config.CLAN_NAME}** with our emblem. PNG or JPG works best.`,
      'Ordis reads it and gives you the roles it earns: your Mastery Rank, the clan role and accolades such as Ten Year Supporter. Your server nickname is set to your in-game name. This channel is for clan members only, and edited screenshots are rejected.',
      `**Clan rank:** to get **Rat Squire** or **Rat Knight**, also post a screenshot of your row in the in-game clan member list, like the second picture. Post your profile card first: the name on the row has to be the one on your profile. Higher ranks are handed out by leadership. Rat Knight needs MR 16+.`,
      'Your screenshots are deleted right after they are read and are never saved. Post a new one after you rank up and your roles are updated.',
    ].join('\n\n'),
  });
  return learned;
}

export function disableSsRoles(ctx: AppContext): void {
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { ssRolesChannelId: null });
}
