import type { Request, RequestHandler, Response, Router } from 'express';
import express from 'express';
import type { AppContext } from '../../context.js';
import type { PanelSession } from '../../db.js';
import { scanSummary } from '../../discord/riven-embeds.js';
import { QueueFullError, screenshotQueue } from '../../queue.js';
import { disableRivenChannel, recordResult, scanLog, scanTotals, setupRivenChannel } from '../../rivens/channel.js';
import { scanCard } from '../../rivens/scan.js';
import { rivenStatus } from '../../rivens/service.js';
import { UserError } from '../../services/clan.js';
import { escapeHtml as e } from '../status.js';
import { type Option, type PageContext, actionButton, csrfField, layout, select } from './pages.js';

/**
 * The panel's Rivens page: where riven scanning happens (the channel), how it is doing (scans since the last start, the slow market
 * read), a test area to scan a screenshot without Discord, and the latest scans. Pictures are only held in memory while they are read.
 */

interface Deps {
  router: Router;
  ctx: AppContext;
  pc: (res: Response, active?: string, req?: Request) => PageContext;
  html: (res: Response, body: string, status?: number) => unknown;
  action: (path: string, fn: (req: Request, session: PanelSession) => Promise<string>) => RequestHandler;
  audit: (session: PanelSession, what: string, fields?: { name: string; value: string }[]) => Promise<void>;
  channelOptions: () => Promise<Option[]>;
}

