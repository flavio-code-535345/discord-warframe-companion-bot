import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Import circles are legal until a module uses, while it loads, something from a module that has not finished loading: then the bot (or
 * a test) dies with "Cannot access X before initialization", and only for some orders of loading. One such circle shipped to the tests:
 * trackers → warframe/worldstate → services/clan → discord/subscriptions → feeds/controls → trackers. Two guards:
 * the data modules never reach up into the layers that use them, and the real entry point loads in its real order.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

/** Every .ts file under src, relative to it, with forward slashes. */
function sourceFiles(dir = SRC, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full, `${prefix}${name}/`);
    return name.endsWith('.ts') ? [`${prefix}${name}`] : [];
  });
}

/**
 * The files a module loads when it is loaded. `import type` and `export type` are erased and do not count; neither does an import whose
 * names are all marked `type`. (An import of names only used as types is erased too, but that can't be told from the text: say `import type`.)
 */
export function loadedBy(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  const found: string[] = [];
  const add = (spec: string) => found.push(posix.normalize(posix.join(posix.dirname(file), spec)).replace(/\.js$/, '.ts'));
  for (const m of text.matchAll(/^[ \t]*import\s+(?!type\b)([^'";]*?)\bfrom\s+'(\.{1,2}\/[^']+)'/gm)) {
    const names = /^\{([^}]*)\}\s*$/.exec(m[1]!.trim());
    const allTypes = names !== null && names[1]!.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '));
    if (!allTypes) add(m[2]!);
  }
  for (const m of text.matchAll(/^[ \t]*export\s+(?:\*|\{)[^'";]*?\bfrom\s+'(\.{1,2}\/[^']+)'/gm)) add(m[1]!);
  for (const m of text.matchAll(/^[ \t]*import\s+'(\.{1,2}\/[^']+)'/gm)) add(m[1]!);
  return found;
}

/** The modules that only know the game and its data, plus the small helpers everything uses. */
const isData = (f: string) =>
  f.startsWith('warframe/') || f.startsWith('wiki/') || f.startsWith('imaging/') || ['trackers.ts', 'errors.ts', 'own.ts', 'time.ts', 'timeout.ts', 'queue.ts', 'scheduler.ts'].includes(f);
/** The layers built on top of them: Discord, the service layer, the web pages, MCP and the wiring. */
const isUpper = (f: string) => /^(discord|services|web|mcp|lfg|selfroles|moderation|sticky|leveling|giveaways|birthdays|wishlist)\//.test(f) || ['index.ts', 'jobs.ts', 'http.ts'].includes(f);

describe('the layers', () => {
  const files = sourceFiles();
  const graph = new Map(files.map((f) => [f, loadedBy(f)]));

  it('reads the imports of the source files', () => {
    assert.ok(files.length > 100, `only ${files.length} files found`);
    assert.ok(graph.get('trackers.ts')!.includes('warframe/worldstate.ts'));
    assert.ok(graph.get('services/clan.ts')!.includes('errors.ts'));
    assert.ok(!graph.get('services/clan.ts')!.includes('context.ts'), 'an `import type` loads nothing');
    for (const [file, imports] of graph) for (const i of imports) assert.ok(graph.has(i), `${file} imports ${i}, which is not a file`);
  });

  it('the data modules never load Discord, the service layer, the web pages or MCP', () => {
    const problems: string[] = [];
    for (const start of files.filter(isData)) {
      // Breadth first, remembering how each file was reached, so a failure names the whole chain.
      const from = new Map<string, string | null>([[start, null]]);
      const queue = [start];
      while (queue.length) {
        const file = queue.shift()!;
        if (isUpper(file)) {
          const chain: string[] = [];
          for (let f: string | null = file; f; f = from.get(f) ?? null) chain.unshift(f);
          problems.push(chain.join(' → '));
          break;
        }
        for (const next of graph.get(file) ?? []) {
          if (from.has(next)) continue;
          from.set(next, file);
          queue.push(next);
        }
      }
    }
    assert.deepEqual(problems, [], 'a data module that needs something from above has it handed in, or the shared piece moves down (errors.ts)');
  });

  it('the bot loads in the order its entry point imports things', () => {
    const entry = loadedBy('index.ts').map((f) => pathToFileURL(join(SRC, f)).href);
    assert.ok(entry.length > 10);
    const script = 'for (const url of JSON.parse(process.argv[1])) await import(url); process.exit(0);';
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(entry)], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(run.status, 0, `loading the entry point's modules failed:\n${run.stderr || run.error?.message}`);
  });
});
