/**
 * Runs the clan's real questions (questions.ts) through smartAnswer against a copy of the wiki index and the live model, and
 * scores every answer. Not part of `npm test`: it needs the model, the network and a wiki.db (the crawler builds one).
 *
 *   WIKI_DB=path/to/wiki.db LOCAL_AI_URL=http://host:11434/v1 LOCAL_AI_MODEL=gemma4:e4b npm run eval -- [--operator] [--only id,id] [--brain brain.json] [--out results.json] [--verbose]
 *
 * --operator asks as one of the two operators (OPERATOR_IDS), --brain loads Brain settings (the `settings` of get_brain),
 * --verbose prints the facts each answer was written from and what the grounding check removed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { Client } from 'discord.js';
import { updateBrain } from '../../src/agent/brain.js';
import { smartAnswer } from '../../src/answers/smart.js';
import { loadConfig } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { Store } from '../../src/db.js';
import { configureWorldState } from '../../src/warframe/worldstate.js';
import { bindEmbedder } from '../../src/wiki/embed.js';
import { WikiIndex, setWikiIndex } from '../../src/wiki/index.js';
import { QUESTIONS } from './questions.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = loadConfig({ DISCORD_TOKEN: 'eval', DISCORD_GUILD_ID: '1', ...process.env });
const store = new Store(':memory:');
const ctx = { config, store, client: {} as Client, ai: null } satisfies AppContext;
const brainFile = option('brain');
if (brainFile) updateBrain(store, JSON.parse(readFileSync(brainFile, 'utf8')) as Record<string, unknown>);
if (!process.env.WIKI_DB) throw new Error('Set WIKI_DB to a wiki index file.');
setWikiIndex(new WikiIndex(process.env.WIKI_DB));
bindEmbedder(config);
configureWorldState({ enabled: true, platform: config.WARFRAME_PLATFORM, store });

const asker = flag('operator') ? { id: config.OPERATOR_IDS[0]!, name: 'Operator' } : { id: '100000000000000001', name: 'Member' };
const only = option('only')?.split(',');
const results: Record<string, unknown>[] = [];
let passed = 0;
for (const q of QUESTIONS.filter((x) => !only || only.includes(x.id))) {
  const t0 = Date.now();
  let content = '';
  let all = '';
  let meta = '';
  let trace: unknown;
  try {
    const a = await smartAnswer(q.question, ctx, asker);
    content = a.content;
    all = `${a.content}\n${a.embeds.map((e) => JSON.stringify(e.toJSON())).join('\n')}`;
    meta = `${a.intent}/${a.source}${a.model ? `/${a.model}` : ''}`;
    trace = a.trace;
  } catch (err) {
    content = `ERROR ${err instanceof Error ? err.message : String(err)}`;
  }
  const ms = Date.now() - t0;
  const missing = [...(q.must ?? []).filter((re) => !re.test(all)), ...(q.text ?? []).filter((re) => !re.test(content))].map(String);
  const wrong = (q.mustNot ?? []).filter((re) => re.test(content)).map(String);
  const ok = !missing.length && !wrong.length && !content.startsWith('ERROR');
  if (ok) passed++;
  results.push({ id: q.id, ok, ms, meta, missing, wrong, content, trace });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${q.id.padEnd(18)} ${String(Math.round(ms / 100) / 10).padStart(5)}s ${meta.padEnd(28)} ${missing.length ? `missing ${missing.join(' ')} ` : ''}${wrong.length ? `wrong ${wrong.join(' ')} ` : ''}`);
  console.log(`     ${content.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (flag('verbose') && trace) console.log(`     trace ${JSON.stringify(trace).slice(0, 1200)}`);
}
const times = results.map((r) => Number(r.ms)).sort((a, b) => a - b);
console.log(`\n${passed}/${results.length} passed, median ${Math.round((times[Math.floor(times.length / 2)] ?? 0) / 100) / 10}s, slowest ${Math.round((times.at(-1) ?? 0) / 100) / 10}s`);
const out = option('out');
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(0);
