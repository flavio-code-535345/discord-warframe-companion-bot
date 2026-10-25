import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { markOverlayHealthy, overlayDir, overrideSource, prepareOverlay, removeOverride, validCodePath, writeOverride } from '../src/overlay.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overlay-test-'));
  const dist = join(root, 'dist');
  const data = join(root, 'data');
  mkdirSync(join(dist, 'sub'), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(dist, 'dep.js'), "export const value = 'image';\n");
  writeFileSync(join(dist, 'sub', 'x.js'), 'export const x = 1;\n');
  return { root, dist, data };
}

describe('overlay paths', () => {
  it('accepts plain js files inside dist only', () => {
    assert.equal(validCodePath('discord/bot.js'), true);
    assert.equal(validCodePath('../secret.js'), false);
    assert.equal(validCodePath('/etc/passwd.js'), false);
    assert.equal(validCodePath('a//b.js'), false);
    assert.equal(validCodePath('index.ts'), false);
  });

  it('only patches files that exist', () => {
    const f = fixture();
    assert.throws(() => writeOverride(f.data, f.dist, 'nope.js', 'export {}'), /does not exist/);
    assert.throws(() => writeOverride(f.data, f.dist, '../x.js', 'export {}'), /not a valid path/);
  });
});

describe('overlay lifecycle', () => {
  it('activates a patch, arms the boot lock and clears it once healthy', () => {
    const f = fixture();
    writeOverride(f.data, f.dist, 'dep.js', "export const value = 'patched';\n");
    const state = prepareOverlay(f.data, f.dist);
    assert.equal(state.active.size, 1);
    assert.ok(existsSync(join(overlayDir(f.data), 'boot.lock')));
    markOverlayHealthy(f.data);
    assert.equal(existsSync(join(overlayDir(f.data), 'boot.lock')), false);
    assert.equal(prepareOverlay(f.data, f.dist).active.size, 1);
  });

  it('sets the overlay aside when the previous start never became healthy', () => {
    const f = fixture();
    writeOverride(f.data, f.dist, 'dep.js', 'export const value = 1;\n');
    prepareOverlay(f.data, f.dist); // first start arms the lock and "crashes"
    const second = prepareOverlay(f.data, f.dist);
    assert.equal(second.disabled, true);
    assert.equal(second.active.size, 0);
    assert.ok(readdirSync(f.data).some((n) => n.startsWith('overlay.disabled-')));
    assert.equal(prepareOverlay(f.data, f.dist).active.size, 0);
  });

  it('drops a patch when the image changed that file', () => {
    const f = fixture();
    writeOverride(f.data, f.dist, 'dep.js', 'export const value = 1;\n');
    writeFileSync(join(f.dist, 'dep.js'), "export const value = 'new image';\n");
    const state = prepareOverlay(f.data, f.dist);
    assert.equal(state.active.size, 0);
    assert.match(state.dropped[0]!.reason, /newer version/);
    assert.equal(overrideSource(f.data, 'dep.js'), null);
  });

  it('reverts one file or all', () => {
    const f = fixture();
    writeOverride(f.data, f.dist, 'dep.js', 'export const value = 1;\n');
    writeOverride(f.data, f.dist, 'sub/x.js', 'export const x = 2;\n');
    assert.deepEqual(removeOverride(f.data, 'dep.js'), ['dep.js']);
    assert.deepEqual(removeOverride(f.data), ['sub/x.js']);
    assert.equal(prepareOverlay(f.data, f.dist).active.size, 0);
  });
});

describe('overlay loader (real node process)', () => {
  it('runs the patched file with its imports still resolving from the image', () => {
    const f = fixture();
    // The loader is run from a copy next to the fixture's "dist", the way it sits in the image.
    for (const name of ['overlay.ts', 'overlay-register.ts']) copyFileSync(join(import.meta.dirname, '..', 'src', name), join(f.dist, name));
    writeFileSync(join(f.dist, 'main.js'), "import { value } from './dep.js';\nimport { x } from './sub/x.js';\nconsole.log(value, x);\n");
    writeOverride(f.data, f.dist, 'dep.js', "import { x } from './sub/x.js';\nexport const value = 'patched+' + x;\n");

    const run = (allow: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(join(f.dist, 'overlay-register.ts')).href, join(f.dist, 'main.js')], {
        env: { ...process.env, DATA_DIR: f.data, ALLOW_CODE_EDIT: allow },
        encoding: 'utf8',
      });

    const on = run('true');
    assert.match(on.stdout, /patched\+1 1/, on.stderr);
    markOverlayHealthy(f.data);
    assert.match(run('false').stdout, /^image 1$/m);
  });
});
