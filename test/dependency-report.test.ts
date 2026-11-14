import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { code, comesWith, dependencyReport, plain } from '../.github/scripts/dependency-report.js';

type Entry = Record<string, unknown>;

/** An audit result the way `npm audit --json` prints it. */
function audit(vulnerabilities: Record<string, Entry>): unknown {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: Object.keys(vulnerabilities).length };
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: counts, dependencies: { prod: 148, dev: 60, total: 207 } } };
}

const advisory = (title: string, id: string, severity = 'moderate'): Entry => ({ source: 1, name: 'x', dependency: 'x', title, url: `https://github.com/advisories/${id}`, severity, range: '<1.0.0' });

/** What the check really found on the day it was written (2026-11-14). */
const HONO: Record<string, Entry> = {
  '@hono/node-server': {
    name: '@hono/node-server',
    severity: 'moderate',
    isDirect: false,
    via: [
      advisory('@hono/node-server: Unhandled `ECONNRESET` on the socket during an asynchronous WebSocket upgrade crashes the process', 'GHSA-qv5m-9pm6-hqp3'),
      advisory('@hono/node-server: Backslash in the request path is parsed as a path separator, bypassing path-based access control at a reverse proxy', 'GHSA-jpvv-r467-5p4w'),
    ],
    effects: [],
    range: '2.0.0 - 2.1.5',
    nodes: ['node_modules/@hono/node-server'],
    fixAvailable: true,
  },
  hono: {
    name: 'hono',
    severity: 'moderate',
    isDirect: false,
    via: [
      advisory('Hono: `mount()` and `app.mount()` can forward a path that bypasses middleware scoped inside the mount prefix', 'GHSA-4m76-xfj5-7975'),
      advisory('Hono: `css` helper does not escape a closing tag split between the template and an interpolated value, allowing HTML injection', 'GHSA-3gg2-335m-rxc6', 'low'),
    ],
    effects: [],
    range: '<=4.13.15',
    nodes: ['node_modules/hono'],
    fixAvailable: true,
  },
};

/** A small package-lock.json: the MCP SDK brings Hono, tsx brings esbuild, and `nested` has a copy of its own. */
const LOCK = {
  lockfileVersion: 3,
  packages: {
    '': { dependencies: { '@modelcontextprotocol/sdk': '^1.32.2', express: '^5.3.0', nested: '^1.0.0' }, devDependencies: { tsx: '^4.23.15' } },
    'node_modules/@modelcontextprotocol/sdk': { dependencies: { '@hono/node-server': '^2.0.0', hono: '^4.11.4', express: '^5.2.1' } },
    'node_modules/@hono/node-server': { peerDependencies: { hono: '^4' } },
    'node_modules/hono': {},
    'node_modules/express': { dependencies: { qs: '^6.14.0' } },
    'node_modules/qs': {},
    'node_modules/nested': { dependencies: { qs: '^5.0.0', ring: '^1.0.0' } },
    'node_modules/nested/node_modules/qs': {},
    'node_modules/ring': { peerDependencies: { nested: '^1.0.0', missing: '*' } },
    'node_modules/tsx': { dependencies: { esbuild: '~0.27.0' }, devDependencies: { ignored: '1' } },
    'node_modules/esbuild': {},
    'node_modules/ignored': {},
  },
};

const NOW = new Date('2026-11-14T10:00:00Z');
const RUN = 'https://github.com/owner/repo/actions/runs/123456';

