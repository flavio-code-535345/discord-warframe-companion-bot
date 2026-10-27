import express, { type Request, type Response, type Router } from 'express';
import { normalizeImage } from '../../imaging/sniff.js';
import { localModelOf } from '../../ai/ollama.js';
import type { AppContext } from '../../context.js';
import { readWithOcr, visionRead } from '../../ssroles/service.js';
import { type CardReading, checkClan, earnedNames, masteryRank } from '../../ssroles/roles.js';
import { localSkipReason, readCloud, readLocal } from '../../ssroles/vision.js';
import { escapeHtml as e } from '../status.js';
import { SSTEST_JS } from './sstest-client.js';
import { type PageContext, layout } from './pages.js';

/**
 * The panel's Screenshots page: a test area for the screenshot-roles readers. Upload a profile card (or a clan member list row)
 * and run each method on it, in the order the bot uses them: 1. OCR, 2. Gemma on Ollama, 3. Gemini. Each method runs separately
 * and reports what it read, how long it took and what the bot would decide. Nothing is stored and no roles are changed: the image
 * only exists in memory while the request runs.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
}

export const METHODS = ['ocr', 'local', 'cloud'] as const;
type Method = (typeof METHODS)[number];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

export interface TestResult {
  t: 'result';
  method: Method;
  /** read: a reading was produced; incomplete: the method could not read it (the next one would be asked); skipped: not available; failed: it was asked and gave nothing usable. */
  status: 'read' | 'incomplete' | 'skipped' | 'failed';
  ms: number;
  model: string | null;
  note: string;
  size: string | null;
  lines: string[];
  emblemSimilarity: number | null;
  reading: CardReading | null;
  rankRows: { rank: string; name: string | null }[];
  verdict: { ok: boolean; problems: string[]; mr: number | null; roles: string[] } | null;
}

const base = (method: Method): TestResult => ({ t: 'result', method, status: 'skipped', ms: 0, model: null, note: '', size: null, lines: [], emblemSimilarity: null, reading: null, rankRows: [], verdict: null });

export async function runMethod(ctx: AppContext, method: Method, upload: { mime: string; data: Uint8Array }): Promise<TestResult> {
  const { config, store } = ctx;
  // The label on an upload can be wrong (a PNG sent as WebP): go by the file header, as the channel does.
  const real = await normalizeImage(upload.data, upload.mime);
  const image = { mime: real.mime, data: real.bytes };
  const reference = store.getSsReference(config.DISCORD_GUILD_ID);
  const out = base(method);
  const finish = (read: ReturnType<typeof visionRead> | null): TestResult => {
    if (!read) return out;
    out.reading = read.reading;
    out.rankRows = (read.rankRows ?? []).map((r) => ({ rank: r.rank, name: r.name }));
    if (!out.rankRows.length) {
      const mr = masteryRank(read.reading);
      const check = checkClan(read.reading, config.CLAN_NAME, Boolean(reference));
      out.verdict = { ok: check.ok, problems: check.problems, mr, roles: [...earnedNames(read.reading, mr, config.CLAN_NAME)] };
    }
    return out;
  };

  if (method === 'ocr') {
    const a = await readWithOcr(image.data, image.mime, reference);
    Object.assign(out, { status: a.read ? 'read' : 'incomplete', ms: a.ms, note: a.note, size: a.size, lines: a.lines, emblemSimilarity: a.emblemSimilarity });
    return finish(a.read);
  }

  if (method === 'local') {
    // The test ignores the Local model switch and the pause after a failure: it is how you find out whether the model works.
    const a = await readLocal(config, image, fetch, { force: true });
    if (!a) {
      out.note = `Not available: ${localSkipReason(config, { force: true }) ?? 'unknown reason'}.`;
      return out;
    }
    Object.assign(out, { ms: a.ms, model: a.model, status: a.reading ? 'read' : 'failed' });
    out.note = a.reading ? 'Gemma read the image (the emblem is not compared by vision models).' : a.unreachable ? 'The Ollama server did not answer (check LOCAL_AI_URL and that the machine is awake).' : 'The model answered, but not with a readable result (see the bot log).';
    return finish(a.reading ? visionRead(a.reading, 'local', a.model, reference) : null);
  }

  // The test does not count against the daily allowance (Infinity), but a real call is still made.
  const a = await readCloud(config, image, fetch, Number.POSITIVE_INFINITY);
  if (!a || a.overLimit) {
    out.note = 'Not available: FREE_AI_KEY is not set.';
    return out;
  }
  Object.assign(out, { ms: a.ms, model: a.model, status: a.reading ? 'read' : 'failed' });
  out.note = a.reading ? 'Gemini read the image (the emblem is not compared by vision models).' : a.unreachable ? 'The cloud endpoint did not answer.' : 'The model answered, but not with a readable result (see the bot log).';
  return finish(a.reading ? visionRead(a.reading, 'cloud', a.model, reference) : null);
}

