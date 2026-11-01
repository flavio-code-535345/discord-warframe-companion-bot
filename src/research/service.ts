import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { AppContext } from '../context.js';
import type { Research } from '../db.js';
import { COLORS } from '../discord/embeds.js';
import { brandIcon } from '../discord/identity.js';
import { editLive, postLive } from '../discord/live-message.js';
import { UserError } from '../services/clan.js';
import { discordTime } from '../time.js';

/**
 * The dojo research board: leadership lists what the clan is researching and what each still needs, members see what to donate. One
 * message is kept up to date in place (bot_meta `research_board`); finished research stays on it for a week.
 */

export const LABS = ['Tenno Lab', 'Energy Lab', 'Chem Lab', 'Bio Lab', 'Orokin Lab', 'Dagath\'s Hollow', 'Other'] as const;
const BOARD_META = 'research_board';
export const DONE_SHOWN_MS = 7 * 86_400_000;
const MAX_OPEN = 40;

/** The board, pure apart from the brand icon. */
export function researchBoard(ctx: AppContext, items: Research[], now = Date.now()): Pick<MessageCreateOptions, 'embeds' | 'components'> {
  const open = items.filter((r) => r.doneAt === null);
  const done = items.filter((r) => r.doneAt !== null && now - r.doneAt < DONE_SHOWN_MS);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🔬 Dojo research')
    .setDescription(open.length ? 'What the clan is researching and what it still needs. Donate in the lab in the dojo.' : 'Nothing is being researched right now.')
    .setFooter({ text: `${ctx.config.CLAN_NAME} · updated by leadership with /research`, iconURL: brandIcon(ctx) })
    .setTimestamp(now);
  const byLab = new Map<string, Research[]>();
  for (const r of open) byLab.set(r.lab ?? 'Other', [...(byLab.get(r.lab ?? 'Other') ?? []), r]);
  for (const [lab, list] of byLab) {
    embed.addFields({ name: lab, value: list.map((r) => `**#${r.id} ${r.name}**${r.needs ? `\n-# Needs: ${r.needs}` : ''}`).join('\n').slice(0, 1024) });
  }
  if (done.length) embed.addFields({ name: '✅ Finished this week', value: done.map((r) => `${r.name} · ${discordTime(r.doneAt!)}`).join('\n').slice(0, 1024) });
  return { embeds: [embed], components: [] };
}

const items = (ctx: AppContext) => ctx.store.listResearch(ctx.config.DISCORD_GUILD_ID, Date.now() - DONE_SHOWN_MS);

export async function postResearchBoard(ctx: AppContext, channelId: string): Promise<string> {
  return postLive(ctx, BOARD_META, channelId, researchBoard(ctx, items(ctx)));
}

async function refresh(ctx: AppContext): Promise<void> {
  await editLive(ctx, BOARD_META, researchBoard(ctx, items(ctx))).catch((err) => console.warn('[research] could not update the board:', (err as Error).message));
}

export async function addResearch(ctx: AppContext, input: { name: string; lab?: string | null; needs?: string | null; addedBy: string }): Promise<Research> {
  const guildId = ctx.config.DISCORD_GUILD_ID;
  if (ctx.store.listResearch(guildId, Date.now()).filter((r) => r.doneAt === null).length >= MAX_OPEN) throw new UserError(`The board holds at most ${MAX_OPEN} open research items.`);
  const created = ctx.store.addResearch(guildId, { name: input.name.trim().slice(0, 100), lab: input.lab?.trim() || null, needs: input.needs?.trim().slice(0, 300) || null, addedBy: input.addedBy });
  await refresh(ctx);
  return created;
}

const mustExist = (r: Research | null, id: number): Research => {
  if (!r) throw new UserError(`There is no research #${id}.`);
  return r;
};

export async function updateResearch(ctx: AppContext, id: number, needs: string | null): Promise<Research> {
  const r = mustExist(ctx.store.updateResearch(ctx.config.DISCORD_GUILD_ID, id, { needs: needs?.trim().slice(0, 300) || null }), id);
  await refresh(ctx);
  return r;
}

export async function finishResearch(ctx: AppContext, id: number): Promise<Research> {
  const r = mustExist(ctx.store.updateResearch(ctx.config.DISCORD_GUILD_ID, id, { doneAt: Date.now(), needs: null }), id);
  await refresh(ctx);
  return r;
}

export async function removeResearch(ctx: AppContext, id: number): Promise<void> {
  if (!ctx.store.removeResearch(ctx.config.DISCORD_GUILD_ID, id)) throw new UserError(`There is no research #${id}.`);
  await refresh(ctx);
}

export const listResearch = items;
