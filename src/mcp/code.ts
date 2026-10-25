import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MAX_FILE_BYTES, distFileFor, listDistFiles, overlayStatus, overrideSource, removeOverride, writeOverride } from '../overlay.js';
import { scheduleRestart } from '../selfupdate.js';
import { UserError } from '../services/clan.js';
import { READ_ONLY, tool } from './util.js';

/**
 * Live code changes over MCP (only registered with ALLOW_CODE_EDIT=true). They patch the compiled JavaScript in dist as
 * overrides in the data volume (see overlay.ts) and take effect after a restart. They are for quick fixes: the same
 * change still belongs in the repository, and a newer image drops the override of any file it changed.
 */

const DIST_DIR = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]mcp$/, '');

const path = z.string().describe('File inside dist, e.g. discord/bot.js or leveling/xp.js (compiled JavaScript, not TypeScript)');

/** Refuses code that doesn't even parse as an ES module, so a typo can't take the bot down. */
function checkSyntax(content: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-check-'));
  try {
    const file = join(dir, 'check.mjs');
    writeFileSync(file, content);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) throw new UserError(`That code has a syntax error, nothing was saved:\n${(r.stderr || r.stdout).split('\n').slice(0, 6).join('\n')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function registerCodeTools(server: McpServer, ctx: AppContext, distDir = DIST_DIR): void {
  const dataDir = ctx.config.DATA_DIR;

  server.registerTool(
    'list_code_files',
    {
      title: 'List code files',
      description: 'Lists the compiled JavaScript files of the running bot (under dist) and which of them are overridden by a live patch.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    tool(async () => {
      const status = overlayStatus(dataDir);
      return { overrides: status.overrides, awaitingHealthyBoot: status.pendingBootCheck, files: listDistFiles(distDir) };
    }),
  );

  server.registerTool(
    'read_code_file',
    {
      title: 'Read a code file',
      description: 'Returns the source the bot runs for a file: the live patch if there is one, otherwise the image\'s own compiled file.',
      inputSchema: { path },
      annotations: READ_ONLY,
    },
    tool(async ({ path }) => {
      const file = (() => {
        try {
          return distFileFor(distDir, path);
        } catch (err) {
          throw new UserError((err as Error).message);
        }
      })();
      const patched = overrideSource(dataDir, path);
      const content = patched ?? readFileSync(file, 'utf8');
      if (content.length > MAX_FILE_BYTES) throw new UserError(`dist/${path} is ${content.length} bytes, too large to read in one go.`);
      return { path, patched: patched !== null, content };
    }),
  );

  server.registerTool(
    'write_code_file',
    {
      title: 'Patch a code file',
      description:
        'Replaces a compiled file of the running bot with the given JavaScript (ES module). The code is syntax-checked first and saved as a live patch in the data volume; it runs after a restart (restart: true does that right away). Read the file first and send the whole file. If the bot then dies within 15 seconds of starting, the patches are set aside automatically on the next start. Only existing files can be patched.',
      inputSchema: { path, content: z.string().min(1).max(MAX_FILE_BYTES), restart: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    tool(async ({ path, content, restart }) => {
      try {
        distFileFor(distDir, path);
      } catch (err) {
        throw new UserError((err as Error).message);
      }
      checkSyntax(content);
      writeOverride(dataDir, distDir, path, content);
      console.warn(`[overlay] ${path} patched over MCP (${content.length} bytes)`);
      if (restart) scheduleRestart();
      return { saved: path, restarting: Boolean(restart), note: restart ? 'Restarting in a moment.' : 'Saved. Call restart_bot to run it.' };
    }),
  );

  server.registerTool(
    'revert_code_file',
    {
      title: 'Revert code patches',
      description: 'Removes the live patch of one file, or of every file when no path is given, so the bot runs the image\'s own code again after the next restart.',
      inputSchema: { path: path.optional(), restart: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    tool(async ({ path, restart }) => {
      const removed = removeOverride(dataDir, path);
      if (restart) scheduleRestart();
      return { reverted: removed, restarting: Boolean(restart) };
    }),
  );
}