const MAX_BYTES = 8 * 1024 * 1024;
const SCAN_LIMIT_MS = 90_000;
const clock = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
const ago = (at: number | null) => {
  if (at === null) return 'never';
  const m = Math.max(1, Math.round((Date.now() - at) / 60_000));
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** The page's script: posts the chosen picture as the raw body (CSRF in a header) and draws the answer with textContent only. */
const RIVEN_JS = String.raw`(() => {
  const form = document.getElementById('rvform');
  const file = document.getElementById('rvfile');
  const box = document.getElementById('rvout');
  const csrf = document.getElementById('rvcsrf').value;
  const btn = document.getElementById('rvgo');
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = file.files && file.files[0];
    if (!f) { alert('Choose a screenshot first.'); return; }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { alert('The screenshot must be a PNG, JPG or WebP.'); return; }
    if (f.size > 8 * 1024 * 1024) { alert('That file is over 8 MB.'); return; }
    btn.disabled = true;
    const t0 = Date.now();
    box.replaceChildren(el('div', 'muted', '⏳ Reading…'));
    const tick = setInterval(() => (box.firstChild.textContent = '⏳ Reading… ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s'), 1000);
    try {
      const res = await fetch('/admin/rivens/scan', { method: 'POST', headers: { 'Content-Type': f.type, 'X-CSRF-Token': csrf }, body: f });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'HTTP ' + res.status);
      box.replaceChildren();
      box.append(el('div', 'stat', (r.weapon || 'Unknown weapon') + (r.letter ? ' · ' + r.letter : '')));
      if (r.error) box.append(el('div', '', '❌ ' + r.error));
      else {
        box.append(el('div', '', r.stats || '—'));
        box.append(el('div', '', r.letter ? (r.price ? '💰 ' + r.price : 'No price data') : 'Not enough listings to grade.'));
      }
      box.append(el('div', 'muted', 'Read in ' + (r.ms / 1000).toFixed(1) + ' s · ' + r.lineCount + ' text lines'));
      if (r.lines && r.lines.length) {
        const d = el('details');
        d.append(el('summary', '', 'Stat lines as read'), el('pre', '', r.lines.join('\n')));
        box.append(d);
      }
    } catch (err) {
      box.replaceChildren(el('div', '', '⚠️ ' + (err && err.message ? err.message : err)));
    } finally {
      clearInterval(tick);
      btn.disabled = false;
    }
  });
})();`;

export function registerRivenRoutes({ router, ctx, pc, html, action, audit, channelOptions }: Deps): void {
  const { config, store } = ctx;
  const guildId = config.DISCORD_GUILD_ID;
  const id = (v: unknown) => (typeof v === 'string' && /^\d{15,22}$/.test(v) ? v : null);

  router.get('/rivens', async (req, res) => {
    const p = pc(res, 'rivens', req);
    const [channels, status] = await Promise.all([channelOptions(), rivenStatus(ctx)]);
    const current = store.getSettings(guildId).rivenChannelId;
    const totals = scanTotals();
    const recent = scanLog();
    const rows = recent
      .slice(0, 25)
      .map(
        (s) =>
          `<tr><td>${clock(s.at)}</td><td>${e(s.via)}</td><td>${e(s.userName)}</td><td>${e(s.weapon ?? '—')}</td><td>${s.letter ? `<strong>${e(s.letter)}</strong>` : '❌'}${s.note ? ` <span class="muted">${e(s.note.slice(0, 80))}</span>` : ''}</td><td>${(s.ms / 1000).toFixed(1)} s</td></tr>`,
      )
      .join('');
    const body = `<h1>Rivens</h1>
<div class="grid">
<div class="card"><div class="stat small">${current ? e(channels.find((c) => c.value === current)?.label ?? current) : 'off'}</div><div class="muted">Scan channel${current && !config.ENABLE_MESSAGE_CONTENT ? ' · ⚠️ needs ENABLE_MESSAGE_CONTENT=true to see pictures' : ''}</div></div>
<div class="card"><div class="stat">${totals.scans}</div><div class="muted">Scans since start · ${totals.graded} graded · ${totals.failed} failed</div></div>
<div class="card"><div class="stat">${status.weaponsRead}${status.weaponsKnown ? ` / ${status.weaponsKnown}` : ''}</div><div class="muted">Weapons read from the market · ${status.listings.toLocaleString('en-US')} listings</div></div>
<div class="card"><div class="stat small">${status.enabled ? (status.pausedMs > 0 ? `paused ${Math.ceil(status.pausedMs / 60_000)} min` : `1 weapon / ${status.intervalSeconds} s`) : 'off'}</div><div class="muted">Slow market read · last ${ago(status.lastReadAt)}</div></div>
</div>
<h2>Scan channel</h2>
<div class="card"><form class="stack" method="post" action="/admin/rivens/channel">${csrfField(p.session)}
<p class="muted">Members post a screenshot of an unveiled riven in this channel and Ordis answers with a short grade. Pictures are never saved and messages are not deleted. Needs the Message Content intent to see attachments.</p>
<div class="row"><label>Channel${select('channel', channels, current, '— pick a channel —')}</label></div>
<div><button>${current ? 'Move scanning here' : 'Turn on scanning'}</button></div></form>
${current ? `<p>${actionButton(p.session, '/admin/rivens/off', 'Turn scanning off', { danger: true, confirm: true })}</p>` : ''}</div>
<h2>Try a screenshot</h2>
<div class="card"><form class="stack" id="rvform"><input type="hidden" id="rvcsrf" value="${e(p.session?.csrf ?? '')}">
<label>Riven card (PNG, JPG or WebP, up to 8 MB)<input type="file" id="rvfile" accept="image/png,image/jpeg,image/webp"></label>
<div><button id="rvgo" type="submit">Scan</button></div></form>
<div id="rvout" class="stack" style="margin-top:12px"></div></div>
<h2>Latest scans</h2>
<div class="card">${recent.length ? `<table><tr><th>When (UTC)</th><th>From</th><th>Member</th><th>Weapon</th><th>Grade</th><th>Time</th></tr>${rows}</table>` : '<p class="muted">Nothing scanned since the bot started.</p>'}</div>
${status.failing.length ? `<h2>Market read problems</h2><div class="card"><table>${status.failing.map((f) => `<tr><td>${e(f.weapon)}</td><td class="muted">${e(f.error.slice(0, 160))}</td></tr>`).join('')}</table></div>` : ''}
<p class="muted">Crawl pace, refresh age and the high-value line are on the <a href="/admin/config">Config</a> page (Riven analyzer).</p>
<script nonce="${p.nonce}">${RIVEN_JS}</script>`;
    html(res, layout('Rivens', body, p));
  });

  router.post(
    '/rivens/channel',
    action('rivens', async (req, session) => {
      const channel = id(req.body.channel);
      if (!channel) throw new UserError('Pick a channel for riven scanning.');
      await setupRivenChannel(ctx, channel);
      await audit(session, 'Set up riven scanning', [{ name: 'Channel', value: `<#${channel}>` }]);
      return 'Riven scanning is on.';
    }),
  );

  router.post(
    '/rivens/off',
    action('rivens', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      disableRivenChannel(ctx);
      await audit(session, 'Turned riven scanning off');
      return 'Riven scanning is off.';
    }),
  );

  router.post('/rivens/scan', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).json({ error: 'Send a PNG, JPG or WebP image as the request body.' });
    const mime = (req.get('content-type') ?? '').split(';')[0]!.trim();
    const session = res.locals.session as PanelSession;
    let ticket: ReturnType<typeof screenshotQueue.join>;
    try {
      ticket = screenshotQueue.join(`panel:${session.userId}`, () => {});
    } catch (err) {
      if (err instanceof QueueFullError) return void res.status(429).json({ error: 'The screenshot queue is full. Try again in a minute.' });
      throw err;
    }
    try {
      await ticket.ready;
      const result = await Promise.race([
        scanCard(ctx, new Uint8Array(req.body), mime),
        new Promise<never>((_, reject) => setTimeout(() => reject(new UserError('That took too long, so I gave up.')), SCAN_LIMIT_MS).unref()),
      ]);
      recordResult('panel', session.username, result);
      res.json({ ...scanSummary(result), ms: result.ms, lineCount: result.lines, lines: result.reading.statLines });
    } catch (err) {
      if (!(err instanceof UserError)) console.error('[admin] riven scan failed:', err);
      res.status(err instanceof UserError ? 422 : 500).json({ error: err instanceof UserError ? err.message : 'Something went wrong; check the bot logs.' });
    } finally {
      ticket.release();
    }
  });
}
