import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareOverlay } from './overlay.js';

/**
 * Preloaded with `node --import ./dist/overlay-register.js dist/index.js`. Swaps in overlay sources (see overlay.ts)
 * while keeping each file's original URL, so its relative and package imports keep resolving from the image.
 * Does nothing unless ALLOW_CODE_EDIT is on and the data volume holds an overlay. It accepts the same spellings of "on" as config.ts
 * (true, 1, yes): the MCP tools are registered by that parser, so this must not be stricter, or patches would be saved and never loaded.
 */
if (['true', '1', 'yes'].includes(process.env.ALLOW_CODE_EDIT ?? '')) {
  const distDir = dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.DATA_DIR ?? join(distDir, '..', 'data');
  try {
    const state = prepareOverlay(dataDir, distDir);
    if (state.disabled) console.warn('[overlay] the last start with a code overlay did not stay up; the overlay was set aside (see the data folder).');
    for (const d of state.dropped) console.warn(`[overlay] dropped ${d.path}: ${d.reason}`);
    if (state.active.size) {
      console.log(`[overlay] running ${state.active.size} patched file(s): ${[...state.active.keys()].map((f) => f.slice(f.lastIndexOf('dist') + 5)).join(', ')}`);
      registerHooks({
        load(url, context, nextLoad) {
          const result = nextLoad(url, context);
          if (!url.startsWith('file:')) return result;
          const source = state.active.get(fileURLToPath(url));
          return source === undefined ? result : { ...result, source, shortCircuit: true };
        },
      });
    }
  } catch (err) {
    console.error('[overlay] could not start the code overlay, running the image as built:', err);
  }
}
