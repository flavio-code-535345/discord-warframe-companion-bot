import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { DEFAULT_MODEL_CHOICE, aiOverview, chooseModel, installModel, requireBase, setToggle, testModel, tuneModel } from '../../ai/control.js';
import { personaBand, updateBrain } from '../../agent/brain.js';
import { gb, listInstalled } from '../../ai/ollama.js';
import { type AiToggle, TOGGLES, TOGGLE_KEYS, isToggle } from '../../ai/settings.js';
import { UserError } from '../../services/clan.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

/**
 * Staff: choose or install the local AI model and flip the AI switches without redeploying. Everything here goes through
 * ai/control.ts, which the admin panel's AI page uses too, so the command and the panel always show the same state.
 */
export const ai: Command = {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Staff: choose, install and configure the local AI model that answers questions')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('status').setDescription('Show the model in use, the switches, the installed models and any download'))
    .addSubcommand((s) =>
      s
        .setName('model')
        .setDescription('Choose which installed model answers questions')
        .addStringOption((o) => o.setName('name').setDescription('An installed model (or "-" to go back to the bot\'s default)').setRequired(true).setMaxLength(120).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('install')
        .setDescription('Download a model onto the AI server (several GB, runs in the background)')
        .addStringOption((o) => o.setName('tag').setDescription('Model tag, e.g. gemma3:27b or hf.co/user/repo:Q4_K_M').setRequired(true).setMaxLength(120)),
    )
    .addSubcommand((s) =>
      s
        .setName('tune')
        .setDescription('Make a copy of the model with a CPU thread count (no download), to try it')
        .addIntegerOption((o) => o.setName('threads').setDescription('CPU threads that generate tokens, e.g. 6 (the performance cores of a 13900HK)').setRequired(true).setMinValue(1).setMaxValue(64))
        .addStringOption((o) => o.setName('name').setDescription('Name of the copy (default ordis-t<threads>)').setMaxLength(60))
        .addIntegerOption((o) => o.setName('context').setDescription('Context window in tokens (default 4096)').setMinValue(512).setMaxValue(131072))
        .addBooleanOption((o) => o.setName('use').setDescription('Switch to the copy right away')),
    )
    .addSubcommand((s) =>
      s
        .setName('toggle')
        .setDescription('Turn an AI feature on or off')
        .addStringOption((o) =>
          o
            .setName('feature')
            .setDescription('Which switch')
            .setRequired(true)
            .addChoices(...TOGGLE_KEYS.map((k) => ({ name: TOGGLES[k].label, value: k }))),
        )
        .addBooleanOption((o) => o.setName('on').setDescription('On (true) or off (false)').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('persona')
        .setDescription('How much Ordis the answers sound like: 0 plain to 100 full Ordis')
        .addIntegerOption((o) => o.setName('level').setDescription('0 = plain, 25 = a hint, 50 = light, 75 = strong, 100 = full Ordis').setRequired(true).setMinValue(0).setMaxValue(100)),
    )
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Send one short prompt to the local model and time the answer')
        .addStringOption((o) => o.setName('prompt').setDescription('Default: a greeting').setMaxLength(300)),
    )
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'model') {
      await interaction.editReply(await chooseModel(ctx, interaction.options.getString('name', true)));
      return;
    }

    if (sub === 'install') {
      const channelId = interaction.channelId;
      const message = await installModel(ctx, interaction.options.getString('tag', true), (state) => {
        void (async () => {
          const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
          if (!channel?.isSendable()) return;
          const text = state.error ? `❌ Downloading **${state.model}** failed: ${state.error}` : `✅ **${state.model}** is installed. Choose it with \`/ai model\`.`;
          await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
        })();
      });
      await interaction.editReply(`⬇️ ${message} I'll post here when it is done.`);
      return;
    }

    if (sub === 'tune') {
      await interaction.editReply(
        await tuneModel(ctx, {
          threads: interaction.options.getInteger('threads', true),
          name: interaction.options.getString('name') ?? undefined,
          context: interaction.options.getInteger('context') ?? undefined,
          use: interaction.options.getBoolean('use') ?? false,
        }),
      );
      return;
    }

    if (sub === 'toggle') {
      const feature = interaction.options.getString('feature', true);
      if (!isToggle(feature)) throw new UserError('Unknown switch.');
      await interaction.editReply(await setToggle(ctx, feature as AiToggle, interaction.options.getBoolean('on', true)));
      return;
    }

    if (sub === 'persona') {
      const level = interaction.options.getInteger('level', true);
      updateBrain(ctx.store, { ordisness: level });
      await interaction.editReply(`Ordis-ness is now ${level}/100 (${personaBand(level).name}). It applies from the next answer. The agent's prompt and tuning are on the admin panel's Brain page.`);
      return;
    }

    if (sub === 'test') {
      const r = await testModel(ctx, interaction.options.getString('prompt') ?? undefined);
      await interaction.editReply(`**${r.model}** answered in ${r.seconds}s${r.tokensPerSecond ? ` (${r.tokensPerSecond} tokens/s)` : ''}${r.thinking ? ' with thinking on' : ''}:\n${r.answer ? `> ${r.answer.replace(/\n/g, '\n> ').slice(0, 1500)}` : '*(empty answer)*'}`);
      return;
    }

    // status
    requireBase(ctx);
    const o = await aiOverview(ctx);
    if (!o.reachable) throw new UserError(o.error ?? 'The AI server is not reachable.');
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('🤖 AI')
      .addFields(
        {
          name: 'In use',
          value: o.model ? `**${o.model}**${o.chosen ? ' (chosen with /ai model)' : ''}${o.thinkingCapable ? ' · can think' : ''}${o.skippedAfterFailure ? '\n⚠️ skipped for a few minutes after a failure' : ''}` : '*none*',
        },
        { name: 'Switches', value: o.toggles.map((t) => `${t.on ? '🟢' : '⚫'} ${t.label}`).join('\n') },
        { name: 'Installed', value: o.installed.map((m) => `${m.name === o.model ? '▶ ' : ''}${m.name} · ${gb(m.size)}${m.parameters ? ` · ${m.parameters}` : ''}`).join('\n').slice(0, 1000) || '*nothing*' },
        { name: 'Loaded in memory', value: o.loaded.map((m) => `${m.name} · ${gb(m.size)}`).join('\n') || '*nothing right now*' },
        { name: 'Web search', value: o.webSearch.configured ? `SearXNG at \`${o.webSearch.host}\`` : '*not configured*' },
      );
    if (o.download) {
      embed.addFields({ name: 'Download', value: `${o.download.model}: ${o.download.error ? `❌ ${o.download.error}` : o.download.finishedAt ? '✅ done' : (o.download.progress ?? o.download.status)}` });
    }
    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, ctx) {
    const q = interaction.options.getFocused().toLowerCase();
    let names: string[] = [];
    try {
      names = (await listInstalled(requireBase(ctx))).map((m) => m.name);
    } catch {
      // Unreachable server: offer only the reset choice.
    }
    const choices = [...names.filter((n) => n.toLowerCase().includes(q)), ...(ctx.config.LOCAL_AI_MODEL ? [DEFAULT_MODEL_CHOICE] : [])];
    await interaction.respond(choices.slice(0, 25).map((n) => ({ name: (n === DEFAULT_MODEL_CHOICE ? `- (back to the default: ${ctx.config.LOCAL_AI_MODEL})` : n).slice(0, 100), value: n })));
  },
};
