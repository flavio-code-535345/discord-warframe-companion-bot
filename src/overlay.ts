import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Code overlay: replacement versions of compiled files that live in the data volume and are loaded instead of the
 * image's own (see overlay-register.ts). It lets an admin patch the running bot over MCP without building an image.
 *
 * Safety nets: an override records the hash of the image file it replaces and is dropped when a new image changes
 * that file; and if the bot dies within SAFE_BOOT_MS of starting with an overlay active, the whole overlay is set aside
 * on the next start, so a bad patch can't leave the bot crash-looping.
 *
 * Builtins only: this file is loaded before anything else.
 */

export const SAFE_BOOT_MS = 15_000;
export const MAX_FILE_BYTES = 500_000;
const MANIFEST = 'manifest.json';
const LOCK = 'boot.lock';

export interface Manifest {
  /** Path relative to dist (forward slashes) → sha256 of the image's original file when the override was written. */
  files: Record<string, string>;
}

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

export const overlayDir = (dataDir: string): string => join(dataDir, 'overlay');

/** A path inside dist: letters, digits, `_`, `-`, `.` and `/`, ending in .js, never leaving the folder. */
export function validCodePath(path: string): boolean {
  return /^[\w\-./]+\.js$/.test(path) && !path.split('/').some((part) => part === '..' || part === '' || part === '.');
}

export function readManifest(dir: string): Manifest {
  try {
    const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as Manifest;
    return m && typeof m.files === 'object' && m.files ? m : { files: {} };
  } catch {
    return { files: {} };
  }
}

function writeManifest(dir: string, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
}

const inside = (root: string, path: string): boolean => resolve(path).startsWith(resolve(root) + sep);

/** Every .js file of the image, relative to dist. */
export function listDistFiles(distDir: string, sub = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(distDir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listDistFiles(distDir, rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

/** The image file an override applies to (it must already exist); throws with a reason otherwise. */
export function distFileFor(distDir: string, path: string): string {
  if (!validCodePath(path)) throw new Error(`"${path}" is not a valid path inside dist (use e.g. discord/bot.js).`);
  const file = resolve(distDir, path);
  if (!inside(distDir, file) || !existsSync(file) || !statSync(file).isFile()) throw new Error(`dist/${path} does not exist in this image.`);
  return file;
}

export function writeOverride(dataDir: string, distDir: string, path: string, content: string): void {
  const base = distFileFor(distDir, path);
  const dir = overlayDir(dataDir);
  const target = join(dir, 'files', path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  const manifest = readManifest(dir);
  manifest.files[path] = sha256(readFileSync(base));
  writeManifest(dir, manifest);
}

export function removeOverride(dataDir: string, path?: string): string[] {
  const dir = overlayDir(dataDir);
  const manifest = readManifest(dir);
  const removed = path ? [path].filter((p) => p in manifest.files) : Object.keys(manifest.files);
  for (const p of removed) {
    rmSync(join(dir, 'files', p), { force: true });
    delete manifest.files[p];
  }
  writeManifest(dir, manifest);
  return removed;
}

export function overrideSource(dataDir: string, path: string): string | null {
  try {
    return readFileSync(join(overlayDir(dataDir), 'files', path), 'utf8');
  } catch {
    return null;
  }
}

export interface OverlayState {
  /** Absolute image path → replacement source. */
  active: Map<string, string>;
  /** Overrides left out and why, for the startup log. */
  dropped: { path: string; reason: string }[];
  disabled: boolean;
}

/**
 * Decides what to load at startup. Sets the whole overlay aside when the previous start didn't survive SAFE_BOOT_MS,
 * drops overrides whose image file changed, and (if anything is active) arms the boot lock.
 */
export function prepareOverlay(dataDir: string, distDir: string, now = Date.now()): OverlayState {
  const dir = overlayDir(dataDir);
  const state: OverlayState = { active: new Map(), dropped: [], disabled: false };
  if (!existsSync(join(dir, MANIFEST))) return state;

  if (existsSync(join(dir, LOCK))) {
    renameSync(dir, `${dir}.disabled-${now}`);
    state.disabled = true;
    return state;
  }

  const manifest = readManifest(dir);
  for (const [path, baseHash] of Object.entries(manifest.files)) {
    try {
      const file = distFileFor(distDir, path);
      const source = overrideSource(dataDir, path);
      if (source === null) state.dropped.push({ path, reason: 'override file is missing' });
      else if (sha256(readFileSync(file)) !== baseHash) {
        state.dropped.push({ path, reason: 'the image has a newer version of this file' });
        removeOverride(dataDir, path);
      } else state.active.set(realpathSync(file), source);
    } catch (err) {
      state.dropped.push({ path, reason: (err as Error).message });
    }
  }
  if (state.active.size) writeFileSync(join(dir, LOCK), String(now));
  return state;
}

/** Called once the bot has been up long enough: the overlay is trusted for the next start. */
export function markOverlayHealthy(dataDir: string): void {
  rmSync(join(overlayDir(dataDir), LOCK), { force: true });
}

export function overlayStatus(dataDir: string): { overrides: string[]; pendingBootCheck: boolean } {
  const dir = overlayDir(dataDir);
  return { overrides: Object.keys(readManifest(dir).files), pendingBootCheck: existsSync(join(dir, LOCK)) };
}
