import {
  ActionRowBuilder,
  type ButtonInteraction,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../context.js';
import { UserError } from '../services/clan.js';
import { discordTime } from '../time.js';
import { MAX_TRACKERS_PER_USER, type TrackerSpec, describeTracker, parseSpec } from '../trackers.js';
import { activeArbitration, filterFissures, getWorldState } from '../warframe/worldstate.js';
import { COLORS, archonEmbed, baroEmbed, fissuresEmbed, sortieEmbed } from './embeds.js';

/**
 * The buttons and the "notify me" menu under the alerts channel's summary message. Custom IDs: `alerts:<fissures|sortie|archon|arbitration|baro|mine>`
 * for the buttons and `alerts:track` for the menu, so they keep working after a restart. Every answer is ephemeral (only the person who tapped sees it).
 */

const DETAILS = [
  { id: 'fissures', label: 'Fissures', emoji: '🌀' },
  { id: 'sortie', label: 'Sortie', emoji: '⚔️' },
  { id: 'archon', label: 'Archon Hunt', emoji: '🗡️' },
  { id: 'arbitration', label: 'Arbitration', emoji: '⚖️' },
  { id: 'baro', label: 'Baro', emoji: '👑' },
] as const;

/** What the menu can set up in one tap: the value is the option id, the spec is what gets stored. */
export const TRACK_OPTIONS: { value: string; label: string; description: string; spec: TrackerSpec }[] = [
  { value: 'arbitration', label: 'Every Arbitration', description: 'A new Arbitration starts (every hour)', spec: { kind: 'arbitration' } },
  { value: 'arbitration-survival', label: 'Survival Arbitrations', description: 'Only Survival Arbitrations', spec: { kind: 'arbitration', type: 'Survival' } },
  { value: 'arbitration-defense', label: 'Defense Arbitrations', description: 'Only Defense Arbitrations', spec: { kind: 'arbitration', type: 'Defense' } },
  { value: 'sortie', label: 'Daily sortie', description: 'A DM when the new sortie starts', spec: { kind: 'sortie' } },
  { value: 'archon', label: 'Archon Hunt', description: 'A DM when the weekly hunt resets', spec: { kind: 'archon' } },
  { value: 'baro', label: "Baro Ki'Teer", description: 'A DM when Baro arrives at a relay', spec: { kind: 'baro' } },
  { value: 'cetus-night', label: 'Cetus night', description: 'Night falls on the Plains (Eidolons)', spec: { kind: 'cycle', cycle: 'cetus', state: 'night' } },
  { value: 'vallis-warm', label: 'Orb Vallis warm', description: 'The Vallis turns warm', spec: { kind: 'cycle', cycle: 'vallis', state: 'warm' } },
  { value: 'cambion-fass', label: 'Cambion Drift Fass', description: 'Fass phase starts', spec: { kind: 'cycle', cycle: 'cambion', state: 'fass' } },
  { value: 'steel-path-fissure', label: 'Steel Path fissures', description: 'Any hard-mode void fissure', spec: { kind: 'fissure', steelPath: true } },
  { value: 'void-storm', label: 'Void Storms', description: 'Railjack fissures', spec: { kind: 'fissure', storm: true } },
  { value: 'catalyst', label: 'Orokin Catalyst / Reactor', description: 'In invasions, alerts, events and more', spec: { kind: 'reward', keyword: 'Orokin' } },
  { value: 'forma', label: 'Forma', description: 'In invasions, alerts, events and more', spec: { kind: 'reward', keyword: 'Forma' } },
  { value: 'nitain', label: 'Nitain Extract', description: 'In invasions, alerts, events and more', spec: { kind: 'reward', keyword: 'Nitain' } },
];

/** The rows attached to the summary message. */
export function alertsComponents(): (ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>)[] {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...DETAILS.map((d) => new ButtonBuilder().setCustomId(`alerts:${d.id}`).setLabel(d.label).setEmoji(d.emoji).setStyle(ButtonStyle.Secondary)),
  );
  const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('alerts:track')
      .setPlaceholder('🔔 Notify me when…')
      .setMinValues(1)
      .setMaxValues(TRACK_OPTIONS.length)
      .addOptions(TRACK_OPTIONS.map((o) => ({ label: o.label, value: o.value, description: o.description }))),
  );
  const mine = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('alerts:mine').setLabel('My notifications').setEmoji('📋').setStyle(ButtonStyle.Primary),
  );
  return [buttons, menu, mine];
}

