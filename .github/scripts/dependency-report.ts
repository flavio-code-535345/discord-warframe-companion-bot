/**
 * Turns what `npm audit --json` found into the text of a GitHub issue. Run by `.github/workflows/dependency-check.yml`:
 *
 *   node .github/scripts/dependency-report.ts <audit of what ships> <audit of everything> <report.md>
 *
 * One file with no imports but Node's own, because the workflow installs nothing: Node 24 runs TypeScript as it is, as long as the
 * file keeps to syntax that can simply be erased. The advisories come from outside, so nothing in them is trusted to be harmless in
 * an issue: `plain` keeps a title from mentioning anyone, linking anywhere or carrying markup, names go into code spans, and a link
 * is only made to GitHub's advisory database.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info', 'unrated'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Advisory {
  title: string;
  severity: Severity;
  /** Its ID in GitHub's advisory database, when the audit links there. */
  id: string | null;
}

export interface Finding {
  name: string;
  severity: Severity;
  /** The versions that have the problem. */
  range: string;
  /** In the image the bot runs from (a production dependency), not only among the build and test tools. */
  shipped: boolean;
  direct: boolean;
  /** The dependencies in package.json that bring it in (empty for a direct one, and when the lockfile could not be read). */
  from: string[];
  /** The vulnerable packages it has its problem through, when it has none of its own. */
  because: string[];
  advisories: Advisory[];
  /** What repairs it, as Markdown. */
  fix: string;
}

