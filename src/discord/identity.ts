import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AppContext } from '../context.js';

/** The clan logo; resolves to <repo>/assets from both src/discord (tsx) and dist/discord (built image). */
export const SS_EXAMPLE_PATH = fileURLToPath(new URL('../../assets/ss-roles-example.png', import.meta.url));
export const SS_RANK_EXAMPLE_PATH = fileURLToPath(new URL('../../assets/ss-roles-example-rank.png', import.meta.url));
export const LOGO_PATH = fileURLToPath(new URL('../../assets/clan-logo.png', import.meta.url));

/**
 * Keeps the bot's Discord username (BOT_NAME) and avatar (assets/clan-logo.png) in sync.
 * Discord rate-limits both to a couple of changes per hour, so each is only sent when it differs
 * from what was last applied successfully; failures are retried on the next start.
 */
export async function syncIdentity(ctx: AppContext): Promise<void> {
  const { client, config, store } = ctx;
  const user = client.user;
  if (!user) return;

  if (user.username !== config.BOT_NAME) {
    try {
      await user.setUsername(config.BOT_NAME);
      console.log(`[discord] bot username set to "${config.BOT_NAME}"`);
    } catch (err) {
      console.warn(`[discord] could not rename the bot to "${config.BOT_NAME}":`, err);
    }
  }

  const image = await readFile(LOGO_PATH).catch(() => null);
  if (!image) return;
  const hash = createHash('sha256').update(image).digest('hex');
  if (store.getMeta('avatar_sha256') === hash) return;
  try {
    await user.setAvatar(image);
    store.setMeta('avatar_sha256', hash);
    console.log('[discord] bot avatar updated from assets/clan-logo.png');
  } catch (err) {
    console.warn('[discord] could not update the bot avatar:', err);
  }
}

/** The bot's avatar (the clan logo once synced), for embed icons and thumbnails. */
export function brandIcon(ctx: AppContext): string | undefined {
  return ctx.client.user?.displayAvatarURL({ size: 256 });
}
