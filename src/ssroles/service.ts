import { createHash } from 'node:crypto';
import { EmbedBuilder, type Guild, type GuildMember, type Message, PermissionFlagsBits } from 'discord.js';
import type { AppContext } from '../context.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { modLog } from '../moderation/service.js';
import { UserError, getSendableChannel } from '../services/clan.js';
import { FINGERPRINT_BYTES, MATCH_THRESHOLD, bestSimilarity, decodeImage, findEmblem, fingerprint } from './emblem.js';
import { ocr } from './ocr.js';
import { type RankRow, parseCard, parseRankRow, parseRankRows, rankFromTitle } from './parse.js';
import { type CardReading, type RoleInfo, SELF_SERVE_RANKS, checkClan, clanRankRoleName, earnedNames, masteryRank, norm, planClanRank, planRoles } from './roles.js';
import { readProfileCard } from './vision.js';
import { saveSticky } from '../sticky/service.js';

/**
 * Screenshots are processed in memory only: nothing is written to disk or the database (just a hash and the
 * in-game name, to stop a card being shared), and the member's message is deleted once it has been read.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const COOLDOWN_MS = 30_000;
/** A message can carry a profile card and a clan roster row together. */
const MAX_IMAGES = 2;
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
  /** Set when the image shows clan roster rows (name and clan rank) instead of a profile card. */
  rankRows?: RankRow[];
}

