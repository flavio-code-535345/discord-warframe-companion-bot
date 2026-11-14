import {
  ActionRowBuilder,
  type ButtonInteraction,
  type ContainerBuilder,
  MessageFlags,
  type MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { AppContext } from '../../context.js';
import { UserError } from '../../errors.js';
import { type SquadUp, squadUpForArbitration } from '../../lfg/arbitration-squad.js';
import { DEFAULT_GRACE_MINUTES } from '../../lfg/lifecycle.js';
import { discordTime } from '../../time.js';
import { MAX_TRACKERS_PER_USER, describeTracker, parseSpec } from '../../trackers.js';
import { lastArbitrations } from '../../warframe/arbitrations.js';
import { getWorldState } from '../../warframe/worldstate.js';
import { crackLinkProblem, crackTrackerOf } from '../crack.js';
import { BOUNTY_SYNDICATES, bountiesEmbed } from '../embeds.js';
import { COLORS } from '../style.js';
import { isPlanRange, planMessage } from './arbitrations.js';
import { sameSpec, trackOption } from './controls.js';
import { shownComponents } from './index.js';
import { DIVIDER, card } from './parts.js';
import { FEED_IDS } from './types.js';

/**
 * What the boards' controls do. Custom IDs: `feeds:track:<feed>` (menu: create notifications), `feeds:mine` (button: your list) and
 * `feeds:untrack` (menu under that list: remove some), `feeds:plan` (button and menu: the Arbitration schedule days ahead) and
 * `feeds:bounty` (menu: one syndicate's bounties). Every answer is ephemeral.
 */

const V2_EPHEMERAL = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;
const DM_HINT = '-# Ordis sends these as DMs: keep **Privacy Settings → Direct Messages** on for this server.';

/** The ephemeral list of someone's notifications, with a menu to remove them. */
export function mineMessage(ctx: AppContext, userId: string, note?: string): ContainerBuilder {
  const trackers = ctx.store.listTrackers(ctx.config.DISCORD_GUILD_ID, userId);
  const label = (spec: string) => {
    const s = parseSpec(spec);
    return s ? describeTracker(s) : 'Unreadable notification';
  };
  const list = trackers.map((t) => `**#${t.id}** ${label(t.spec)}`).join('\n');
  const menu = trackers.length
    ? new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('feeds:untrack')
          .setPlaceholder('🗑️ Remove…')
          .setMinValues(1)
          .setMaxValues(Math.min(25, trackers.length))
          .addOptions(trackers.slice(0, 25).map((t) => ({ value: String(t.id), label: `#${t.id} ${label(t.spec)}`.slice(0, 100) }))),
      )
    : null;
  return card(COLORS.brand, [
    `## 📋 Your notifications · ${trackers.length}/${MAX_TRACKERS_PER_USER}`,
    note ?? null,
    DIVIDER,
    list || 'None yet. Pick something in a **DM me when…** menu in the World State channels, or use `/track`.',
    menu ? DIVIDER : null,
    menu,
    DM_HINT,
  ]);
}

/**
 * Acknowledges a pick in a board's menu by redrawing the board message as it is: Discord keeps a pick shown in that member's menu until
 * the message is edited, and picking the same entry again would then do nothing. The answer itself follows privately.
 */
