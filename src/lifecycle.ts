import { EmbedBuilder } from 'discord.js';
import type { AppContext } from './context.js';
import { COLORS } from './discord/embeds.js';
import { formatDuration as duration } from './time.js';

/**
 * Start / shutdown / restart reports for staff, posted to the /setup status channel. The last known state lives in
 * bot_meta, so a start can tell a normal restart (the previous run said it was shutting down) from a crash or a killed
 * container (it never did). Never throws: reporting must not keep the bot from starting or stopping.
 */

const STATE_KEY = 'lifecycle_state';
const STARTED_KEY = 'lifecycle_started_at';
const STOPPED_KEY = 'lifecycle_stopped_at';
const SEND_TIMEOUT_MS = 4000;

export type StartKind = 'first' | 'restart' | 'unclean';

export function startKind(previousState: string | null): StartKind {
  if (previousState === 'stopped') return 'restart';
  if (previousState === 'running') return 'unclean';
  return 'first';
}

export function startEmbed(kind: StartKind, downMs: number | null): EmbedBuilder {
  const e = new EmbedBuilder().setTimestamp();
  if (kind === 'unclean') {
    return e.setColor(COLORS.warn).setTitle('🟠 Cephalon Ordis is back online').setDescription(`The previous run did not shut down cleanly (crash, killed or power loss).`);
  }
  if (kind === 'restart') {
    return e.setColor(COLORS.success).setTitle('🟢 Cephalon Ordis is online').setDescription(`Restarted${downMs !== null ? ` after ${duration(downMs)} offline` : ''} (an update, a redeploy or a manual restart).`);
  }
  return e.setColor(COLORS.success).setTitle('🟢 Cephalon Ordis is online').setDescription('First start with status reports on.');
}

export function stopEmbed(signal: string, uptimeMs: number | null): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle('🔴 Cephalon Ordis is shutting down')
    .setDescription(`Received **${signal}**${uptimeMs !== null ? ` after ${duration(uptimeMs)} of uptime` : ''}. This is normal during an update or restart; a "back online" report follows when it returns.`)
    .setTimestamp();
}

async function post(ctx: AppContext, embed: EmbedBuilder): Promise<void> {
  const id = ctx.store.getSettings(ctx.config.DISCORD_GUILD_ID).statusChannelId;
  if (!id) return;
  try {
    const send = (async () => {
      const channel = await ctx.client.channels.fetch(id);
      if (channel?.isSendable()) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    })();
    await Promise.race([send, new Promise((resolve) => setTimeout(resolve, SEND_TIMEOUT_MS))]);
  } catch (err) {
    console.warn('[status] could not post to the status channel:', err instanceof Error ? err.message : err);
  }
}

/** Call once the Discord client is ready. */
export async function reportStart(ctx: AppContext, now = Date.now()): Promise<void> {
  const previous = ctx.store.getMeta(STATE_KEY);
  const stoppedAt = Number(ctx.store.getMeta(STOPPED_KEY));
  ctx.store.setMeta(STATE_KEY, 'running');
  ctx.store.setMeta(STARTED_KEY, String(now));
  await post(ctx, startEmbed(startKind(previous), previous === 'stopped' && Number.isFinite(stoppedAt) && stoppedAt > 0 ? Math.max(0, now - stoppedAt) : null));
}

/** Call at the start of a graceful shutdown, before the client is destroyed. */
export async function reportStop(ctx: AppContext, signal: string, now = Date.now()): Promise<void> {
  const started = Number(ctx.store.getMeta(STARTED_KEY));
  ctx.store.setMeta(STATE_KEY, 'stopped');
  ctx.store.setMeta(STOPPED_KEY, String(now));
  await post(ctx, stopEmbed(signal, Number.isFinite(started) && started > 0 ? Math.max(0, now - started) : null));
}
