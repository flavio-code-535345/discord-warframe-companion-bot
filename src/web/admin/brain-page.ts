import type { Request, RequestHandler, Response, Router } from 'express';
import { DEFAULT_PROMPT, LIMITS, OPERATOR_NOTE, PERSONA_BANDS, brain, buildSystemPrompt, personaBand, resetBrain, updateBrain } from '../../agent/brain.js';
import { runAgent } from '../../agent/run.js';
import { AGENT_TOOLS, TOOL_NAMES, enabledTools } from '../../agent/tools.js';
import { type AgentRun, getRun, newRun, recentRuns } from '../../agent/traces.js';
import { modelCapabilities, ollamaBase, localModelOf } from '../../ai/ollama.js';
import type { AppContext } from '../../context.js';
import type { PanelSession } from '../../db.js';
import { UserError } from '../../services/clan.js';
import { escapeHtml as e } from '../status.js';
import { type PageContext, csrfField, layout } from './pages.js';

/**
 * The panel's Brain page: the agent's system prompt, the Ordis-ness slider, the sampling and loop settings, which tools it
 * may use, a playground, and the step-by-step trace of its recent runs (every model call, the reasoning it exposed, each
 * tool call with its arguments and result). Server-rendered; a run in progress refreshes the page with a meta tag.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  action: (path: string, fn: (req: Request, session: PanelSession) => Promise<string>) => RequestHandler;
  audit: (session: PanelSession, what: string, fields?: { name: string; value: string }[]) => Promise<void>;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more)` : s);
const when = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const pretty = (v: unknown) => {
  try {
    return JSON.stringify(v, null, 1);
  } catch {
    return String(v);
  }
};

function runDetail(run: AgentRun): string {
  const steps = run.steps
    .map((st) => {
      const calls = st.calls
        .map(
          (c) =>
            `<details><summary>${c.error ? '⚠️' : '🔧'} <code>${e(c.name)}</code> ${e(clip(JSON.stringify(c.args), 90))} <span class="muted">${c.result ? secs(c.ms) : 'running…'}</span></summary><pre>${e(clip(pretty(c.args), 600))}</pre><pre>${e(clip(c.result, 2500))}</pre></details>`,
        )
        .join('');
      return `<div class="step"><div class="muted">Step ${st.n} · ${st.endpoint} · ${e(st.model)} · ${secs(st.ms)}</div>${
        st.reasoning ? `<details><summary>💭 reasoning (${st.reasoning.length} chars)</summary><pre>${e(clip(st.reasoning, 3000))}</pre></details>` : ''
      }${st.content && st.calls.length ? `<div class="muted">said: ${e(clip(st.content, 300))}</div>` : ''}${calls}</div>`;
    })
    .join('');
  const outcome =
    run.status === 'running'
      ? '<p class="muted">⏳ Still working… this page refreshes by itself.</p>'
      : run.status === 'failed'
        ? `<div class="flash err">Failed: ${e(run.error ?? 'no answer')}</div>`
        : `<div class="answer">${e(run.text ?? '')}</div><p class="muted">${e(run.via ?? '')} · ${e(run.model ?? '')} · ${run.mode === 'text' ? 'tool calls written as text' : 'native tool calls'} · ${secs(run.ms)}</p>`;
  return `<div class="card"><div class="muted">${e(when(run.at))} UTC · ${e(run.who)}${run.operator ? ' (operator)' : ''}</div><p><strong>${e(clip(run.question, 400))}</strong></p>${steps || '<p class="muted">No model call yet.</p>'}${outcome}<details><summary class="muted">System prompt this run used</summary><pre>${e(run.system)}</pre></details></div>`;
}

export function registerBrainRoutes({ router, ctx, pc, html, action, audit }: Deps): void {
  const { store, config } = ctx;

  router.get('/brain', async (req, res) => {
    const p = pc(res, 'brain', req);
    const s = brain();
    const runs = recentRuns();
    const wanted = typeof req.query.run === 'string' ? getRun(req.query.run) : undefined;
    const shown = wanted ?? runs[0];
    const working = runs.some((r) => r.status === 'running');

    const model = localModelOf(config);
    const caps = config.LOCAL_AI_URL && model ? await modelCapabilities(ollamaBase(config.LOCAL_AI_URL), model).catch(() => []) : [];
    const modelLine = config.LOCAL_AI_URL && model
      ? `${e(model)}: ${caps.length ? (caps.includes('tools') ? 'supports tool calling' : 'no native tool calling, tool calls are written as text') : 'capabilities unknown (server not reachable?)'}${caps.includes('thinking') ? ', can think' : ''}`
      : config.FREE_AI_KEY
        ? 'no local model, the free cloud model runs the agent'
        : '<strong>no model configured</strong>: the agent cannot run';

    const band = personaBand(s.ordisness);
    const number = (name: string, label: string, value: number, l: { min: number; max: number; step: number }, help: string) =>
      `<label>${e(label)}<input type="number" name="${name}" value="${value}" min="${l.min}" max="${l.max}" step="${l.step}"><span class="muted">${e(help)}</span></label>`;
    const choose = (name: string, value: string, opts: [string, string][]) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${v}"${v === value ? ' selected' : ''}>${e(l)}</option>`).join('')}</select>`;

    const toolBoxes = AGENT_TOOLS.map((t) => {
      const unavailable = t.available && !t.available(ctx);
      return `<label class="check"><input type="checkbox" name="tool_${t.name}" value="1"${s.disabledTools.includes(t.name) ? '' : ' checked'}> <span><code>${e(t.name)}</code>${unavailable ? ' <span class="muted">(unavailable here: ' + (t.name === 'search_web' ? 'SEARXNG_URL or the Web search switch' : 'not set up') + ')</span>' : ''}<br><span class="muted">${e(t.description.slice(0, 150))}</span></span></label>`;
    }).join('');

    const body = `<h1>Brain</h1>
<div class="card"><p class="muted flush">Who gets the agent: <strong>${e(s.agentFor)}</strong> · questions: <strong>${s.scope === 'all' ? 'all except help' : 'open-ended (wiki and builds)'}</strong> · ${modelLine} · tools on: ${enabledTools(ctx).length}/${TOOL_NAMES.length}</p></div>

<form class="stack" method="post" action="/admin/brain/save">${csrfField(p.session)}
<h2>Persona</h2>
<div class="card stack">
<label>Ordis-ness: <strong>${s.ordisness}/100 · ${e(band.name)}</strong>
<input type="range" name="ordisness" min="${LIMITS.ordisness.min}" max="${LIMITS.ordisness.max}" step="${LIMITS.ordisness.step}" value="${s.ordisness}" list="ticks">
<datalist id="ticks">${[0, 25, 50, 75, 100].map((v) => `<option value="${v}"></option>`).join('')}</datalist>
<span class="muted">${PERSONA_BANDS.map((b) => `${b.upTo === 0 ? '0' : b.upTo} ${b.name}`).join(' · ')}</span></label>
<p class="muted flush">Now: ${e(band.text)}</p>
</div>

<h2>System prompt</h2>
<div class="card stack">
<label>The instructions the model gets (empty or unchanged = the built-in default)
<textarea name="prompt" rows="22" class="mono">${e(s.prompt || DEFAULT_PROMPT)}</textarea></label>
<p class="muted flush">Placeholders: <code>{{bot}}</code> <code>{{clan}}</code> <code>{{date}}</code> <code>{{persona}}</code> (where the Ordis-ness text goes; added at the end when missing). The operators' extra paragraph and the tool list are added by the bot.</p>
</div>

<h2>Tuning</h2>
<div class="card stack">
<div class="row">
${number('temperature', 'Temperature', s.temperature, LIMITS.temperature, 'Lower = steadier and more literal, higher = looser.')}
${number('topP', 'Top P', s.topP, LIMITS.topP, 'Share of likely words considered.')}
${number('maxSteps', 'Max steps', s.maxSteps, LIMITS.maxSteps, 'Model calls per question; the last one must answer.')}
${number('maxTokens', 'Tokens per call', s.maxTokens, LIMITS.maxTokens, 'Upper bound for one model reply.')}
${number('maxChars', 'Answer limit (characters)', s.maxChars, LIMITS.maxChars, 'Discord allows 2000.')}
${number('toolResultChars', 'Tool result limit (characters)', s.toolResultChars, LIMITS.toolResultChars, 'More = better grounding, slower on a CPU.')}
</div>
<div class="row">
<label>Who gets the agent${choose('agentFor', s.agentFor, [['off', 'Nobody (old behaviour)'], ['operators', 'Operators only'], ['everyone', 'Everyone']])}</label>
<label>Which questions${choose('scope', s.scope, [['open', 'Open-ended only (wiki, builds)'], ['all', 'Everything except help']])}</label>
<label>Tool calling${choose('toolMode', s.toolMode, [['auto', 'Auto (native if the model supports it)'], ['native', 'Always native'], ['text', 'Always as text']])}</label>
</div>
<label class="check"><input type="checkbox" name="show_tools" value="1"${s.showTools ? ' checked' : ''}> Show which tools were used under each answer</label>
</div>

<h2>Tools it may use</h2>
<div class="card stack">${toolBoxes}</div>
<div><button>Save the brain</button></div>
</form>

<form class="inline" method="post" action="/admin/brain/reset">${csrfField(p.session)}<label class="check"><input type="checkbox" name="confirm" value="yes" required> sure</label> <button class="ghost">Reset everything to the defaults</button></form>

<h2>Prompt as the model sees it</h2>
<div class="card"><details><summary class="muted">Show the assembled system prompt (for a member)</summary><pre>${e(buildSystemPrompt({ bot: config.BOT_NAME, clan: config.CLAN_NAME }))}</pre></details>
<details><summary class="muted">Extra paragraph for the operators</summary><pre>${e(OPERATOR_NOTE)}</pre></details></div>

<h2>Playground</h2>
<div class="card"><form class="stack" method="post" action="/admin/brain/test">${csrfField(p.session)}
<label>Ask the agent a question (uses the settings above, saved ones)<textarea name="question" rows="3" maxlength="600" required placeholder="What is the best way to farm Kuva, and did anything change recently?"></textarea></label>
<label class="check"><input type="checkbox" name="operator" value="1"> Answer as an operator (open-ended instructions allowed)</label>
<div><button>Run</button></div></form></div>

<h2>Runs</h2>
${shown ? runDetail(shown) : '<p class="muted">No runs since the bot started. Ask a question in the playground, or in Discord once the agent is on.</p>'}
${runs.length ? `<div class="card"><table><tr><th>When</th><th>Who</th><th>Question</th><th>Result</th></tr>${runs
      .map((r) => `<tr><td><a href="/admin/brain?run=${e(r.id)}">${e(when(r.at))}</a></td><td>${e(r.who)}</td><td>${e(clip(r.question, 70))}</td><td>${r.status === 'running' ? '⏳' : r.status === 'failed' ? '❌' : '✅'} ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}, ${r.steps.reduce((n, st) => n + st.calls.length, 0)} tool call${r.steps.reduce((n, st) => n + st.calls.length, 0) === 1 ? '' : 's'}${r.ms ? `, ${secs(r.ms)}` : ''}</td></tr>`)
      .join('')}</table><p class="muted">Kept in memory (last ${recentRuns().length}); cleared when the bot restarts.</p></div>` : ''}`;

    const page = layout('Brain', body, p);
    html(res, working && shown?.status === 'running' ? page.replace('</head>', '<meta http-equiv="refresh" content="4"></head>') : page);
  });

  router.post(
    '/brain/save',
    action('brain', async (req, session) => {
      const b = req.body as Record<string, unknown>;
      const prompt = typeof b.prompt === 'string' ? b.prompt.replace(/\r\n/g, '\n').trim() : undefined;
      const saved = updateBrain(store, {
        prompt: prompt === undefined ? undefined : prompt === DEFAULT_PROMPT.trim() ? '' : prompt,
        ordisness: b.ordisness,
        temperature: b.temperature,
        topP: b.topP,
        maxSteps: b.maxSteps,
        maxTokens: b.maxTokens,
        maxChars: b.maxChars,
        toolResultChars: b.toolResultChars,
        agentFor: b.agentFor,
        scope: b.scope,
        toolMode: b.toolMode,
        showTools: b.show_tools === '1',
        disabledTools: TOOL_NAMES.filter((n) => b[`tool_${n}`] !== '1'),
      });
      await audit(session, 'Changed the agent brain', [
        { name: 'Ordis-ness', value: String(saved.ordisness) },
        { name: 'Agent for', value: saved.agentFor },
        { name: 'Custom prompt', value: saved.prompt ? 'yes' : 'default' },
      ]);
      return 'Saved. The next question uses the new brain.';
    }),
  );

  router.post(
    '/brain/reset',
    action('brain', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to reset.');
      resetBrain(store);
      await audit(session, 'Reset the agent brain to the defaults');
      return 'The brain is back to its defaults.';
    }),
  );

  router.post(
    '/brain/test',
    action('brain', async (req, session) => {
      const question = typeof req.body.question === 'string' ? req.body.question.trim().slice(0, 600) : '';
      if (!question) throw new UserError('Type a question first.');
      if (recentRuns().some((r) => r.status === 'running')) throw new UserError('A run is still in progress. Wait for it to finish.');
      const operator = req.body.operator === '1';
      const who = { id: session.userId, name: session.username, operator };
      const run = newRun({ who: who.name, operator, question, system: '' });
      void runAgent(ctx, question, who, { run }).catch((err) => {
        run.status = 'failed';
        run.error = err instanceof Error ? err.message : String(err);
      });
      return 'Started. The result appears below as it works.';
    }),
  );
}
