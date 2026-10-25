import { UserError } from './services/clan.js';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

interface UpdateConfig {
  WATCHTOWER_URL?: string | undefined;
  WATCHTOWER_TOKEN?: string | undefined;
}

/**
 * Asks Watchtower (over the stack's private network) to check Docker Hub right now, instead of waiting for its
 * next poll. If a newer image exists it pulls it and restarts the bot, which is the whole update.
 */
export async function requestUpdate(config: UpdateConfig, fetcher: Fetcher = fetch): Promise<string> {
  if (!config.WATCHTOWER_URL || !config.WATCHTOWER_TOKEN) {
    throw new UserError('Updates on demand are not set up: set WATCHTOWER_URL and WATCHTOWER_TOKEN on the bot (and WATCHTOWER_HTTP_API_TOKEN on watchtower).');
  }
  const res = await fetcher(`${config.WATCHTOWER_URL}/v1/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WATCHTOWER_TOKEN}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((err: unknown) => {
    throw new UserError(`Could not reach Watchtower: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (res.status === 401) throw new UserError('Watchtower rejected the token: WATCHTOWER_TOKEN must equal its WATCHTOWER_HTTP_API_TOKEN.');
  if (!res.ok) throw new UserError(`Watchtower answered HTTP ${res.status}.`);
  return 'Watchtower is checking for a newer image. If there is one, the bot restarts on it within a minute or so.';
}

/** Exits shortly, so a reply can still go out; Docker's restart policy brings the bot back (on the same image). */
export function scheduleRestart(delayMs = 1500, exit: (code: number) => void = process.exit): void {
  setTimeout(() => exit(0), delayMs).unref?.();
}
