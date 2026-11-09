import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ContainerBuilder, type MessageActionRowComponentBuilder, StringSelectMenuBuilder } from 'discord.js';
import { discordTime } from '../../time.js';
import { type ArbitrationData, type ArbitrationSlot, type ArbyTier, TIERS, TIER_HINT, atLeast } from '../../warframe/arbitrations.js';
import { e, emojiUrl, factionTag } from '../emoji.js';
import { buttonRow, mineButton, notifyRow, roleButton } from './controls.js';
import { DIVIDER, GAP, card, section } from './parts.js';
import { type FeedInput, type FeedPing, STALE_NOTE } from './types.js';

/**
 * ⚖️┃arbitrations: four messages, read from the bottom up like a channel is: the one running now with what comes next and the
 * controls (last, so it is what the channel opens on), above it the next 24 hours and the 24 after that, and at the top the week's
 * S and A tier hours. Each hour is one line: its tier, when it starts (in the reader's own time zone), the node, the mission and the
 * faction. The tiers are the Arbitration Goons' (arbi.guide), the schedule is browse.wf's (warframe/arbitrations.ts).
 */

const HOUR = 3_600_000;

export const TIER_COLOR: Record<ArbyTier, number> = { S: 0xf5c542, A: 0xa855f7, B: 0x3b82f6, C: 0x22c55e, D: 0x94a3b8, F: 0x64748b };
const TIER_NAME: Record<ArbyTier, string> = { S: 'S tier', A: 'A tier', B: 'B tier', C: 'C tier', D: 'D tier', F: 'F tier' };

export const tierBadge = (tier: ArbyTier): string => e(`tier${tier}`);

/** "Casta, Ceres · Defense · <Grineer>"; the node bold from B tier up, so the good hours stand out in a long list. */
function where(s: ArbitrationSlot): string {
  const name = atLeast(s.tier, 'B') ? `**${s.name}**` : s.name;
  const faction = factionTag(s.faction);
  return [`${name}${s.planet ? `, ${s.planet}` : ''}`, s.mission, faction].filter(Boolean).join(' · ');
}

/** One hour of the schedule. D and F hours are small print: they are listed for completeness, not for farming. */
export function slotLine(s: ArbitrationSlot, opts: { date?: boolean } = {}): string {
  const when = opts.date ? `${discordTime(s.start, 'f')} · ${discordTime(s.start, 'R')}` : discordTime(s.start, 't');
  const line = `${tierBadge(s.tier)} ${when} · ${where(s)}`;
  return atLeast(s.tier, 'C') ? line : `-# ${line}`;
}

const lines = (slots: ArbitrationSlot[], opts: { date?: boolean } = {}) => slots.map((s) => slotLine(s, opts)).join('\n');

