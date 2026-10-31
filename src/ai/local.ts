/**
 * Whether the self-hosted Ollama (LOCAL_AI_URL) is worth trying right now. The screenshot reader (ssroles/vision.ts) marks it
 * down after a failure or timeout, and it is then skipped for a few minutes so a sleeping host doesn't slow every screenshot.
 */

/** After a failure the local server is skipped for this long. */
export const LOCAL_COOLDOWN_MS = 3 * 60_000;
let localDownUntil = 0;

/** False for a few minutes after the local server failed. */
export const localAvailable = (now = Date.now()): boolean => now >= localDownUntil;

export function markLocalDown(now = Date.now()): void {
  localDownUntil = now + LOCAL_COOLDOWN_MS;
}

/** Test hook: forget a recorded local failure. */
export const resetLocalAi = (): void => {
  localDownUntil = 0;
};