export function registerSsTestRoutes({ router, ctx, pc, html }: Deps): void {
  const { config, store } = ctx;

  router.get('/sstest', (req, res) => {
    const p = pc(res, 'sstest', req);
    const reference = store.getSsReference(config.DISCORD_GUILD_ID);
    const localModel = localModelOf(config);
    const skip = localSkipReason(config);
    const info = {
      ocr: 'tesseract.js in the bot itself, plus the clan emblem fingerprint. PNG and JPEG only. Free and fast.',
      local: config.LOCAL_AI_URL && localModel ? `${e(localModel)} on your Ollama server. No limit, but slow on a CPU (up to a couple of minutes).${skip ? ` <strong>The bot currently skips it: ${e(skip)}.</strong> The test still asks it.` : ''}` : 'Not configured: needs <code>LOCAL_AI_URL</code> and a model.',
      cloud: config.FREE_AI_KEY ? `${e(config.FREE_AI_MODEL)}${config.FREE_AI_FALLBACK_MODEL ? ` (then ${e(config.FREE_AI_FALLBACK_MODEL)})` : ''} on the free cloud endpoint. Daily allowance applies in the bot, not in this test.` : 'Not configured: needs <code>FREE_AI_KEY</code>.',
    };
    const card = (key: Method, n: number, title: string) =>
      `<div class="card stack" id="m-${key}"><div class="row"><div><strong>${n}. ${e(title)}</strong><div class="muted">${info[key]}</div></div><div><button type="button" class="ghost" data-run="${key}">Run only this</button></div></div><div class="out muted">Not run yet.</div></div>`;
    const body = `<h1>Screenshot test</h1>
<div class="card stack"><p class="flush muted">Upload a profile screenshot (or a row of the clan member list) and see what each reader makes of it. The bot tries them in this order: <strong>OCR</strong>, then <strong>Gemma</strong> on Ollama, then <strong>Gemini</strong>; the first to read the card wins. Here you can run all three to compare. Nothing is saved and no roles are changed: the picture only exists in memory while it is read. ${reference ? `Reference clan: <code>${e(reference.clanText)}</code>.` : 'No reference is stored yet (<code>/setup ssroles reference:</code>), so the emblem and clan number are not compared.'}</p>
<form class="stack" id="ssform"><input type="hidden" id="sscsrf" value="${e(p.session?.csrf ?? '')}">
<label>Screenshot (PNG, JPG or WebP, up to 8 MB)<input type="file" id="ssfile" accept="image/png,image/jpeg,image/webp"></label>
<div class="row"><label class="check"><input type="checkbox" id="ssstop"> Stop after the first method that reads it (what the bot does)</label><div><button id="ssall" type="submit">Run all in order</button></div></div>
</form></div>
${card('ocr', 1, 'OCR')}
${card('local', 2, 'Gemma (Ollama)')}
${card('cloud', 3, 'Gemini')}
<script nonce="${p.nonce}">${SSTEST_JS}</script>`;
    html(res, layout('Screenshot test', body, p));
  });

  router.post('/sstest/run', express.raw({ type: IMAGE_TYPES, limit: MAX_BYTES }), async (req, res) => {
    const method = String(req.query.method ?? '') as Method;
    if (!METHODS.includes(method)) return void res.status(400).json({ error: 'Unknown method.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: 'Send a PNG, JPG or WebP image as the request body.' });
    const mime = (req.get('content-type') ?? '').split(';')[0]!.trim();

    // Streams one JSON object per line: a ping every few seconds (a CPU model can take minutes, and proxies drop idle connections), then the result.
    res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const ping = setInterval(() => res.write('{"t":"ping"}\n'), 8_000);
    ping.unref();
    try {
      const result = await runMethod(ctx, method, { mime, data: new Uint8Array(req.body) });
      res.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
      res.write(`${JSON.stringify({ t: 'error', error: err instanceof Error ? err.message : String(err) })}\n`);
    } finally {
      clearInterval(ping);
      res.end();
    }
  });
}