/** The tiers counted, best first: "S 1 · A 3 · B 8". */
function tierCounts(slots: ArbitrationSlot[], from: ArbyTier = 'S', to: ArbyTier = 'B'): string {
  return TIERS.filter((t) => atLeast(t, to) && atLeast(from, t))
    .map((t) => [t, slots.filter((s) => s.tier === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${tierBadge(t)} ${n}`)
    .join(' · ');
}

const SOURCES = '-# Tiers by the Arbitration Goons (arbi.guide) · schedule from browse.wf · times in your own time zone';

/** The selectable ranges of "Plan ahead". */
export const PLAN_RANGES = {
  sa14: { label: 'S and A tier, next 14 days', min: 'A', days: 14 },
  b7: { label: 'B tier or better, next 7 days', min: 'B', days: 7 },
  c3: { label: 'C tier or better, next 3 days', min: 'C', days: 3 },
} as const satisfies Record<string, { label: string; min: ArbyTier; days: number }>;
export type PlanRange = keyof typeof PLAN_RANGES;
export const isPlanRange = (v: string): v is PlanRange => Object.hasOwn(PLAN_RANGES, v);

export const planButton = (): ButtonBuilder => new ButtonBuilder().setCustomId('feeds:plan').setLabel('Plan ahead').setEmoji('📅').setStyle(ButtonStyle.Primary);

/** The ephemeral "Plan ahead" answer: the chosen tiers for days ahead, with a menu to switch the range. */
export function planMessage(data: ArbitrationData | null, now: number, range: PlanRange = 'sa14'): ContainerBuilder {
  const r = PLAN_RANGES[range];
  const menu = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('feeds:plan')
      .setPlaceholder('Show another range')
      .addOptions(Object.entries(PLAN_RANGES).map(([value, o]) => ({ value, label: o.label, default: value === range }))),
  );
  if (!data) return card(TIER_COLOR.F, [`## ${e('arbitration')} Plan ahead`, 'The Arbitration schedule can not be read right now. Try again in a few minutes.']);
  const slots = data.schedule.slots(now, now + r.days * 24 * HOUR, data.tiers).filter((s) => s.start > now && atLeast(s.tier, r.min));
  return card(TIER_COLOR[r.min], [
    `## ${e('arbitration')} Plan ahead · ${r.label}`,
    slots.length ? `${tierCounts(slots, 'S', r.min)}` : null,
    DIVIDER,
    slots.length ? lines(slots, { date: true }) : `No ${r.min === 'A' ? 'S or A' : `${r.min} or better`} tier hour in that time.`,
    DIVIDER,
    menu,
    SOURCES,
  ]);
}

/** The board: the week's best, the next 24 hours, the 24 after, and now with the controls. Always four messages. */
export function arbitrationBoard(input: FeedInput): ContainerBuilder[][] {
  const { arby, now, settings, selfRoles } = input;
  const trusted = arby.scheduleTrusted;
  const next24 = arby.upcoming.filter((s) => s.start < now + 24 * HOUR);
  const later = arby.upcoming.filter((s) => s.start >= now + 24 * HOUR);
  const bestTop = arby.best.filter((s) => atLeast(s.tier, 'A'));
  const bCount = arby.best.filter((s) => s.tier === 'B').length;
  const unreadable = 'The schedule can not be read right now; it comes back on its own.';

  const best = card(TIER_COLOR.S, [
    `## ${e('arbitration')} Best of the week`,
    trusted && bestTop.length ? `${tierCounts(bestTop, 'S', 'A')} in the next 7 days` : null,
    DIVIDER,
    trusted ? (bestTop.length ? lines(bestTop, { date: true }) : 'No S or A tier hour in the next 7 days.') : unreadable,
    trusted && bCount ? `-# Plus ${bCount} B tier hour${bCount === 1 ? '' : 's'}: **Plan ahead** below lists them.` : null,
    GAP,
    '-# S and A are the nodes worth farming: fast spawns and good Vitus Essence. Lower tiers are listed for completeness.',
  ]);

  const day = card(0x2b6cb0, [
    `### Next 24 hours`,
    trusted && next24.length ? tierCounts(next24) || null : null,
    DIVIDER,
    trusted ? lines(next24) || 'Nothing scheduled.' : unreadable,
  ]);

  const tomorrow = card(0x1e3a5f, [
    later[0] ? `### Until ${discordTime(later.at(-1)!.end, 'f')}` : '### The day after',
    trusted && later.length ? tierCounts(later) || null : null,
    DIVIDER,
    trusted ? lines(later) || 'Nothing scheduled.' : unreadable,
  ]);

  const cur = arby.current;
  const role = settings.arbitrationsRoleId && selfRoles.has(settings.arbitrationsRoleId) ? settings.arbitrationsRoleId : null;
  const nowCard = card(cur ? TIER_COLOR[cur.tier] : TIER_COLOR.F, [
    section(
      cur
        ? [
            `## Arbitration now`,
            `${tierBadge(cur.tier)} **${cur.name}**${cur.planet ? `, ${cur.planet}` : ''}`,
            `${cur.mission}${cur.faction ? ` · ${factionTag(cur.faction)}${factionTag(cur.faction) === cur.faction ? '' : ` ${cur.faction}`}` : ''}`,
            `-# ${TIER_NAME[cur.tier]}, ${TIER_HINT[cur.tier]} · ends ${discordTime(cur.end, 'R')}`,
          ].join('\n')
        : `## Arbitration now\nNo Arbitration is known for this hour.`,
      emojiUrl('arbitration'),
    ),
    trusted && arby.upcoming.length ? DIVIDER : null,
    trusted && arby.upcoming.length ? `**Next up**\n${lines(arby.upcoming.slice(0, 3))}` : null,
    !trusted && cur ? `-# ⚠️ The schedule and the game disagree right now, so only the current hour is shown until it is confirmed again.` : null,
    input.stale || arby.stale ? `-# ${STALE_NOTE}` : null,
    DIVIDER,
    notifyRow('arbitrations', '🔔 DM me before…'),
    buttonRow(planButton(), mineButton(), role ? roleButton(role, 'Ping me for S/A', 'arbitration') : null),
    SOURCES,
  ]);

  return [[best], [day], [tomorrow], [nowCard]];
}

/** S and A tier hours, 10 minutes before they start: the ping note for the Arbitrations role (it goes when the hour ends). */
export function arbitrationPings(input: FeedInput, leadMs = 10 * 60_000): FeedPing[] {
  const { arby, now } = input;
  if (!arby.scheduleTrusted) return [];
  const soon = [arby.current, ...arby.upcoming].filter((s): s is ArbitrationSlot => Boolean(s) && s!.end > now && s!.start - leadMs <= now && atLeast(s!.tier, 'A'));
  return soon.map((s) => ({
    key: `arbitration:${s.start}`,
    until: s.end,
    text: `${tierBadge(s.tier)} **${TIER_NAME[s.tier]} Arbitration** ${s.start > now ? `starts ${discordTime(s.start, 'R')}` : 'is running now'}: **${s.name}**${s.planet ? `, ${s.planet}` : ''} · ${s.mission}${s.faction ? ` · ${s.faction}` : ''} · ends ${discordTime(s.end, 't')}`,
  }));
}
