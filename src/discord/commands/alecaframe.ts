import { AttachmentBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags, type SlashCommandBooleanOption, SlashCommandBuilder } from 'discord.js';
import { fetchRelics, fetchStats, forgetToken, shares, tokenFrom } from '../../alecaframe/api.js';
import { drawStatsChart } from '../../alecaframe/chart.js';
import { planRelics } from '../../alecaframe/planner.js';
import type { AppContext } from '../../context.js';
import type { AlecaLink } from '../../db.js';
import { UserError } from '../../services/clan.js';
import { loadRelicBook } from '../../warframe/relics.js';
import { alecaStatsEmbed, relicPlanEmbed, sharedText } from '../alecaframe-embeds.js';
import type { Command } from '../command.js';
import { e } from '../emoji.js';
import { COLORS } from '../embeds.js';
import { footer } from '../style.js';

/**
 * /alecaframe: a member links their AlecaFrame public-link token (read-only, made and revoked in AlecaFrame), then sees their currency
 * history as a chart, their trades, and their relics valued with WFInfo's prices. Each member links only their own account; the token is
 * kept until they unlink, and nothing AlecaFrame answers is stored.
 */

const HOW_TO =
  'In AlecaFrame open the **Stats** tab, press **Create Public Link**, tick what to share (tick **Relics** for `/alecaframe relics`), press **Generate token** and copy the token (or the whole link).';

const PERIODS: Record<string, { days: number | null; label: string }> = {
  '7d': { days: 7, label: 'Last 7 days' },
  '30d': { days: 30, label: 'Last 30 days' },
  '90d': { days: 90, label: 'Last 90 days' },
  '1y': { days: 365, label: 'Last year' },
  all: { days: null, label: 'All time' },
};

const CHART_FILE = 'alecaframe-stats.png';

function linkOf(ctx: AppContext, userId: string): AlecaLink {
  const link = ctx.store.getAlecaLink(userId);
  if (!link) throw new UserError(`Link your AlecaFrame first with \`/alecaframe link\`. ${HOW_TO}`);
  return link;
}

async function link(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const token = tokenFrom(interaction.options.getString('token', true));
  if (!token) throw new UserError(`That doesn't look like an AlecaFrame token. ${HOW_TO}`);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const stats = await fetchStats(token);
  ctx.store.setAlecaLink(interaction.user.id, { token, username: stats.username, parts: stats.parts });
  const relicsHint = shares(stats.parts, 'relics') || stats.parts === 0 ? '' : '\n\nThis link does not share your relics, so `/alecaframe relics` cannot plan them. Make a new link with **Relics** ticked and link it again.';
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(`${e('warframe')} AlecaFrame linked`)
    .setDescription(
      `Linked${stats.username ? ` **${stats.username}**` : ''}. This link shares ${sharedText(stats.parts)}.\n\n\`/alecaframe stats\` shows your currencies and trades, \`/alecaframe relics\` what your relics are worth.${relicsHint}\n\n-# Only you see these unless you choose to share them. \`/alecaframe unlink\` removes the token, and deleting the link in AlecaFrame stops it working anywhere.`,
    )
    .setFooter(footer('AlecaFrame'));
  await interaction.editReply({ embeds: [embed] });
}

async function unlink(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const known = ctx.store.getAlecaLink(interaction.user.id);
  if (known) forgetToken(known.token);
  const removed = ctx.store.removeAlecaLink(interaction.user.id);
  await interaction.reply({
    content: removed ? '✅ Unlinked. Ordis no longer has your AlecaFrame token. To stop the token working anywhere, delete the link in AlecaFrame too.' : 'Your AlecaFrame is not linked.',
    flags: MessageFlags.Ephemeral,
  });
}

async function stats(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const known = linkOf(ctx, interaction.user.id);
  const share = interaction.options.getBoolean('share') ?? false;
  const period = PERIODS[interaction.options.getString('period') ?? '30d'] ?? PERIODS['30d']!;
  await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
  const data = await fetchStats(known.token);
  if (data.username !== known.username || data.parts !== known.parts) ctx.store.updateAlecaLink(known.userId, data.username, data.parts);
  const since = period.days === null ? (data.points[0]?.at ?? 0) : Date.now() - period.days * 86_400_000;
  let chart: Buffer | null = null;
  try {
    chart = await drawStatsChart(data, { since, periodLabel: period.label });
  } catch (err) {
    console.error('[alecaframe] chart failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  }
  const embed = alecaStatsEmbed(data, { since, periodLabel: period.label, image: chart ? `attachment://${CHART_FILE}` : null });
  await interaction.editReply({ embeds: [embed], files: chart ? [new AttachmentBuilder(chart, { name: CHART_FILE })] : [] });
}

async function relics(interaction: ChatInputCommandInteraction, ctx: AppContext): Promise<void> {
  const known = linkOf(ctx, interaction.user.id);
  if (known.parts !== 0 && !shares(known.parts, 'relics')) {
    throw new UserError(`Your AlecaFrame link does not share your relics. ${HOW_TO} Then link the new token with \`/alecaframe link\`.`);
  }
  const share = interaction.options.getBoolean('share') ?? false;
  await interaction.deferReply(share ? {} : { flags: MessageFlags.Ephemeral });
  const [owned, book] = await Promise.all([
    fetchRelics(known.token),
    loadRelicBook().catch(() => {
      throw new UserError('The relic price list could not be read right now. Try again later.');
    }),
  ]);
  if (!owned.length) throw new UserError('AlecaFrame lists no relics for you. It reads your inventory while the game runs with AlecaFrame open.');
  await interaction.editReply({ embeds: [relicPlanEmbed(known.username, planRelics(owned, book), { stale: book.stale })] });
}

const shareOption = (description: string) => (o: SlashCommandBooleanOption) => o.setName('share').setDescription(description);

export const alecaframe: Command = {
  data: new SlashCommandBuilder()
    .setName('alecaframe')
    .setDescription('Your AlecaFrame stats, trades and relics')
    .addSubcommand((s) =>
      s
        .setName('link')
        .setDescription('Link your AlecaFrame public-link token (read-only; only you see the answer)')
        .addStringOption((o) => o.setName('token').setDescription('The token, or the whole link, from AlecaFrame → Stats → Create Public Link').setRequired(true).setMaxLength(600)),
    )
    .addSubcommand((s) => s.setName('unlink').setDescription('Remove your AlecaFrame token from Ordis'))
    .addSubcommand((s) =>
      s
        .setName('stats')
        .setDescription('Your platinum, ducats, endo and the rest over time, with your latest trades')
        .addStringOption((o) =>
          o
            .setName('period')
            .setDescription('How far back (default: 30 days)')
            .addChoices({ name: '7 days', value: '7d' }, { name: '30 days', value: '30d' }, { name: '90 days', value: '90d' }, { name: 'A year', value: '1y' }, { name: 'All time', value: 'all' }),
        )
        .addBooleanOption(shareOption('Post it in the channel instead of only to you')),
    )
    .addSubcommand((s) =>
      s
        .setName('relics')
        .setDescription('What your relics are worth: the best to open and the ones worth refining')
        .addBooleanOption(shareOption('Post it in the channel instead of only to you')),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'link') await link(interaction, ctx);
    else if (sub === 'unlink') await unlink(interaction, ctx);
    else if (sub === 'stats') await stats(interaction, ctx);
    else await relics(interaction, ctx);
  },
};