export interface Report {
  /** How many packages have a known vulnerability. */
  total: number;
  title: string;
  /** What to say under an issue that is already open (or when closing it). */
  comment: string;
  body: string;
  findings: Finding[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const severityOf = (v: unknown): Severity => SEVERITIES.find((s) => s === v) ?? 'unrated';

/** GitHub refuses an issue body over 65,536 characters. */
const MAX_BODY = 60_000;
const MAX_ADVISORIES = 8;
const ZWSP = '\u{200b}';
const ADVISORY = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/;
const PACKAGE = /^(?:@[A-Za-z0-9~-][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const RUN_URL = /^https:\/\/[A-Za-z0-9.-]+\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;
/** Control characters, line and paragraph separators, and the invisible ones that reorder or glue text. */
const UNSEEN = /[\u0000-\u001f\u007f-\u009f\u{200b}-\u{200f}\u{2028}-\u{202f}\u{2060}-\u{206f}\u{feff}]+/gu;

/**
 * Free text from outside as inert text on one line. A zero-width space after `@`, `#`, `<` and `&` keeps it from mentioning a
 * person, pointing at an issue, opening a tag or forming an entity; links and images are broken the same way. Code spans stay, as
 * advisory titles use them, and anything they could swallow ends with the line.
 */
export function plain(value: unknown, limit = 240): string {
  const flat = text(value).replace(UNSEEN, ' ').replace(/\s+/g, ' ').trim();
  const cut = flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
  return cut
    .replace(/[@#<&]/g, (c) => `${c}${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`)
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}${ZWSP}.`)
    .replace(/\](?=[([:])/g, `]${ZWSP}`);
}

/** A name or a version range from outside as a code span, where nothing is read as markup. */
export function code(value: unknown, limit = 120): string {
  const flat = text(value).replace(UNSEEN, ' ').replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, limit).trim();
  return `\`${flat || '?'}\``;
}

const list = (names: readonly string[], most = 6): string => {
  const shown = names.slice(0, most).map((n) => code(n));
  return names.length > most ? `${shown.join(', ')} and ${names.length - most} more` : shown.join(', ');
};

/** The `vulnerabilities` table of an audit result, or null when this is not one: npm prints an error as JSON too. */
function vulnerabilities(audit: unknown): Map<string, Json> | null {
  if (!isObject(audit) || !isObject(audit.vulnerabilities) || !isObject(audit.metadata) || !isObject(audit.metadata.vulnerabilities)) return null;
  const entries = Object.entries(audit.vulnerabilities).filter((e): e is [string, Json] => isObject(e[1]));
  // npm's own count is the check that the table was read the way npm means it.
  if (audit.metadata.vulnerabilities.total !== entries.length) return null;
  return new Map(entries);
}

/**
 * For a package's place in package-lock.json ("node_modules/hono"), the dependencies of package.json that bring it in. Names are
 * resolved the way Node does it: the nearest node_modules first, then each one further up.
 */
export function comesWith(lock: unknown): (node: string) => string[] {
  const table = isObject(lock) && isObject(lock.packages) ? lock.packages : {};
  const packages = new Map(Object.entries(table).filter((e): e is [string, Json] => isObject(e[1])));
  const wanted = (pkg: Json, kinds: readonly string[]): string[] => kinds.flatMap((kind) => (isObject(pkg[kind]) ? Object.keys(pkg[kind]) : []));
  const resolve = (from: string, name: string): string | null => {
    for (let dir = from; ; ) {
      const path = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      if (packages.has(path)) return path;
      if (!dir) return null;
      const cut = dir.lastIndexOf('/node_modules/');
      dir = cut === -1 ? '' : dir.slice(0, cut);
    }
  };
  const parents = new Map<string, Set<string>>();
  for (const [path, pkg] of packages) {
    const kinds = ['dependencies', 'optionalDependencies', 'peerDependencies', ...(path === '' ? ['devDependencies'] : [])];
    for (const name of wanted(pkg, kinds)) {
      const target = resolve(path, name);
      if (target === null) continue;
      const known = parents.get(target);
      if (known) known.add(path);
      else parents.set(target, new Set([path]));
    }
  }
  const nameOf = (path: string): string => path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return (node) => {
    const seen = new Set([node]);
    const direct = new Set<string>();
    for (const queue = [node]; queue.length; ) {
      const at = queue.shift() as string;
      for (const parent of parents.get(at) ?? []) {
        if (parent === '') direct.add(nameOf(at));
        else if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return [...direct].sort();
  };
}

/** What repairs a package, from the audit's `fixAvailable`: true, false, or the dependency to install at another version. */
function fixOf(fix: unknown): string {
  if (fix === true) return '`npm audit fix` updates it';
  if (isObject(fix)) {
    const name = text(fix.name);
    const version = text(fix.version);
    // A command someone will copy is only written from a name and a version that look like one.
    if (name.length > 214 || !PACKAGE.test(name) || !VERSION.test(version)) return 'another package has to be updated: `npm audit` names it';
    return `${code(`npm install ${name}@${version}`)}${fix.isSemVerMajor === true ? ` (a major update of ${code(name)}: read its changelog first)` : ''}`;
  }
  return 'no fixed version yet';
}

function findingOf(name: string, entry: Json, shipped: boolean, from: (node: string) => string[]): Finding {
  const via = Array.isArray(entry.via) ? entry.via : [];
  const advisories = via.filter(isObject).map((a): Advisory => ({ title: plain(a.title) || 'an advisory without a title', severity: severityOf(a.severity), id: ADVISORY.exec(text(a.url))?.[1] ?? null }));
  advisories.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  const direct = entry.isDirect === true;
  const parents = new Set(strings(entry.nodes).flatMap((node) => from(node)));
  parents.delete(name);
  return {
    name,
    severity: severityOf(entry.severity),
    range: text(entry.range),
    shipped,
    direct,
    from: direct ? [] : [...parents].sort(),
    because: strings(via),
    advisories,
    fix: fixOf(entry.fixAvailable),
  };
}

const packagesText = (n: number): string => (n === 1 ? '1 package with a known vulnerability' : `${n} packages with known vulnerabilities`);

/** "1 high, 2 moderate", the worst first. */
function severitiesText(findings: readonly Finding[]): string {
  return SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
}

function findingText(f: Finding): string {
  const facts = [
    `versions ${code(f.range)}`,
    f.direct ? 'a direct dependency' : f.from.length ? `comes with ${list(f.from)}` : 'comes with another package',
    f.because.length ? `vulnerable through ${list(f.because)}` : null,
    `fix: ${f.fix}`,
  ].filter((x) => x !== null);
  const shown = f.advisories.slice(0, MAX_ADVISORIES).map((a) => `- ${a.severity} · ${a.title}${a.id ? ` ([${a.id}](https://github.com/advisories/${a.id}))` : ''}`);
  const more = f.advisories.length - shown.length;
  return [`### ${code(f.name)} · ${f.severity}`, facts.join(' · '), '', ...shown, ...(more > 0 ? [`- and ${more} more: \`npm audit\` lists them all`] : [])].join('\n').trimEnd();
}

/** The blocks that fit into `budget` characters, then how many packages were left out. */
function fitted(findings: readonly Finding[], budget: number): { blocks: string[]; left: number; used: number } {
  const blocks: string[] = [];
  let used = 0;
  for (const f of findings) {
    const block = findingText(f);
    if (used + block.length + 2 > budget) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return { blocks, left: findings.length - blocks.length, used };
}

/**
 * The issue for two audits of the same lockfile: one of what ships (`npm audit --omit=dev`) and one of everything. Null when
 * either is not an audit result, which is not the same as "nothing found": the check itself did not work then.
 */
export function dependencyReport(shippedAudit: unknown, allAudit: unknown, opts: { lock?: unknown; runUrl?: string; now?: Date } = {}): Report | null {
  const shipped = vulnerabilities(shippedAudit);
  const all = vulnerabilities(allAudit);
  if (!shipped || !all) return null;
  const from = comesWith(opts.lock);
  const rank = (f: Finding): number => SEVERITIES.indexOf(f.severity);
  const findings = [...new Map([...all, ...shipped])]
    .map(([name, entry]) => findingOf(name, entry, shipped.has(name), from))
    .sort((a, b) => Number(b.shipped) - Number(a.shipped) || rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const total = findings.length;
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const run = opts.runUrl && RUN_URL.test(opts.runUrl) ? ` [This run](${opts.runUrl}).` : '';

  if (total === 0) {
    return {
      total,
      title: 'Dependency check: nothing found',
      comment: `The check of ${date} finds no known vulnerability any more. Closing.`,
      body: `The dependency check of ${date} found no known vulnerability in \`package-lock.json\`.${run}`,
      findings,
    };
  }

  const inImage = findings.filter((f) => f.shipped);
  const tools = findings.filter((f) => !f.shipped);
  const summary = `${packagesText(total)} (${severitiesText(findings)})`;
  const head = [
    `The dependency check of ${date} found **${packagesText(total)}** in \`package-lock.json\` (${severitiesText(findings)}): ${inImage.length} in the image the bot runs from, ${tools.length} only among the build and test tools.`,
  ];
  const tail = [
    '## What to do',
    [
      '1. `npm audit fix` updates everything that can be updated inside the version ranges of `package.json`.',
      '2. `npm run typecheck` and `npm test`, then commit `package-lock.json` and push: the image is built and deployed as usual.',
      '3. What is left needs a decision: a major update (after reading its changelog) or, where there is no fixed version yet, reading the advisory to see whether the bot uses the affected part at all.',
    ].join('\n'),
    `This issue is rewritten by every run of the check (the 1st of each month, or by hand under Actions → Dependency check → Run workflow) and closed by the first run that finds nothing.${run}`,
  ];
  const imageHead = "## In the bot's image";
  const toolsHead = '## Only among the build and test tools\nThese are not in the image: they run on a developer machine and in GitHub Actions.';
  const fixedLength = [...head, ...tail, imageHead, toolsHead].join('\n\n').length + 400;
  const image = fitted(inImage, MAX_BODY - fixedLength);
  const tool = fitted(tools, MAX_BODY - fixedLength - image.used);
  const left = image.left + tool.left;
  const body = [
    ...head,
    ...(inImage.length ? [imageHead, ...image.blocks] : []),
    ...(tools.length && tool.blocks.length ? [toolsHead, ...tool.blocks] : []),
    ...(left > 0 ? [`…and ${left} more ${left === 1 ? 'package' : 'packages'}: \`npm audit\` lists them all.`] : []),
    ...tail,
  ].join('\n\n');

  return {
    total,
    title: `Dependency check: ${summary}`,
    comment: `The check of ${date} still finds ${summary}. The list above is up to date.`,
    body,
    findings,
  };
}

/** The command line: reads the two audits, writes the report and hands the workflow its numbers. Returns the exit code. */
export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  const [shippedFile, allFile, outFile] = argv;
  if (!shippedFile || !allFile || !outFile) {
    console.error('usage: node dependency-report.ts <audit of what ships> <audit of everything> <report.md>');
    return 2;
  }
  const read = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const report = dependencyReport(read(shippedFile), read(allFile), { lock: read('package-lock.json'), runUrl });
  if (!report) {
    console.error('npm audit gave no result that can be read: its registry may not have answered. Nothing was checked, so nothing is reported.');
    return 1;
  }
  writeFileSync(outFile, `${report.body}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `total=${report.total}\ntitle=${report.title}\ncomment=${report.comment}\n`);
  console.log(report.title);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