function arbitrationEmbed(ws: Awaited<ReturnType<typeof getWorldState>>): EmbedBuilder {
  const a = activeArbitration(ws);
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle('⚖️ Arbitration');
  if (!a) return embed.setDescription('No Arbitration is running right now. They come and go; set a notification in the menu to be told when the next one starts.');
  const flags = [a.archwing ? 'Archwing' : '', a.sharkwing ? 'Sharkwing' : ''].filter(Boolean);
  return embed.setDescription(
    `**${a.type ?? 'Unknown'}** — ${a.node}${a.enemy ? ` · ${a.enemy}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}\nEnds ${discordTime(a.expiry)}\n` +
      '-# An endless mission that changes every hour and drops Vitus Essence.',
  );
}

/** A tap on one of the detail buttons or on "My notifications". */
export async function handleAlertsButton(interaction: ButtonInteraction, ctx: AppContext, action: string): Promise<void> {
  if (action === 'mine') {
    const trackers = ctx.store.listTrackers(ctx.config.DISCORD_GUILD_ID, interaction.user.id);
    const lines = trackers.map((t) => {
      const spec = parseSpec(t.spec);
      return `**#${t.id}** ${spec ? describeTracker(spec) : 'unreadable tracker'}`;
    });
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`Your notifications (${trackers.length}/${MAX_TRACKERS_PER_USER})`)
          .setDescription(`${lines.length ? lines.join('\n') : 'None yet. Pick something in the menu above the button.'}\n\n-# Remove one with \`/track remove id:<number>\`.`),
      ],
    });
    return;
  }
  if (!DETAILS.some((d) => d.id === action)) throw new UserError('Unknown button.');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ws = await getWorldState();
  const embed = (() => {
    switch (action) {
      case 'fissures':
        return fissuresEmbed(filterFissures(ws.fissures, {}));
      case 'sortie':
        return sortieEmbed(ws);
      case 'archon':
        return archonEmbed(ws);
      case 'arbitration':
        return arbitrationEmbed(ws);
      default:
        return baroEmbed(ws);
    }
  })();
  await interaction.editReply({ embeds: [embed] });
}

/** Creates the chosen trackers for the person who used the menu; ones they already have are skipped. */
export async function handleAlertsSelect(interaction: StringSelectMenuInteraction, ctx: AppContext): Promise<void> {
  if (interaction.customId !== 'alerts:track') throw new UserError('Unknown menu.');
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const userId = interaction.user.id;
  const existing = ctx.store.listTrackers(guildId, userId).map((t) => t.spec);
  let count = existing.length;
  const added: string[] = [];
  const had: string[] = [];
  let full = false;
  for (const value of interaction.values) {
    const option = TRACK_OPTIONS.find((o) => o.value === value);
    if (!option) continue;
    const json = JSON.stringify(option.spec);
    if (existing.includes(json)) {
      had.push(describeTracker(option.spec));
      continue;
    }
    if (count >= MAX_TRACKERS_PER_USER) {
      full = true;
      break;
    }
    ctx.store.createTracker(guildId, userId, json);
    existing.push(json);
    count++;
    added.push(describeTracker(option.spec));
  }
  const parts: string[] = [];
  if (added.length) parts.push(`🔔 Ordis will DM you for:\n${added.map((a) => `• ${a}`).join('\n')}`);
  if (had.length) parts.push(`Already set:\n${had.map((a) => `• ${a}`).join('\n')}`);
  if (full) parts.push(`You have ${MAX_TRACKERS_PER_USER} notifications, the most allowed. Remove some with \`/track remove\`.`);
  if (added.length) parts.push('-# Make sure Privacy Settings → Direct Messages from server members is on for this server. See all of yours with the **My notifications** button.');
  await interaction.reply({ content: parts.join('\n\n') || 'Nothing changed.', flags: MessageFlags.Ephemeral });
}
