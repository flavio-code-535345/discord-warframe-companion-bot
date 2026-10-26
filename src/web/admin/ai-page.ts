import type { Request, RequestHandler, Response, Router } from 'express';
import { aiOverview, chooseModel, installModel, setToggle, testModel } from '../../ai/control.js';
import { gb } from '../../ai/ollama.js';
import { TOGGLE_KEYS, isToggle } from '../../ai/settings.js';
import { sourceLabel } from '../../answers/log.js';
import type { AppContext } from '../../context.js';
import type { PanelSession } from '../../db.js';
import { UserError } from '../../services/clan.js';
import { escapeHtml as e } from '../status.js';
import { type PageContext, csrfField, layout, select } from './pages.js';

/**
 * The panel's AI page: the same controls as the /ai command (both call ai/control.ts), plus the recent question log.
 * Server-rendered forms, no script.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  action: (path: string, fn: (req: Request, session: PanelSession) => Promise<string>) => RequestHandler;
  audit: (session: PanelSession, what: string, fields?: { name: string; value: string }[]) => Promise<void>;
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function registerAiRoutes({ router, ctx, pc, html, action, audit }: Deps): void {
  const { store, config } = ctx;
  const guildId = config.DISCORD_GUILD_ID;

  router.get('/ai', async (req, res) => {
    const p = pc(res, 'ai', req);
    const o = await aiOverview(ctx);
    const log = store.recentAiLog(guildId, 15);
    const stats = store.aiLogStats(guildId, Date.now() - 86_400_000);

    const status = !o.configured
      ? '<p class="muted">No local AI server is set up. Add <code>LOCAL_AI_URL</code> and <code>LOCAL_AI_MODEL</code> to the bot\'s environment to use Ollama; answers use the free cloud model until then.</p>'
      : o.reachable
        ? `<div class="grid">
<div class="card"><div class="stat">🟢 Online</div><div class="muted">Ollama ${e(o.version ?? '')}</div></div>
<div class="card"><div class="stat small">${e(o.model ?? '—')}</div><div class="muted">${o.chosen ? 'chosen here or with /ai model' : 'the bot\'s default'}${o.thinkingCapable ? ' · can think' : ''}${o.skippedAfterFailure ? ' · ⚠️ skipped after a failure' : ''}</div></div>
<div class="card"><div class="stat small">${o.loaded.length ? e(o.loaded.map((m) => `${m.name} (${gb(m.size)})`).join(', ')) : 'nothing loaded'}</div><div class="muted">in memory right now</div></div>
</div>`
        : `<div class="flash err">The AI server is not reachable: ${e(o.error ?? 'unknown error')}</div>`;

    const toggles = `<div class="card"><table>${o.toggles
      .map(
        (t) =>
          `<tr><td><strong>${e(t.label)}</strong><div class="muted">${e(t.help)}</div></td><td>${t.on ? '🟢 on' : '⚫ off'}</td><td><form class="inline" method="post" action="/admin/ai/toggle">${csrfField(p.session)}<input type="hidden" name="feature" value="${e(t.key)}"><input type="hidden" name="on" value="${t.on ? '0' : '1'}"><button class="ghost">${t.on ? 'Turn off' : 'Turn on'}</button></form></td></tr>`,
      )
      .join('')}</table>
<p class="muted">Web search: ${o.webSearch.configured ? `SearXNG at <code>${e(o.webSearch.host ?? '')}</code>` : 'not configured (<code>SEARXNG_URL</code>)'} · operators: ${o.operators} Discord IDs (<code>OPERATOR_IDS</code>)</p></div>`;

    const modelOptions = o.installed.map((m) => ({ value: m.name, label: `${m.name} · ${gb(m.size)}${m.parameters ? ` · ${m.parameters}` : ''}` }));
    const models = o.reachable
      ? `<div class="card"><form class="stack" method="post" action="/admin/ai/model">${csrfField(p.session)}
<div class="row"><label>Model that answers questions${select('model', modelOptions, o.chosen ? o.model : null, `— the bot's default${o.defaultModel ? ` (${o.defaultModel})` : ''} —`)}</label></div>
<div><button>Use this model</button></div></form></div>
<div class="card"><form class="stack" method="post" action="/admin/ai/install">${csrfField(p.session)}
<p class="muted">Downloads a model onto the AI server (several GB, runs in the background; reload this page to follow it). Use a library tag like <code>gemma3:27b</code> or <code>hf.co/user/repo:Q4_K_M</code>.</p>
<div class="row"><label>Model tag<input name="tag" maxlength="120" required placeholder="gemma3:27b"></label></div>
<div><button>Download</button></div></form>
${
  o.download
    ? `<p class="muted">Download: <strong>${e(o.download.model)}</strong> — ${o.download.error ? `❌ ${e(o.download.error)}` : o.download.finishedAt ? '✅ done' : e(o.download.progress ?? o.download.status)}</p>`
    : ''
}</div>
<div class="card"><form class="stack" method="post" action="/admin/ai/test">${csrfField(p.session)}
<div class="row"><label>Test prompt (optional)<input name="prompt" maxlength="300" placeholder="Say hello in one short sentence."></label></div>
<div><button class="ghost">Test the model</button></div></form></div>`
      : '';

    const logRows = log.length
      ? `<table><tr><th>When</th><th>Who</th><th>Source</th><th>Question</th></tr>${log
          .map((l) => `<tr><td>${e(utc(l.at))}</td><td>${e(clip(l.userName, 20))}</td><td>${e(sourceLabel(l))} · ${(l.ms / 1000).toFixed(1)}s</td><td>${e(clip(l.question, 90))}${l.found ? '' : ' ⚠️'}</td></tr>`)
          .join('')}</table>`
      : '<p class="muted">No questions logged yet.</p>';
    const summary = Object.entries(stats).map(([s, n]) => `${s} ${n}`).join(' · ');

    const body = `<h1>AI</h1>
${status}
<h2>Switches</h2>
${toggles}
<h2>Model</h2>
${models || '<p class="muted">Connect the AI server to choose a model.</p>'}
<h2>Recent questions</h2>
<div class="card">${logRows}<p class="muted">Last 24 h: ${e(summary || 'none')} · the full log is in Discord with <code>/ailog</code></p></div>`;
    html(res, layout('AI', body, p));
  });

  router.post(
    '/ai/toggle',
    action('ai', async (req, session) => {
      const feature = req.body.feature;
      if (!isToggle(feature) || !TOGGLE_KEYS.includes(feature)) throw new UserError('Unknown switch.');
      const on = req.body.on === '1';
      const message = await setToggle(ctx, feature, on);
      await audit(session, `AI switch: ${feature} ${on ? 'on' : 'off'}`);
      return message;
    }),
  );

  router.post(
    '/ai/model',
    action('ai', async (req, session) => {
      const name = typeof req.body.model === 'string' ? req.body.model : '';
      const message = await chooseModel(ctx, name);
      await audit(session, 'Chose the AI model', [{ name: 'Model', value: name || 'default' }]);
      return message.slice(0, 280);
    }),
  );

  router.post(
    '/ai/install',
    action('ai', async (req, session) => {
      const tag = typeof req.body.tag === 'string' ? req.body.tag : '';
      const message = await installModel(ctx, tag);
      await audit(session, 'Started an AI model download', [{ name: 'Model', value: tag.trim() }]);
      return message;
    }),
  );

  router.post(
    '/ai/test',
    action('ai', async (req) => {
      const prompt = typeof req.body.prompt === 'string' && req.body.prompt.trim() ? req.body.prompt.trim().slice(0, 300) : undefined;
      const r = await testModel(ctx, prompt);
      return `${r.model}: ${r.seconds}s${r.tokensPerSecond ? `, ${r.tokensPerSecond} tokens/s` : ''}${r.thinking ? ', thinking on' : ''} — ${(r.answer ?? '(empty)').replace(/\s+/g, ' ').slice(0, 160)}`;
    }),
  );
}