async function resetBoardMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const components = shownComponents(interaction.message.id);
  if (components) await interaction.update({ components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
  else await interaction.deferUpdate();
}

export async function handleFeedButton(interaction: ButtonInteraction, ctx: AppContext, action: string): Promise<void> {
  if (action === 'mine') {
    await interaction.reply({ components: [mineMessage(ctx, interaction.user.id)], flags: V2_EPHEMERAL });
    return;
  }
  if (action === 'plan') {
    await interaction.reply({ components: [planMessage(lastArbitrations(), Date.now())], flags: V2_EPHEMERAL });
    return;
  }
  if (action === 'squad') {
    // A voice channel and a post are made: that can take longer than the three seconds a click may wait.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const name = interaction.inCachedGuild() ? interaction.member.displayName : interaction.user.username;
    await interaction.editReply({ content: squadUpReply(ctx, await squadUpForArbitration(ctx, { id: interaction.user.id, name })) });
    return;
  }
  throw new UserError('That button is no longer supported.');
}

/** What the member who tapped "Squad up" is told. */
export function squadUpReply(ctx: AppContext, r: SquadUp): string {
  const where = `**${r.slot.name}${r.slot.planet ? `, ${r.slot.planet}` : ''}** (${r.slot.mission})`;
  const voice = r.post.voiceChannelId ? ` Voice: <#${r.post.voiceChannelId}>.` : '';
  if (r.kind === 'already') return `You are already in the squad for ${where}: [open the post](${r.url}).${voice}`;
  if (r.kind === 'joined') return `🐀 You joined <@${r.post.hostId}>'s squad for ${where}: [open the post](${r.url}).${voice}${r.full ? ' The squad is full now.' : ''}`;
  const grace = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).lfgVoiceGraceMinutes ?? DEFAULT_GRACE_MINUTES;
  const join = r.post.voiceChannelId ? ` Join <#${r.post.voiceChannelId}> within ${grace} minutes or the squad ends.` : '';
  return `🐀 Squad #${r.post.id} for ${where} is up in <#${r.post.channelId}>: [open the post](${r.url}). The next clanmates who tap **Squad up** join it.${join} It closes when the Arbitration ends ${discordTime(r.slot.end)}.`;
}

export async function handleFeedSelect(interaction: StringSelectMenuInteraction, ctx: AppContext): Promise<void> {
  const [, action, feed] = interaction.customId.split(':');
  const guildId = ctx.config.DISCORD_GUILD_ID;
  const userId = interaction.user.id;

  if (action === 'track') {
    if (!FEED_IDS.includes(feed as never)) throw new UserError('Unknown menu.');
    await resetBoardMenu(interaction);
    const existing = ctx.store.listTrackers(guildId, userId);
    const specs = existing.map((t) => t.spec);
    const added: string[] = [];
    const had: string[] = [];
    const refused: string[] = [];
    let full = false;
    for (const value of interaction.values) {
      const option = trackOption(value);
      if (!option) continue;
      if (specs.some((s) => sameSpec(s, option.spec))) {
        had.push(describeTracker(option.spec));
        continue;
      }
      if (option.spec.kind === 'crack') {
        // There is one per member (`/track crack` changes it), and it needs a link that shares their relics.
        const own = crackTrackerOf(ctx.store, guildId, userId);
        const problem = own ? null : crackLinkProblem(ctx.store, userId);
        if (own) had.push(describeTracker(own.spec));
        else if (problem) refused.push(problem);
        if (own || problem) continue;
      }
      if (specs.length >= MAX_TRACKERS_PER_USER) {
        full = true;
        break;
      }
      const json = JSON.stringify(option.spec);
      ctx.store.createTracker(guildId, userId, json);
      specs.push(json);
      added.push(describeTracker(option.spec));
    }
    const parts = [
      added.length ? `🔔 Ordis will DM you for:\n${added.map((a) => `• ${a}`).join('\n')}` : '',
      had.length ? `Already set:\n${had.map((a) => `• ${a}`).join('\n')}` : '',
      ...refused,
      full ? `You have ${MAX_TRACKERS_PER_USER} notifications, the most allowed: remove some with **My notifications**.` : '',
    ].filter(Boolean);
    await interaction.followUp({ components: [mineMessage(ctx, userId, parts.join('\n\n') || 'Nothing changed.')], flags: V2_EPHEMERAL });
    return;
  }

  if (action === 'untrack') {
    const removed = interaction.values.filter((v) => ctx.store.deleteTracker(guildId, userId, Number(v))).length;
    await interaction.update({ components: [mineMessage(ctx, userId, removed ? `🗑️ Removed ${removed}.` : 'Those were already gone.')], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  if (action === 'plan') {
    const range = interaction.values[0] ?? '';
    await interaction.update({ components: [planMessage(lastArbitrations(), Date.now(), isPlanRange(range) ? range : 'sa14')], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  if (action === 'bounty') {
    const syndicate = BOUNTY_SYNDICATES.find((s) => s === interaction.values[0]);
    if (!syndicate) throw new UserError('Unknown syndicate.');
    await resetBoardMenu(interaction);
    await interaction.followUp({ embeds: [bountiesEmbed(await getWorldState(), syndicate)], flags: MessageFlags.Ephemeral });
    return;
  }

  throw new UserError('Unknown menu.');
}