/** OCR first; Gemini only when OCR can't make sense of the image (unsupported format, unusual layout, unreadable). */
export async function readCard(ctx: AppContext, bytes: Uint8Array, mime: string, reference: Reference | null): Promise<CardRead> {
  const pixels = decodeImage(bytes, mime);
  if (pixels) {
    try {
      const lines = await ocr.recognize(bytes);
      const parsed = parseCard(lines);
      const rankRows = parsed.complete ? [] : parseRankRows(lines);
      if (rankRows.length) return { reading: parsed.reading, reader: 'ocr', emblem: null, rankRows };
      if (!parsed.complete || !parsed.clanLine) {
        const r = parsed.reading;
        console.log(`[ssroles] OCR incomplete (${pixels.width}x${pixels.height}, ${lines.length} lines): card=${r.is_profile_card} rank=${r.mastery_rank_title} points=${r.mastery_points} clan=${r.clan_name} | text: ${lines.map((l) => l.text.trim()).filter(Boolean).join(' / ').slice(0, 300)}`);
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
  const rankRows = reading.is_profile_card ? [] : (reading.roster_rows ?? []).flatMap((r) => { const rank = rankFromTitle(r.rank); return rank ? [{ rank, name: r.name }] : []; });
  if (rankRows.length) return { reading, reader: 'gemini', emblem: null, rankRows };
  return { reading: withReference(reading, reference, null), reader: 'gemini', emblem: null };
}

/** Fills in the clan text and emblem verdicts by comparing with the stored reference. */
function withReference(r: CardReading, reference: Reference | null, emblem: Uint8Array | null): CardReading {
  if (!reference) return r;
  const text = r.clan_name && r.clan_tag ? norm(`${r.clan_name}${r.clan_tag}`) === norm(reference.clanText) : false;
  return {
    ...r,
    clan_text_matches_reference: text,
    emblem_matches_reference: emblem ? bestSimilarity(emblem, reference.fingerprint) >= MATCH_THRESHOLD : null,
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
export async function handleRankRow(
  ctx: AppContext,
  message: Message<true>,
  member: GuildMember,
  me: GuildMember,
  bytes: Uint8Array,
  row: RankRow,
): Promise<Outcome> {
  const { store, config } = ctx;
  const guild = message.guild;
  const problems: string[] = [];
  const verified = store.ssNamesOf(guild.id, message.author.id);
  if (!SELF_SERVE_RANKS.includes(row.rank)) problems.push(`${clanRankRoleName(row.rank)} is given out by clan leadership, not from a screenshot.`);
  else if (!row.name) problems.push("I couldn't read the in-game name next to the rank.");
  else if (!ownsName(verified, row.name)) {
    problems.push(
      verified.length
        ? `"${row.name}" is not one of the in-game names you verified.`
        : `None of your profile cards showed your in-game name, so I can't match "${row.name}" to you. Post a profile screenshot that includes the top of the Profile screen, where your name (Name#1234) is.`,
    );
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
    await modLog(ctx, { action: 'Screenshot rejected', moderator: ctx.client.user!, target: message.author, reason: problems.join(' '), fields: [{ name: 'Clan rank screenshot', value: `${rankName} · ${row.name ?? 'name not read'}` }] });
    return { embed, ttl: 60_000 };
  }

  // A row of the clan member list proves clan membership, so the clan roles come along with the rank.
  const clanRoles = planRoles(roleInfos(guild), new Set(['clan', norm(config.CLAN_NAME)]), new Set(member.roles.cache.keys()), me.roles.highest.position).add;
  const added = [...(plan.add ? [plan.add] : []), ...clanRoles];
  const failed: string[] = [];
  for (const r of added) await member.roles.add(r.id, 'Screenshot roles: clan rank').catch(() => failed.push(r.id));
  for (const r of plan.remove) await member.roles.remove(r.id, 'Screenshot roles: clan rank').catch(() => failed.push(r.id));
  embed
    .setColor(COLORS.success)
    .setTitle('✅ Clan rank verified')
    .setDescription(
      [
        added.length ? `**Roles added:** ${added.filter((r) => !failed.includes(r.id)).map((r) => `<@&${r.id}>`).join(' ') || '—'}` : 'You already have all of these roles.',
        ...(plan.remove.length ? [`**Replaced:** ${plan.remove.map((r) => `~~${r.name}~~`).join(' ')}`] : []),
        ...(failed.length ? ["Some roles could not be changed. A moderator needs to check Ordis's role position."] : []),
        ...nicknameLine(await syncNickname(member, row.name)),
      ].join('\n'),
    );
  await modLog(ctx, {
    action: 'Screenshot roles',
    moderator: ctx.client.user!,
    target: message.author,
    reason: `Verified clan rank: ${rankName}`,
    fields: [
      { name: 'In-game name', value: row.name ?? '—' },
      { name: 'Roles added', value: added.map((r) => r.name).join(', ') || '—' },
      { name: 'Roles removed', value: plan.remove.map((r) => r.name).join(', ') || '—' },
      { name: 'Reader', value: 'OCR' },
    ],
  });
  return { embed, ttl: 20_000 };
}

/** What one screenshot of a message came to: the embed to show and how long it stays up. */
interface Outcome {
  embed: EmbedBuilder;
  ttl: number;
}

/** A profile card: checks the clan, reserves the card, and gives the roles and nickname it earns. */
async function handleCard(
  ctx: AppContext,
  message: Message<true>,
  member: GuildMember,
  me: GuildMember,
  bytes: Uint8Array,
  read: CardRead,
  reference: Reference | null,
): Promise<Outcome> {
  const { config, store } = ctx;
  const guild = message.guild;
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
    await modLog(ctx, {
      action: 'Screenshot rejected',
      moderator: ctx.client.user!,
      target: message.author,
      reason: problems.join(' '),
      fields: [{ name: 'Reader', value: read.reader }],
    });
    return { embed: resultEmbed(ctx, reading, mr, false, problems.map((p) => `• ${p}`)), ttl: 60_000 };
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
  return { embed: resultEmbed(ctx, reading, mr, true, lines), ttl: 20_000 };
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
  const images = [...message.attachments.filter((a) => IMAGE_TYPES.has(mimeOf(a.contentType)) && a.size <= MAX_IMAGE_BYTES).values()].slice(0, MAX_IMAGES);
  if (!images.length) {
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
    // Every screenshot is in memory now; take the message off Discord straight away, whatever happens next.
    const downloads = await Promise.all(images.map(async (image) => ({ bytes: await download(image.url), mime: mimeOf(image.contentType) })));
    await message.delete().catch(() => {});

    // Read them all first, then handle profile cards before clan rows: the row's name has to be one a card just verified.
    const reference = store.getSsReference(guild.id);
    const reads = [];
    for (const d of downloads) reads.push({ ...d, read: await readCard(ctx, d.bytes, d.mime, reference) });
    reads.sort((a, b) => Number(Boolean(a.read.rankRows?.length)) - Number(Boolean(b.read.rankRows?.length)));

    const outcomes: Outcome[] = [];
    for (const { bytes, read } of reads) {
      if (read.rankRows?.length) {
        // On a picture of the whole member list, take the row whose name this member verified.
        const mine = store.ssNamesOf(guild.id, message.author.id);
        const row = read.rankRows.find((r) => r.name && ownsName(mine, r.name)) ?? read.rankRows[0]!;
        outcomes.push(await handleRankRow(ctx, message, member, me, bytes, row));
      } else outcomes.push(await handleCard(ctx, message, member, me, bytes, read, reference));
    }
    const extra = message.attachments.size > images.length ? 'Only the first two pictures of a message are read.' : '';
    await finish({ content: `<@${message.author.id}>${extra ? ` ${extra}` : ''}`, embeds: outcomes.map((o) => o.embed) }, Math.max(...outcomes.map((o) => o.ttl)));
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

export interface ReferenceResult {
  /** "Name#043" of the clan card(s) learned, or null when only roster rows were given. */
  clanText: string | null;
  cards: number;
  /** Clan roster rows that were recognized (checked, nothing stored). */
  rows: RankRow[];
}

/**
 * Learns from up to two reference screenshots, each recognized by what it shows: a profile card teaches the clan emblem
 * and name line (kept as a tiny fingerprint; two cards, e.g. from different screen sizes, are both kept), and a clan
 * roster row is only checked, to confirm the reader understands that layout. No screenshot is saved.
 */
export async function learnReferences(ctx: AppContext, images: { mime: string; data: Uint8Array }[]): Promise<ReferenceResult> {
  const fingerprints: Uint8Array[] = [];
  const rows: RankRow[] = [];
  let clanText: string | null = null;
  for (const [i, image] of images.entries()) {
    const which = images.length > 1 ? `Picture ${i + 1}: ` : '';
    const pixels = decodeImage(image.data, image.mime);
    if (!pixels) throw new UserError(`${which}the reference must be a PNG or JPG screenshot (not WebP).`);
    const lines = await ocr.recognize(image.data);
    const parsed = parseCard(lines);
    const { reading } = parsed;
    if (!parsed.complete) {
      const row = parseRankRow(lines);
      if (!row) throw new UserError(`${which}I couldn't read that as a profile card or as a row of the clan member list. Use an uncropped screenshot.`);
      rows.push(row);
      continue;
    }
    if (!parsed.clanLine || !reading.clan_name || !reading.clan_tag) throw new UserError(`${which}I couldn't read a clan name on that screenshot. It must show the Clan panel clearly.`);
    if (norm(reading.clan_name) !== norm(ctx.config.CLAN_NAME)) throw new UserError(`${which}that card says the clan is "${reading.clan_name}", not ${ctx.config.CLAN_NAME}.`);
    const box = findEmblem(pixels, parsed.clanLine);
    if (!box) throw new UserError(`${which}I couldn't find the clan emblem above the clan name. Use an uncropped screenshot of the Clan panel.`);
    const text = `${reading.clan_name}#${reading.clan_tag}`;
    if (clanText && norm(clanText) !== norm(text)) throw new UserError(`${which}the two cards show different clans (${clanText} and ${text}).`);
    clanText = text;
    fingerprints.push(fingerprint(pixels, box));
  }
  if (clanText) {
    const blob = new Uint8Array(fingerprints.length * FINGERPRINT_BYTES);
    fingerprints.forEach((f, i) => blob.set(f, i * FINGERPRINT_BYTES));
    ctx.store.setSsReference(ctx.config.DISCORD_GUILD_ID, blob, clanText);
  }
  return { clanText, cards: fingerprints.length, rows };
}

/** Points screenshot roles at a channel, optionally learns the reference card, and posts the instructions there. */
export async function setupSsRoles(ctx: AppContext, channelId: string, references: { mime: string; data: Uint8Array }[] = []): Promise<ReferenceResult | null> {
  await getSendableChannel(ctx, channelId);
  const settings = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID);
  if ([settings.chatChannelId, settings.honeypotChannelId, settings.verifyChannelId].includes(channelId)) {
    throw new UserError('That channel is used for something else. Pick a channel just for screenshots.');
  }
  if (references.some((r) => r.data.length > MAX_IMAGE_BYTES)) throw new UserError('A reference image is over 8 MB.');
  const learned = references.length ? await learnReferences(ctx, references) : null;
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
      `**① Profile card** (first picture): open the in-game **Profile** and post a screenshot. It must show your **Mastery Rank** and your **Clan** panel, which has to be **${ctx.config.CLAN_NAME}** with our emblem. You get your Mastery Rank role, the clan role and accolades such as Ten Year Supporter, and your server nickname becomes your in-game name.`,
      '**② Clan rank** (second picture): to get **Rat Squire** or **Rat Knight**, also post a screenshot of your row in the in-game clan member list. Attach both pictures to the same message and Ordis handles them together; the name on the row has to be the one on your profile. Rat Knight needs MR 16+. Higher ranks are handed out by leadership.',
      'This channel is for clan members only and edited screenshots are rejected. Your screenshots are deleted right after they are read and are never saved. Post a new one after you rank up and your roles are updated.',
    ].join('\n\n'),
  });
  return learned;
}

export function disableSsRoles(ctx: AppContext): void {
  ctx.store.updateSettings(ctx.config.DISCORD_GUILD_ID, { ssRolesChannelId: null });
}