describe('the dependency report', () => {
  it('writes the issue for what the check found today', () => {
    const report = dependencyReport(audit(HONO), audit(HONO), { lock: LOCK, runUrl: RUN, now: NOW });
    assert.ok(report);
    assert.equal(report.total, 2);
    assert.equal(report.title, 'Dependency check: 2 packages with known vulnerabilities (2 moderate)');
    assert.equal(report.comment, 'The check of 2026-11-14 still finds 2 packages with known vulnerabilities (2 moderate). The list above is up to date.');
    assert.deepEqual(
      report.findings.map((f) => [f.name, f.shipped, f.direct, f.from]),
      [
        ['@hono/node-server', true, false, ['@modelcontextprotocol/sdk']],
        ['hono', true, false, ['@modelcontextprotocol/sdk']],
      ],
    );
    const { body } = report;
    assert.match(body, /^The dependency check of 2026-11-14 found \*\*2 packages with known vulnerabilities\*\* in `package-lock\.json` \(2 moderate\): 2 in the image the bot runs from, 0 only among the build and test tools\./);
    assert.match(body, /## In the bot's image/);
    assert.doesNotMatch(body, /Only among the build and test tools/);
    assert.match(body, /### `hono` · moderate\nversions `<=4\.13\.15` · comes with `@modelcontextprotocol\/sdk` · fix: `npm audit fix` updates it\n\n- moderate · Hono: `mount\(\)`/);
    assert.match(body, /- low · Hono: `css` helper .* \(\[GHSA-3gg2-335m-rxc6\]\(https:\/\/github\.com\/advisories\/GHSA-3gg2-335m-rxc6\)\)/);
    assert.match(body, /## What to do\n\n1\. `npm audit fix`/);
    assert.ok(body.endsWith(`[This run](${RUN}).`));
    // The package's own name in a title must not call a GitHub team of that name.
    assert.doesNotMatch(body, /@hono\/node-server:/);
    assert.match(body, /@\u{200b}hono\/node-server: Unhandled `ECONNRESET`/u);
  });

  it('keeps what is only among the build tools apart, and puts the worst first', () => {
    const tools: Record<string, Entry> = {
      esbuild: { name: 'esbuild', severity: 'high', isDirect: false, via: [advisory('esbuild lets any website read the development server', 'GHSA-67mh-4wv8-2f99', 'high')], effects: ['tsx'], range: '<=0.27.1', nodes: ['node_modules/esbuild'], fixAvailable: true },
      tsx: { name: 'tsx', severity: 'high', isDirect: true, via: ['esbuild'], effects: [], range: '4.0.0 - 4.23.15', nodes: ['node_modules/tsx'], fixAvailable: { name: 'tsx', version: '5.0.0', isSemVerMajor: true } },
    };
    const shipped: Record<string, Entry> = {
      qs: { name: 'qs', severity: 'low', isDirect: false, via: [advisory('qs: a long key takes long to parse', 'GHSA-aaaa-bbbb-cccc', 'low')], effects: [], range: '<6.14.1', nodes: ['node_modules/qs', 'node_modules/nested/node_modules/qs'], fixAvailable: false },
      express: { name: 'express', severity: 'critical', isDirect: true, via: [advisory('express: something bad', 'GHSA-1111-2222-3333', 'critical')], effects: [], range: '<5.4.0', nodes: ['node_modules/express'], fixAvailable: { name: 'express', version: '5.4.0', isSemVerMajor: false } },
    };
    const report = dependencyReport(audit(shipped), audit({ ...tools, ...shipped }), { lock: LOCK, now: NOW });
    assert.ok(report);
    assert.equal(report.title, 'Dependency check: 4 packages with known vulnerabilities (1 critical, 2 high, 1 low)');
    assert.deepEqual(
      report.findings.map((f) => [f.name, f.shipped]),
      [
        ['express', true],
        ['qs', true],
        ['esbuild', false],
        ['tsx', false],
      ],
    );
    const byName = new Map(report.findings.map((f) => [f.name, f]));
    assert.deepEqual(byName.get('qs')?.from, ['@modelcontextprotocol/sdk', 'express', 'nested'], 'both copies, each through what brings it (the SDK needs express too)');
    assert.deepEqual(byName.get('esbuild')?.from, ['tsx']);
    assert.deepEqual(byName.get('tsx')?.because, ['esbuild']);
    assert.equal(byName.get('qs')?.fix, 'no fixed version yet');
    assert.equal(byName.get('express')?.fix, '`npm install express@5.4.0`');
    assert.equal(byName.get('tsx')?.fix, '`npm install tsx@5.0.0` (a major update of `tsx`: read its changelog first)');

    const { body } = report;
    assert.match(body, /2 in the image the bot runs from, 2 only among the build and test tools\./);
    const image = body.indexOf("## In the bot's image");
    const toolsAt = body.indexOf('## Only among the build and test tools');
    assert.ok(image > 0 && toolsAt > image);
    assert.ok(body.indexOf('### `express` · critical') < body.indexOf('### `qs` · low'));
    assert.ok(body.indexOf('### `qs` · low') < toolsAt && toolsAt < body.indexOf('### `esbuild` · high'));
    assert.match(body, /### `express` · critical\nversions `<5\.4\.0` · a direct dependency · fix: `npm install express@5\.4\.0`/);
    assert.match(body, /### `tsx` · high\nversions `4\.0\.0 - 4\.23\.15` · a direct dependency · vulnerable through `esbuild` · fix: `npm install tsx@5\.0\.0`/);
    assert.doesNotMatch(body, /This run/, 'no link without a run');
  });

  it('says so when nothing is found, with the words that close the issue', () => {
    const report = dependencyReport(audit({}), audit({}), { lock: LOCK, runUrl: RUN, now: NOW });
    assert.ok(report);
    assert.equal(report.total, 0);
    assert.equal(report.title, 'Dependency check: nothing found');
    assert.equal(report.comment, 'The check of 2026-11-14 finds no known vulnerability any more. Closing.');
    assert.equal(report.body, `The dependency check of 2026-11-14 found no known vulnerability in \`package-lock.json\`. [This run](${RUN}).`);
  });

  it('is no report when npm could not ask: that is not "nothing found"', () => {
    const failed = { error: { code: 'ENOTFOUND', summary: 'request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed' } };
    for (const bad of [failed, null, undefined, [], 'text', 3, {}, { vulnerabilities: {} }, { vulnerabilities: {}, metadata: {} }]) {
      assert.equal(dependencyReport(bad, audit({})), null);
      assert.equal(dependencyReport(audit({}), bad), null);
    }
    // npm's own count is the check that the table was understood.
    assert.equal(dependencyReport(audit({}), { vulnerabilities: { hono: HONO.hono }, metadata: { vulnerabilities: { total: 2 } } }), null);
    assert.equal(dependencyReport(audit({}), { vulnerabilities: { hono: 'not an entry' }, metadata: { vulnerabilities: { total: 1 } } }), null);
  });

  it('works without a lockfile, and with entries that are not what they should be', () => {
    const odd: Record<string, Entry> = {
      hono: { ...HONO.hono, nodes: 'node_modules/hono' },
      constructor: { severity: 'constructor', via: 'hono', range: 7, nodes: [3, null], fixAvailable: 'yes' },
      ['__proto__']: { severity: 'high', isDirect: 'true', via: [null, 5, { title: 9, url: 4 }], fixAvailable: { name: 'a b; rm -rf /', version: '1.0.0' } },
      toString: { severity: 'low', via: [], fixAvailable: { name: 'ok', version: '`whoami`' } },
    };
    const table = Object.fromEntries(Object.entries(odd));
    const report = dependencyReport(audit({}), JSON.parse(JSON.stringify({ auditReportVersion: 2, vulnerabilities: table, metadata: { vulnerabilities: { total: 4 } } })), { now: NOW });
    assert.ok(report);
    assert.equal(report.total, 4);
    assert.deepEqual(
      report.findings.map((f) => [f.name, f.severity, f.direct, f.from]),
      [
        ['__proto__', 'high', false, []],
        ['hono', 'moderate', false, []],
        ['toString', 'low', false, []],
        ['constructor', 'unrated', false, []],
      ],
    );
    assert.match(report.body, /### `hono` · moderate\nversions `<=4\.13\.15` · comes with another package · fix:/);
    assert.match(report.body, /### `constructor` · unrated\nversions `\?` · comes with another package · fix: no fixed version yet/);
    assert.match(report.body, /- unrated · an advisory without a title\n/);
    assert.doesNotMatch(report.body, /rm -rf|whoami/, 'a command is only written from a name and a version that look like one');
    assert.equal(report.body.match(/another package has to be updated: `npm audit` names it/g)?.length, 2);
  });

  it('never lets an advisory mention, link or mark up anything', () => {
    const hostile =
      'Pwn @octocat and @github/security, see #12 and owner/repo#3 <img src=x onerror=alert(1)> [x](https://evil.example) ![i](http://e/p.png) [r][ref] ' +
      'https://github.com/a/b/issues/1 www.evil.example mail me@evil.example &#64;octocat &lt;b&gt;\n## A heading\r\n- a list \u{202e}gnp.exe\u{200b}';
    const report = dependencyReport(
      audit({}),
      audit({
        'bad`name\n## x': { severity: 'high', isDirect: true, via: [{ title: hostile, url: 'https://evil.example/advisories/GHSA-aaaa-bbbb-cccc', severity: 'high' }, { title: 'x'.repeat(900), url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc/../../evil', severity: 'low' }], range: '`<1`\n# big', nodes: [], fixAvailable: true },
      }),
      { runUrl: 'https://evil.example/owner/repo/actions/runs/1) [x](https://evil.example', now: NOW },
    );
    assert.ok(report);
    const { body } = report;
    const line = body.split('\n').find((l) => l.startsWith('- high · '));
    assert.ok(line, 'the whole title is one line');
    assert.match(line, /Pwn @\u{200b}octocat and @\u{200b}github\/security, see #\u{200b}12 and owner\/repo#\u{200b}3 <\u{200b}img src=x/u);
    assert.doesNotMatch(line, /@[A-Za-z]/, 'no mention');
    assert.doesNotMatch(line, /#\d/, 'no reference to an issue');
    assert.doesNotMatch(line, /<[A-Za-z/!]/, 'no tag');
    assert.doesNotMatch(line, /&[#A-Za-z]/, 'no entity');
    assert.doesNotMatch(line, /\]\(|\]\[|:\/\/|www\./, 'no link and no image');
    assert.doesNotMatch(line, /[\u{202a}-\u{202e}\u{2066}-\u{2069}]/u, 'nothing that reorders the text');
    assert.doesNotMatch(body, /^#+ (A heading|x|big)/m, 'no heading of its own');
    assert.doesNotMatch(body, /evil\.example\/advisories|GHSA-aaaa-bbbb-cccc/, 'a link only to the advisory database itself');
    assert.match(body, /### `bad'name ## x` · high\nversions `'<1' # big` · a direct dependency/);
    assert.doesNotMatch(body, /This run/, 'the run link only when it is a run');
    const long = body.split('\n').find((l) => l.startsWith('- low · '));
    assert.ok(long && long.length < 260 && long.endsWith('…'));
  });

  it('stays inside what GitHub accepts however much is found', () => {
    const many: Record<string, Entry> = {};
    for (let i = 0; i < 300; i++) {
      many[`package-${String(i).padStart(3, '0')}`] = {
        severity: i % 2 ? 'high' : 'moderate',
        isDirect: false,
        via: Array.from({ length: 20 }, (_, n) => advisory(`Problem ${n} `.repeat(30), 'GHSA-aaaa-bbbb-cccc')),
        range: '<9.9.9',
        nodes: [],
        fixAvailable: false,
      };
    }
    const shipped = Object.fromEntries(Object.entries(many).slice(0, 150));
    const report = dependencyReport(audit(shipped), audit(many), { runUrl: RUN, now: NOW });
    assert.ok(report);
    assert.equal(report.total, 300);
    const { body } = report;
    assert.ok(body.length <= 60_000, `the body has ${body.length} characters`);
    assert.ok(body.length > 50_000, 'and uses the room it has');
    const listed = body.match(/^### `package-\d+`/gm)?.length ?? 0;
    assert.ok(listed > 10 && listed < 300);
    assert.match(body, new RegExp(`…and ${300 - listed} more packages: \`npm audit\` lists them all\\.`));
    assert.match(body, /- and 12 more: `npm audit` lists them all/, 'eight advisories a package, the rest counted');
    assert.match(body, /## What to do/);
    assert.ok(body.endsWith(`[This run](${RUN}).`), 'the end is never cut off');
    assert.equal(report.title, 'Dependency check: 300 packages with known vulnerabilities (150 high, 150 moderate)');
  });
});

describe('the helpers of the dependency report', () => {
  it('finds what brings a package in, the way Node resolves names', () => {
    const from = comesWith(LOCK);
    assert.deepEqual(from('node_modules/hono'), ['@modelcontextprotocol/sdk']);
    assert.deepEqual(from('node_modules/@hono/node-server'), ['@modelcontextprotocol/sdk']);
    assert.deepEqual(from('node_modules/qs'), ['@modelcontextprotocol/sdk', 'express'], 'the copy at the top is the one express and the SDK use');
    assert.deepEqual(from('node_modules/nested/node_modules/qs'), ['nested'], 'the nested copy belongs to nested alone');
    assert.deepEqual(from('node_modules/express'), ['@modelcontextprotocol/sdk', 'express'], 'a direct one names itself too');
    assert.deepEqual(from('node_modules/esbuild'), ['tsx']);
    assert.deepEqual(from('node_modules/ring'), ['nested'], 'a circle of peers ends');
    assert.deepEqual(from('node_modules/ignored'), [], 'what a dependency only needs for its own development is not installed for it');
    assert.deepEqual(from('node_modules/unknown'), []);
    for (const bad of [null, undefined, 'x', [], {}, { packages: null }, { packages: { '': 'x', a: null } }]) assert.deepEqual(comesWith(bad)('node_modules/hono'), []);
  });

  it('makes outside text inert and names safe to show', () => {
    assert.equal(plain('Hono: `css` helper'), 'Hono: `css` helper');
    assert.equal(plain('  two\n\nlines\tand tabs '), 'two lines and tabs');
    assert.equal(plain('a@b #1 <b> &amp; x'), 'a@\u{200b}b #\u{200b}1 <\u{200b}b> &\u{200b}amp; x');
    assert.equal(plain('see [a](b) ![c](d) [e][f] [g]: h'), 'see [a]\u{200b}(b) ![c]\u{200b}(d) [e]\u{200b}[f] [g]\u{200b}: h');
    assert.equal(plain('http://a.b WWW.c.d ftp://e'), 'http:\u{200b}//a.b WWW\u{200b}.c.d ftp:\u{200b}//e');
    assert.equal(plain('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
    for (const nothing of [null, undefined, 5, {}, [], '']) assert.equal(plain(nothing), '');
    assert.equal(code('hono'), '`hono`');
    assert.equal(code('a`b`c'), "`a'b'c`");
    assert.equal(code(' \n '), '`?`');
    assert.equal(code(null), '`?`');
    assert.equal(code('y'.repeat(500)).length, 122);
  });
});

describe('the dependency report as the workflow runs it', () => {
  const script = join(import.meta.dirname, '..', '.github', 'scripts', 'dependency-report.ts');
  const root = join(import.meta.dirname, '..');
  /** Plain Node, as in the workflow: no tsx and nothing installed, so the file itself must be something Node can run. */
  const run = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '', ...env } });

  it('writes the report and hands over the count, the title and the comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dependency-report-'));
    try {
      const shipped = join(dir, 'shipped.json');
      const all = join(dir, 'all.json');
      const out = join(dir, 'report.md');
      const outputs = join(dir, 'outputs.txt');
      writeFileSync(shipped, JSON.stringify(audit(HONO)));
      writeFileSync(all, JSON.stringify(audit(HONO)));
      writeFileSync(outputs, '');
      const env = { GITHUB_OUTPUT: outputs, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '123456' };
      const found = run([shipped, all, out], env);
      assert.equal(found.status, 0, found.stderr);
      assert.equal(found.stdout.trim(), 'Dependency check: 2 packages with known vulnerabilities (2 moderate)');
      const body = readFileSync(out, 'utf8');
      assert.match(body, /### `hono` · moderate/);
      assert.ok(body.endsWith(`[This run](${RUN}).\n`));
      const lines = readFileSync(outputs, 'utf8').trim().split('\n');
      assert.equal(lines.length, 3, 'one line each: nothing in them can add an output of its own');
      assert.equal(lines[0], 'total=2');
      assert.equal(lines[1], 'title=Dependency check: 2 packages with known vulnerabilities (2 moderate)');
      assert.match(lines[2] ?? '', /^comment=The check of \d{4}-\d\d-\d\d still finds 2 packages with known vulnerabilities \(2 moderate\)\. The list above is up to date\.$/);

      // Nothing found: the count the workflow closes the issue on.
      writeFileSync(shipped, JSON.stringify(audit({})));
      writeFileSync(all, JSON.stringify(audit({})));
      writeFileSync(outputs, '');
      const clean = run([shipped, all, out], env);
      assert.equal(clean.status, 0, clean.stderr);
      assert.match(readFileSync(outputs, 'utf8'), /^total=0\ntitle=Dependency check: nothing found\ncomment=The check of \d{4}-\d\d-\d\d finds no known vulnerability any more\. Closing\.\n$/);

      // npm could not ask: an error, no count, and the old report is not passed off as new.
      writeFileSync(all, JSON.stringify({ error: { code: 'ENOTFOUND' } }));
      writeFileSync(outputs, '');
      const failed = run([shipped, all, out], env);
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /Nothing was checked/);
      assert.equal(readFileSync(outputs, 'utf8'), '');

      writeFileSync(all, 'not json at all');
      assert.equal(run([shipped, all, out], env).status, 1);
      assert.equal(run([shipped, join(dir, 'missing.json'), out], env).status, 1);
      assert.equal(run([shipped, all], env).status, 2, 'three files are needed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
