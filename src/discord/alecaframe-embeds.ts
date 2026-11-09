import { EmbedBuilder } from 'discord.js';
import { type AlecaStats, type Share, type Trade, type TradeItem, sharedList, shares } from '../alecaframe/api.js';
import { amount, statSeries } from '../alecaframe/chart.js';
import type { RelicPlan } from '../alecaframe/planner.js';
import { discordTime } from '../time.js';
import { type EmojiName, e, tierEmoji } from './emoji.js';
import { COLORS, clampLines } from './embeds.js';
import { platText } from './lookup-embeds.js';
import { footer, heading } from './style.js';

/** The embeds of /alecaframe: a member's stats over a period (with the chart as its picture) and their relics, valued. */

const CURRENCY_EMOJI: Record<string, EmojiName> = { plat: 'platinum', ducats: 'ducats', endo: 'endo', credits: 'credits', aya: 'aya', vitus: 'vitus' };

const SHARE_LABEL: Record<Share, string> = {
  trades: 'trades',
  platinum: 'platinum',
  ducats: 'ducats',
  endo: 'endo',
  credits: 'credits',
  account: 'MR and completion',
  aya: 'Aya',
  relics: 'relics',
  vitus: 'Vitus Essence',
};

/** "platinum, ducats and relics". */
export function sharedText(parts: number): string {
  const names = sharedList(parts).map((s) => SHARE_LABEL[s]);
  if (!names.length) return 'nothing';
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const itemText = (i: TradeItem) => `${i.count > 1 ? `${i.count}× ` : ''}${i.name}${i.rank ? ` (R${i.rank})` : ''}`;

function itemsText(items: readonly TradeItem[]): string {
  if (!items.length) return 'nothing';
  const shown = items.slice(0, 3).map(itemText).join(', ');
  return items.length > 3 ? `${shown} and ${items.length - 3} more` : shown;
}

/** One trade without the other player's name. */
export function tradeLine(t: Trade): string {
  const when = discordTime(t.at, 'd');
  const plat = t.plat !== null ? ` for **${t.plat.toLocaleString('en-US')}p**` : '';
  if (t.kind === 'sale') return `${when} Sold ${itemsText(t.gave)}${plat}`;
  if (t.kind === 'purchase') return `${when} Bought ${itemsText(t.got)}${plat}`;
  return `${when} Traded ${itemsText(t.gave)} for ${itemsText(t.got)}`;
}

export function alecaStatsEmbed(stats: AlecaStats, opts: { since: number; periodLabel: string; image?: string | null }): EmbedBuilder {
  const series = statSeries(stats, opts.since);
  const lines = series.map((s) => {
    const change = s.change ? ` · ${s.change > 0 ? '+' : '−'}${amount(Math.abs(s.change), s.compact)}` : '';
    return `${e(CURRENCY_EMOJI[s.key] ?? 'warframe')} **${amount(s.now, s.compact)}** ${s.label.toLowerCase()}${change}`;
  });
  const last = stats.points.at(-1);
  const account = last && shares(stats.parts, 'account') ? [last.mr ? `MR ${last.mr}` : null, last.completion ? `${last.completion}% complete` : null].filter(Boolean).join(' · ') : '';
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(`${e('warframe')} ${stats.username ?? 'AlecaFrame stats'}`)
    .setDescription([account ? `-# ${account}` : null, ...lines].filter(Boolean).join('\n') || 'This link shares no currencies.')
    .setFooter(footer(`AlecaFrame · ${opts.periodLabel}`));
  if (stats.updatedAt) embed.setTimestamp(stats.updatedAt);

  // Relics opened is part of every reading; the change over the period is what is interesting.
  const inPeriod = stats.points.filter((p) => p.at >= opts.since);
  const before = stats.points.filter((p) => p.at < opts.since).at(-1);
  const first = before ?? inPeriod[0];
  if (last && first && last.relicsOpened > 0) {
    const opened = last.relicsOpened - first.relicsOpened;
    embed.addFields({ name: `${e('voidTraces')} Relics opened`, value: `**${opened.toLocaleString('en-US')}** in this period · ${last.relicsOpened.toLocaleString('en-US')} in all`, inline: true });
  }
  if (shares(stats.parts, 'trades') || (stats.parts === 0 && stats.trades.length)) {
    const trades = stats.trades.filter((t) => t.at >= opts.since);
    const sold = trades.filter((t) => t.kind === 'sale').reduce((s, t) => s + (t.plat ?? 0), 0);
    const bought = trades.filter((t) => t.kind === 'purchase').reduce((s, t) => s + (t.plat ?? 0), 0);
    embed.addFields({
      name: `${e('platinum')} Trading`,
      value: trades.length ? `**${trades.length}** trades · sold for **${sold.toLocaleString('en-US')}p** · bought for **${bought.toLocaleString('en-US')}p**` : 'No trades in this period.',
      inline: true,
    });
    if (trades.length) embed.addFields({ name: 'Latest trades', value: clampLines(trades.slice(0, 5).map(tradeLine), 1024) });
  }
  if (opts.image) embed.setImage(opts.image);
  return embed;
}

export function relicPlanEmbed(username: string | null, plan: RelicPlan, opts: { stale: boolean }): EmbedBuilder {
  const t = plan.totals;
  const summary = [
    `**${t.relics.toLocaleString('en-US')}** relics, ${t.kinds} kinds`,
    `worth about **${Math.round(t.value).toLocaleString('en-US')}p** opened alone`,
    t.vaulted ? `${t.vaulted} vaulted 🔒` : null,
    t.unknown ? `${t.unknown} without prices (Requiem and new relics)` : null,
  ].filter(Boolean);
  const open = plan.open.map(
    (r) =>
      `${tierEmoji(r.tier)} **${r.name}** ${r.refinement} ×${r.count}${r.vaulted ? ' 🔒' : ''} · **${platText(r.solo)}** a run${r.best?.plat ? ` · ${r.best.item} ${platText(r.best.plat)}` : ''}`,
  );
  const refine = plan.refine.map(
    (x) => `${tierEmoji(x.relic.tier)} **${x.relic.name}** ${x.relic.refinement} ×${x.relic.count} · **+${platText(x.gain)}** a run for ${x.traces} ${e('voidTraces')}`,
  );
  const embed = new EmbedBuilder()
    .setColor(COLORS.void)
    .setTitle(heading('relic', username ? `${username}'s relics` : 'Your relics'))
    .setDescription(summary.join(' · '));
  if (open.length) embed.addFields({ name: 'Best to open', value: clampLines(open, 1024) });
  if (refine.length) embed.addFields({ name: 'Worth refining to Radiant', value: clampLines(refine, 1024) });
  if (!open.length) embed.addFields({ name: 'Best to open', value: 'None of your relics are in the price list.' });
  return embed.setFooter(
    footer(`A run's worth is every reward's average price times its chance · prices: WFInfo${opts.stale ? ' (cached)' : ''} · relics: AlecaFrame. Vaulted relics often sell for more than they hold`),
  );
}
