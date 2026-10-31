import type { Request, RequestHandler, Response, Router } from 'express';
import type { AppContext } from '../../context.js';
import type { PanelSession } from '../../db.js';
import { ENV_ONLY, SETTINGS, type SettingDef, type SettingState, adoptEnvironment, parseSetting, resetSetting, setSetting, settingStates, show } from '../../runtime-config.js';
import { UserError } from '../../services/clan.js';
import { scheduleRestart } from '../../selfupdate.js';
import { api } from '../../warframe/fetch.js';
import { screenshotQueue } from '../../queue.js';
import { formatDuration } from '../../time.js';
import { escapeHtml as e } from '../status.js';
import { type PageContext, badge, csrfField, head, layout } from './pages.js';

/**
 * The panel's Config page: the settings that used to be environment variables, editable without a redeploy (see
 * runtime-config.ts). One form per group; values you change are saved as panel values, which win over the environment.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  action: (path: string, fn: (req: Request, session: PanelSession) => Promise<string>) => RequestHandler;
  audit: (session: PanelSession, what: string, fields?: { name: string; value: string }[]) => Promise<void>;
}

const SOURCE: Record<SettingState['source'], string> = { panel: badge('set here', 'ok'), environment: badge('from the environment', 'warn'), default: badge('built-in default') };

function field(st: SettingState): string {
  const d = st.def;
  const name = `s_${d.key}`;
  if (d.kind === 'bool') return `<select name="${name}"><option value="true"${st.value === 'true' ? ' selected' : ''}>on</option><option value="false"${st.value === 'true' ? '' : ' selected'}>off</option></select>`;
  if (d.kind === 'select') return `<select name="${name}">${(d.options ?? []).map((o) => `<option value="${e(o)}"${o === st.value ? ' selected' : ''}>${e(o)}</option>`).join('')}</select>`;
  if (d.kind === 'int') return `<input type="number" name="${name}" value="${e(st.value)}" step="1">`;
  return `<input type="text" name="${name}" value="${e(st.value)}" maxlength="400" autocomplete="off" spellcheck="false">`;
}

export function registerConfigRoutes({ router, ctx, pc, html, action, audit }: Deps): void {
  const { config, store } = ctx;
  const states = () => new Map(settingStates(config, store).map((s) => [s.def.key, s]));
  const isOwner = (session: PanelSession) => config.PANEL_OWNER_IDS.includes(session.userId);

  router.get('/config', (req, res) => {
    const p = pc(res, 'config', req);
    const all = settingStates(config, store);
    const groups = [...new Set(SETTINGS.map((s) => s.group))];
    const retire = all.filter((s) => s.source === 'panel' && process.env[s.def.key]).map((s) => s.def.key);
    const pending = all.filter((s) => s.pendingRestart);
    const owner = p.session ? config.PANEL_OWNER_IDS.includes(p.session.userId) : false;

    const intro = `<div class="card stack"><p class="muted flush">Values set here win over environment variables and apply right away (the ones marked "restart" after the next restart). Clear a value or tick <em>reset</em> to go back to the environment or the built-in default. Secrets and anything the panel's own login needs stay environment-only (listed at the bottom).</p>
<form class="inline" method="post" action="/admin/config/adopt">${csrfField(p.session)}<button class="ghost">Copy the current environment values into the panel</button> <span class="muted">so those variables can be removed from your stack</span></form>
${retire.length ? `<p class="flush">✅ Already safe to remove from your stack: <code>${retire.map(e).join('</code> <code>')}</code></p>` : ''}</div>
${pending.length ? `<div class="flash err">Needs a restart to take effect: ${pending.map((s) => e(s.def.label)).join(', ')}.<form class="inline" method="post" action="/admin/config/restart">${csrfField(p.session)}<label class="check"><input type="checkbox" name="confirm" value="yes" required> sure</label> <button class="ghost">Restart the bot now</button></form></div>` : ''}`;

    const forms = groups
      .map((g) => {
        const rows = all
          .filter((s) => s.def.group === g)
          .map((s) => {
            const locked = s.def.ownerOnly && !owner;
            return `<div class="card"><div class="row"><div><strong>${e(s.def.label)}</strong>${s.def.restart ? ' <span class="muted">(restart)</span>' : ''}<div class="muted">${e(s.def.help)}</div><div class="muted"><code>${e(s.def.key)}</code> ${SOURCE[s.source]}${s.source === 'panel' ? ` otherwise: ${e(s.fallback || 'off / empty')}` : ''}${locked ? ` ${badge('panel owners only', 'warn')}` : ''}</div></div><div>${locked ? `<code>${e(s.value || '—')}</code>` : field(s)}${locked || s.source !== 'panel' ? '' : `<label class="check"><input type="checkbox" name="reset_${e(s.def.key)}" value="1"> reset</label>`}</div></div></div>`;
          })
          .join('');
        return `<h2>${e(g)}</h2><form class="stack" method="post" action="/admin/config/save">${csrfField(p.session)}<input type="hidden" name="group" value="${e(g)}">${rows}<div><button>Save ${e(g)}</button></div></form>`;
      })
      .join('');

    const st = api.stats;
    const size = store.apiCacheSize();
    const holds = api.cooldowns();
    const activity = `<h2>API activity</h2><div class="card stack"><p class="flush muted">Since the last restart. Cached responses are kept in the bot's database (${size.entries} entries, ${Math.round(size.bytes / 1024)} KB) so they survive restarts.</p>
<p class="flush">Requests sent <strong>${st.requests}</strong> · cache hits <strong>${st.cacheHits}</strong> · shared with an identical in-flight request <strong>${st.deduped}</strong> · revalidated (304) <strong>${st.revalidated}</strong> · stale answers served <strong>${st.staleServed}</strong> · retries <strong>${st.retries}</strong> · failures <strong>${st.failures}</strong> · 429s <strong>${st.rateLimited}</strong> · refused during a pause <strong>${st.blocked}</strong></p>
${holds.length ? holds.map((h) => `<p class="flush">⏸ <code>${e(h.host)}</code> paused for ${e(formatDuration(h.until - Date.now()))}: ${e(h.reason)}</p>`).join('') : '<p class="flush">No host is paused.</p>'}</div>`;
    const line = (name: string, q: typeof screenshotQueue) => `<p class="flush"><strong>${name}</strong>: ${q.snapshot().running} running (up to ${q.config.concurrency}), ${q.snapshot().waiting} waiting · ${q.stats.served} served, ${q.stats.waitedOnce} had to wait, ${q.stats.refused} turned away since the last restart</p>`;
    const queues = `<h2>Queues</h2><div class="card stack">${line('Screenshots', screenshotQueue)}</div>`;
    const envOnly = `<h2>Still environment-only</h2><div class="card">${ENV_ONLY.map((o) => `<p class="flush"><code>${o.names.map(e).join('</code> <code>')}</code><br><span class="muted">${e(o.why)}</span></p>`).join('<hr>')}</div>`;
    html(res, layout('Config', `${head('Config', 'Settings that used to be environment variables, editable without a redeploy.')}${intro}${forms}${queues}${activity}${envOnly}`, p));
  });

  router.post(
    '/config/save',
    action('config', async (req, session) => {
      const group = typeof req.body.group === 'string' ? req.body.group : '';
      const defs: SettingDef[] = SETTINGS.filter((s) => s.group === group);
      if (!defs.length) throw new UserError('Unknown group.');
      const current = states();
      const changes: { def: SettingDef; raw: string | null }[] = [];
      for (const def of defs) {
        const cur = current.get(def.key)!;
        if (req.body[`reset_${def.key}`] === '1') {
          if (cur.source === 'panel') changes.push({ def, raw: null });
          continue;
        }
        const sent = req.body[`s_${def.key}`];
        if (typeof sent !== 'string') continue;
        const raw = sent.trim();
        if (raw === cur.value) continue;
        // Booleans and selects come back as what the bot shows; anything else is checked like an environment value.
        if (raw !== '') {
          const r = parseSetting(def.key, raw);
          if (!r.ok) throw new UserError(r.error);
          if (show(r.value) === cur.value) continue;
        }
        changes.push({ def, raw });
      }
      if (!changes.length) return 'Nothing changed.';
      if (changes.some((c) => c.def.ownerOnly) && !isOwner(session)) throw new UserError('Only panel owners can change that setting.');
      for (const c of changes) {
        if (c.raw === null) resetSetting(config, store, c.def.key);
        else {
          const err = setSetting(config, store, c.def.key, c.raw);
          if (err) throw new UserError(err);
        }
      }
      await audit(
        session,
        'Changed bot settings',
        changes.map((c) => ({ name: c.def.key, value: c.raw === null ? 'reset' : `${current.get(c.def.key)!.value || 'off'} → ${c.raw || 'off'}`.slice(0, 200) })),
      );
      const restart = changes.filter((c) => c.def.restart).map((c) => c.def.label);
      return `Saved ${changes.length} setting${changes.length === 1 ? '' : 's'}.${restart.length ? ` ${restart.join(', ')}: applies after a restart.` : ' Applied.'}`;
    }),
  );

  router.post(
    '/config/adopt',
    action('config', async (_req, session) => {
      const adopted = adoptEnvironment(config, store);
      await audit(session, 'Copied the environment values into the panel', [{ name: 'Settings', value: adopted.join(', ').slice(0, 900) || 'none' }]);
      return adopted.length ? `Saved ${adopted.length} value${adopted.length === 1 ? '' : 's'} from the environment: ${adopted.join(', ')}. You can remove those variables from your stack now.` : 'Nothing to copy: no covered setting comes from the environment.';
    }),
  );

  router.post(
    '/config/restart',
    action('config', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to restart.');
      await audit(session, 'Restarted the bot from the panel');
      scheduleRestart();
      return 'Restarting. The bot is back in a few seconds; reload this page then.';
    }),
  );
}
