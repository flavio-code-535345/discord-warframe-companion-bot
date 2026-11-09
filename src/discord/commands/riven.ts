import {
  ActionRowBuilder,
  type Attachment,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandStringOption,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { QueueFullError, screenshotQueue } from '../../queue.js';
import { recordResult, recordScan } from '../../rivens/channel.js';
import { type FoundRivens, type RivenFilter, describeFilter, findRivens, resolveFilter } from '../../rivens/find.js';
import { getRivenWeapons, searchPageUrl } from '../../rivens/market.js';
import { rivenReplies } from '../../rivens/reply.js';
import { type ScanResult, scanCard } from '../../rivens/scan.js';
import { gradeFor, rivenStatus, topFor } from '../../rivens/service.js';
import { MAX_RIVEN_WATCHES, RIVEN_WATCH_MS, noteMatches } from '../../rivens/watch.js';
import { UserError } from '../../services/clan.js';
import { withTimeout } from '../../timeout.js';
import { MAX_TRACKERS_PER_USER, type TrackerSpec, parseSpec } from '../../trackers.js';
import { searchItems } from '../../warframe/market.js';
import type { Command } from '../command.js';
import { e } from '../emoji.js';
import { COLORS } from '../embeds.js';
import { rivenFindEmbed, rivenGradeEmbed, rivenStatusEmbed, rivenTopEmbed } from '../riven-embeds.js';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SCAN_LIMIT_MS = 90_000;
/** /riven find and /riven watch may answer from a search made this recently (warframe.market is asked at most once per 5 minutes per filter). */
const FIND_TTL_MS = 5 * 60_000;

type RivenSpec = Extract<TrackerSpec, { kind: 'riven' }>;

/**
 * Riven analyzer. Grades a riven by how common its rolls are among the expensive listings on warframe.market, shows what sells for a
 * weapon, finds the cheapest rivens for sale that match, and watches for new ones. The listings come from the slow background read
 * (rivens/crawler.ts) or one fresh read when nothing recent is stored; find and watch ask the market's own filtered search.
 */
const weaponOption = (o: SlashCommandStringOption) => o.setName('weapon').setDescription('The weapon').setRequired(true).setAutocomplete(true);

/** The picture's type when it is one the reader handles, else a UserError. */
function imageType(image: Attachment): string {
  const mime = (image.contentType ?? '').split(';')[0]!.trim();
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') throw new UserError('Attach a PNG, JPG or WebP screenshot (other formats cannot be read).');
  if (image.size > MAX_IMAGE_BYTES) throw new UserError('That picture is over 8 MB. Crop it to the riven card and try again.');
  return mime;
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new UserError("I couldn't download that image.");
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Reads a riven from a screenshot (and, with `compare`, a second one, to see which roll to keep): waits its turn in the screenshot
 * queue (a slow reader works on one at a time), then OCRs and grades.
 */
async function scan(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const images = [interaction.options.getAttachment('image', true), interaction.options.getAttachment('compare')].filter((a): a is Attachment => a !== null);
  const types = images.map(imageType);

  const queueText = (n: number) => `⏳ **Ordis is reading other screenshots.** ${n <= 1 ? "You're **next in line**" : `You're **#${n}** in the queue`}.`;
  const reading = images.length > 1 ? '🔎 Reading your rivens…' : '🔎 Reading your riven…';
  let ready = false;
  const edit = (content: string) => void interaction.editReply({ content, embeds: [] }).catch(() => {});
  let ticket: ReturnType<typeof screenshotQueue.join>;
  try {
    ticket = screenshotQueue.join(interaction.user.id, (n) => {
      if (n > 0 && !ready) edit(queueText(n));
    });
  } catch (err) {
    if (!(err instanceof QueueFullError)) throw err;
    throw new UserError(err.reason === 'user' ? 'Two of your screenshots are already waiting. Wait for those first.' : 'Too many screenshots are waiting right now. Try again in a few minutes.');
  }
  try {
    edit(ticket.position() > 0 ? queueText(ticket.position()) : reading);
    const downloads = Promise.all(images.map((image) => download(image.url)));
    downloads.catch(() => {});
    await ticket.ready;
    ready = true;
    edit(reading);
    const results = await withTimeout(
      (async () => {
        const out: ScanResult[] = [];
        for (const [i, bytes] of (await downloads).entries()) {
          const result = await scanCard(ctx, bytes, types[i]!);
          recordResult('command', interaction.user.username, result);
          out.push(result);
        }
        return out;
      })(),
      SCAN_LIMIT_MS,
      () => new UserError('That took too long, so I gave up. Try again in a minute.'),
    );
    const reply = await rivenReplies(results);
    await interaction.editReply({ content: reply.content, embeds: reply.embeds, files: reply.files });
  } catch (err) {
    // Replace the "Reading your riven…" placeholder with the problem, otherwise it stays on screen as if still working.
    recordScan({ via: 'command', userName: interaction.user.username, weapon: null, letter: null, ms: 0, ok: false, note: err instanceof Error ? err.message : 'error' });
    if (!(err instanceof UserError)) console.error('[riven] /riven scan failed:', err instanceof Error ? (err.stack ?? err.message) : err);
    await interaction.editReply({ content: `❌ ${err instanceof UserError ? err.message : 'Something went wrong reading that. Try again in a minute.'}`, embeds: [] }).catch(() => {});
  } finally {
    ticket.release();
  }
}

/** The filter options /riven find and /riven watch share. */
function filterOptions(interaction: ChatInputCommandInteraction, maxRequired: boolean) {
  return {
    weapon: interaction.options.getString('weapon', true),
    bonuses: interaction.options.getString('bonuses', true),
    curse: interaction.options.getString('curse'),
    maxPrice: interaction.options.getInteger('max_price', maxRequired),
  };
}

const searchButton = (filter: RivenFilter) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(searchPageUrl(filter.weapon.slug, filter.positives, filter.negative)).setLabel('Open on warframe.market'),
  );

async function find(interaction: ChatInputCommandInteraction): Promise<void> {
  const { filter, names, units } = await resolveFilter(filterOptions(interaction, false));
  const found = await findRivens(filter, { ttlMs: FIND_TTL_MS });
  const inGame = interaction.options.getBoolean('in_game') ?? false;
  await interaction.editReply({ embeds: [rivenFindEmbed(filter, found, names, units, { inGame })], components: [searchButton(filter)] });
}

/** Same weapon, bonuses and curse rule: another watch for it would only differ in price, which is a change of mind, not a second watch. */
const sameRiven = (a: RivenSpec, b: RivenSpec) =>
  a.weapon === b.weapon && [...a.positives].sort().join() === [...b.positives].sort().join() && (a.negative ?? null) === (b.negative ?? null) && Boolean(a.noCurse) === Boolean(b.noCurse);

async function watch(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const userId = interaction.user.id;
  const { filter, names } = await resolveFilter(filterOptions(interaction, true));
  const mine = ctx.store.listTrackers(guildId, userId).map((t) => ({ t, spec: parseSpec(t.spec) }));
  if (mine.length >= MAX_TRACKERS_PER_USER) throw new UserError(`You already have ${MAX_TRACKERS_PER_USER} trackers. Remove one with \`/track remove\`.`);
  const watches = mine.filter((x): x is { t: (typeof mine)[number]['t']; spec: RivenSpec } => x.spec?.kind === 'riven');
  const spec: RivenSpec = {
    kind: 'riven',
    weapon: filter.weapon.slug,
    weaponName: filter.weapon.name,
    positives: filter.positives,
    ...(filter.negative ? { negative: filter.negative } : {}),
    ...(filter.noCurse ? { noCurse: true } : {}),
    maxPrice: filter.maxPrice!,
    label: describeFilter({ ...filter, maxPrice: null }, names),
  };
  const twin = watches.find((w) => sameRiven(w.spec, spec));
  if (twin) throw new UserError(`You already watch for that riven (#${twin.t.id}, at most ${twin.spec.maxPrice}p). To change the price, remove it with \`/track remove id:${twin.t.id}\` and watch again.`);
  if (watches.length >= MAX_RIVEN_WATCHES) throw new UserError(`You can watch for ${MAX_RIVEN_WATCHES} rivens at a time. Remove one with \`/track remove\` first.`);

  // One search now (someone is asking, so it is not background work): what is already for sale is shown here and never sent as new.
  let found: FoundRivens | null = null;
  try {
    found = await findRivens(filter, { ttlMs: FIND_TTL_MS });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
  }
  const tracker = ctx.store.createTracker(guildId, userId, JSON.stringify(spec));
  if (found) noteMatches(ctx, tracker.id, spec, found.listings);
  const count = found?.listings.length ?? 0;
  const now = !found
    ? "I couldn't check warframe.market just now. My first check in a few minutes notes what is already for sale, and then I DM you about new ones."
    : count
      ? `Right now **${count}${found.complete ? '' : '+'}** ${count === 1 ? 'is' : 'are'} for sale, the cheapest at **${found.listings[0]!.price.toLocaleString('en-US')}p** (\`/riven find\` lists them). I DM you about the ones listed from now on.`
      : 'Nobody is selling one like that right now. I DM you as soon as one is listed.';
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(`🔔 Riven watch #${tracker.id}`)
    .setDescription(
      `${e('riven')} **${filter.weapon.name}** riven with ${spec.label}, at most **${spec.maxPrice.toLocaleString('en-US')}p**.\n\n${now}\n\n-# I check warframe.market every ${RIVEN_WATCH_MS / 60_000} minutes. The DM needs your DMs open for this server. Remove the watch with /track remove.`,
    );
  await interaction.editReply({ embeds: [embed], components: [searchButton(filter)] });
}

const bonusesOption = (description: string) => (o: SlashCommandStringOption) => o.setName('bonuses').setDescription(description).setRequired(true).setMaxLength(200);
const curseOption = (o: SlashCommandStringOption) => o.setName('curse').setDescription('The curse it must have (e.g. zoom), or "none" for no curse; any curse when left out').setMaxLength(60);

export const riven: Command = {
  data: new SlashCommandBuilder()
    .setName('riven')
    .setDescription('Grade, find and watch for rivens with warframe.market')
    .addSubcommand((s) =>
      s
        .setName('grade')
        .setDescription('Grade a riven roll and see what similar ones are listed for')
        .addStringOption(weaponOption)
        .addStringOption(bonusesOption('The 2 or 3 bonus stats, e.g. "cc cd ms" or "Critical Chance 180, Multishot 120"'))
        .addStringOption((o) => o.setName('curse').setDescription('The curse, if any, e.g. zoom').setMaxLength(60)),
    )
    .addSubcommand((s) =>
      s
        .setName('scan')
        .setDescription('Grade a riven from a screenshot of its card, or compare two rolls')
        .addAttachmentOption((o) => o.setName('image').setDescription('A PNG, JPG or WebP of the unveiled riven card (cropped to the card works best)').setRequired(true))
        .addAttachmentOption((o) => o.setName('compare').setDescription('A second riven of the same weapon (the new roll after cycling): which one to keep')),
    )
    .addSubcommand((s) =>
      s
        .setName('find')
        .setDescription('The cheapest rivens for sale with these stats')
        .addStringOption(weaponOption)
        .addStringOption(bonusesOption('1 to 3 bonus stats it must have, e.g. "cc cd" or "Critical Chance, Multishot"'))
        .addStringOption(curseOption)
        .addIntegerOption((o) => o.setName('max_price').setDescription('The most it may cost, in platinum').setMinValue(1).setMaxValue(1_000_000))
        .addBooleanOption((o) => o.setName('in_game').setDescription('Only sellers who are in the game right now')),
    )
    .addSubcommand((s) =>
      s
        .setName('watch')
        .setDescription('Get a DM when a riven with these stats is listed at your price')
        .addStringOption(weaponOption)
        .addStringOption(bonusesOption('1 to 3 bonus stats it must have, e.g. "cc cd" or "Critical Chance, Multishot"'))
        .addIntegerOption((o) => o.setName('max_price').setDescription('The most you would pay, in platinum').setRequired(true).setMinValue(1).setMaxValue(1_000_000))
        .addStringOption(curseOption),
    )
    .addSubcommand((s) => s.setName('top').setDescription('Which rolls the expensive rivens of a weapon have').addStringOption(weaponOption))
    .addSubcommand((s) => s.setName('status').setDescription('How much riven data the bot has gathered'))
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply(sub === 'status' || sub === 'watch' ? { flags: MessageFlags.Ephemeral } : {});
    if (sub === 'status') {
      await interaction.editReply({ embeds: [rivenStatusEmbed(await rivenStatus(ctx))] });
    } else if (sub === 'scan') {
      await scan(interaction, ctx);
    } else if (sub === 'find') {
      await find(interaction);
    } else if (sub === 'watch') {
      await watch(interaction, ctx);
    } else if (sub === 'top') {
      await interaction.editReply({ embeds: [rivenTopEmbed(await topFor(ctx, interaction.options.getString('weapon', true)))] });
    } else {
      const report = await gradeFor(ctx, {
        weapon: interaction.options.getString('weapon', true),
        positives: interaction.options.getString('bonuses', true),
        negative: interaction.options.getString('curse') ?? undefined,
      });
      await interaction.editReply({ embeds: [rivenGradeEmbed(report)] });
    }
  },

  async autocomplete(interaction) {
    const weapons = await getRivenWeapons();
    const matches = searchItems(weapons, interaction.options.getFocused());
    await interaction.respond(matches.map((w) => ({ name: w.name.slice(0, 100), value: w.slug })));
  },
};
