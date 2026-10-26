import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import {
  LOCAL_MODEL_META,
  currentPull,
  gb,
  listInstalled,
  localModelOf,
  ollamaApi,
  ollamaBase,
  pullProgress,
  pullRunning,
  setChosenModel,
  startPull,
  validModelTag,
} from '../../ai/ollama.js';
import { localAvailable } from '../../answers/compose.js';
import type { AppContext } from '../../context.js';
import { UserError } from '../../services/clan.js';
import type { Command } from '../command.js';
import { COLORS } from '../embeds.js';

/** The value that clears the choice, so LOCAL_AI_MODEL from the stack applies again. */
const DEFAULT_CHOICE = '-';

function baseOf(ctx: AppContext): string {
  if (!ctx.config.LOCAL_AI_URL) throw new UserError('No local AI server is set up: add LOCAL_AI_URL to the bot\'s settings first.');
  return ollamaBase(ctx.config.LOCAL_AI_URL);
}

/** Staff: pick which Ollama model answers questions, or download a new one, without redeploying the bot. */
export const ai: Command = {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Staff: choose or install the local AI model that answers questions')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('status').setDescription('Show the model in use, the installed models and any download'))
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
    .toJSON(),

  async execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const base = baseOf(ctx);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'model') {
      const name = interaction.options.getString('name', true).trim();
      if (name === DEFAULT_CHOICE) {
        setChosenModel(null);
        ctx.store.setMeta(LOCAL_MODEL_META, '');
        await interaction.editReply(`Back to the bot's own setting: **${ctx.config.LOCAL_AI_MODEL ?? 'none'}**.`);
        return;
      }
      const installed = await listInstalled(base);
      const match = installed.find((m) => m.name === name || m.name === `${name}:latest`);
      if (!match) throw new UserError(`"${name}" is not installed on the AI server. Installed: ${installed.map((m) => m.name).join(', ') || 'nothing'}. Use /ai install first.`);
      setChosenModel(match.name);
      ctx.store.setMeta(LOCAL_MODEL_META, match.name);
      await interaction.editReply(`Ordis now answers with **${match.name}** (${gb(match.size)}${match.parameters ? `, ${match.parameters}` : ''}). The first answer after a switch is slower while it loads into memory.`);
      return;
    }

    if (sub === 'install') {
      const tag = interaction.options.getString('tag', true).trim();
      if (!validModelTag(tag)) throw new UserError('That is not a model tag. Use something like `gemma3:27b` or `hf.co/user/repo:Q4_K_M`.');
      const running = currentPull();
      if (pullRunning() && running) throw new UserError(`Already downloading **${running.model}** (${pullProgress(running) ?? running.status}). Wait for it to finish.`);
      await ollamaApi(base, '/api/version'); // fail now, with a clear message, if the server is unreachable
      const channelId = interaction.channelId;
      void startPull(base, tag, fetch, (state) => {
        void (async () => {
          const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
          if (!channel?.isSendable()) return;
          const text = state.error ? `❌ Downloading **${state.model}** failed: ${state.error}` : `✅ **${state.model}** is installed. Choose it with \`/ai model\`.`;
          await channel.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
        })();
      });
      await interaction.editReply(`⬇️ Downloading **${tag}** in the background. Check \`/ai status\` for progress; I'll post here when it is done.`);
      return;
    }

    // status
    const [installed, running] = await Promise.all([
      listInstalled(base),
      ollamaApi<{ models: { name: string; size: number }[] }>(base, '/api/ps'),
    ]);
    const used = localModelOf(ctx.config);
    const pull = currentPull();
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle('🤖 Local AI')
      .addFields(
        { name: 'In use', value: used ? `**${used}**${used === ctx.config.LOCAL_AI_MODEL ? '' : ' (chosen with /ai model)'}${localAvailable() ? '' : '\n⚠️ skipped for a few minutes after a failure'}` : '*none*', inline: false },
        { name: 'Installed', value: installed.map((m) => `${m.name === used ? '▶ ' : ''}${m.name} · ${gb(m.size)}${m.parameters ? ` · ${m.parameters}` : ''}`).join('\n').slice(0, 1000) || '*nothing*' },
        { name: 'Loaded in memory', value: running.models.map((m) => `${m.name} · ${gb(m.size)}`).join('\n') || '*nothing right now*' },
      );
    if (pull) {
      embed.addFields({ name: 'Download', value: `${pull.model}: ${pull.error ? `❌ ${pull.error}` : pull.finishedAt ? '✅ done' : (pullProgress(pull) ?? pull.status)}` });
    }
    await interaction.editReply({ embeds: [embed] });
  },

  async autocomplete(interaction, ctx) {
    const q = interaction.options.getFocused().toLowerCase();
    let names: string[] = [];
    try {
      names = (await listInstalled(baseOf(ctx))).map((m) => m.name);
    } catch {
      // Unreachable server: offer only the reset choice.
    }
    const choices = [...names.filter((n) => n.toLowerCase().includes(q)), ...(ctx.config.LOCAL_AI_MODEL ? [DEFAULT_CHOICE] : [])];
    await interaction.respond(choices.slice(0, 25).map((n) => ({ name: (n === DEFAULT_CHOICE ? `- (back to the default: ${ctx.config.LOCAL_AI_MODEL})` : n).slice(0, 100), value: n })));
  },
};
