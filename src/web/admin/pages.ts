import type { PanelSession } from '../../db.js';
import { escapeHtml as e } from '../status.js';
import { avatarUrl } from './auth.js';

/** Server-rendered admin pages: plain HTML forms, no client script, styles allowed by a per-request nonce. */
export interface PageContext {
  nonce: string;
  session: PanelSession | null;
  active?: string;
  flash?: { ok?: string; err?: string };
}

export interface Option {
  value: string;
  label: string;
}

const NAV: [string, string][] = [
  ['overview', 'Overview'],
  ['settings', 'Settings'],
  ['ai', 'AI'],
  ['brain', 'Brain'],
  ['announce', 'Announce'],
  ['events', 'Events'],
  ['members', 'Members'],
  ['backups', 'Backups'],
  ['admins', 'Admins'],
];

const STYLE = `
:root{--bg:#010c18;--bg2:#0b2846;--card:rgba(255,255,255,.045);--border:rgba(59,154,199,.28);--accent:#3b9ac7;--text:#e6eef6;--muted:#8fa7bd;--ok:#22c55e;--bad:#ef4444;--input:#06182b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(ellipse at top,var(--bg2),var(--bg) 70%) fixed;color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
.top{display:flex;align-items:center;gap:14px;padding:14px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.top img.logo{width:36px;height:36px;border-radius:9px}
.brand{font-weight:700;margin-right:auto}
.nav{display:flex;gap:4px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border)}
.nav a{padding:6px 12px;border-radius:8px;color:var(--muted);text-decoration:none}
.nav a.on{background:var(--card);color:var(--text);border:1px solid var(--border)}
.user{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px}
.user img{width:28px;height:28px;border-radius:50%}
main{max-width:980px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 16px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin:28px 0 10px;font-weight:600}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
.stat{font-size:24px;font-weight:700;overflow-wrap:anywhere}
.stat.small{font-size:14px;line-height:1.35;font-weight:600}
.grid .card{min-width:0}
.flush{margin:0}
textarea.mono{font-family:ui-monospace,Consolas,monospace;font-size:13px;min-height:360px}
.muted{color:var(--muted);font-size:13px}
.flash{padding:10px 14px;border-radius:10px;margin-bottom:16px;border:1px solid}
.flash.ok{border-color:var(--ok);background:rgba(34,197,94,.08)}
.flash.err{border-color:var(--bad);background:rgba(239,68,68,.08)}
form.stack{display:grid;gap:12px}
label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
input,select,textarea{width:100%;background:var(--input);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit}
textarea{min-height:140px;resize:vertical}
.row{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
button{background:var(--accent);color:#011220;border:0;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
button.danger{background:var(--bad);color:#fff}
.inline{display:inline}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.thumb{object-fit:cover;border-radius:6px}
.check{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.check input{width:auto}
input[type=range]{padding:0;accent-color:var(--accent)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--input);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px;margin:6px 0;max-height:360px;overflow:auto}
details{margin:4px 0}
summary{cursor:pointer}
.step{border-left:2px solid var(--border);padding-left:10px;margin:10px 0}
.answer{white-space:pre-wrap;background:rgba(59,154,199,.08);border:1px solid var(--border);border-radius:10px;padding:12px}
.center{max-width:420px;margin:12vh auto;text-align:center}
.center img{width:96px;height:96px;border-radius:22px;box-shadow:0 0 40px rgba(59,154,199,.45)}
.discord{background:#5865f2;color:#fff;display:inline-block;padding:11px 22px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:16px}
@media (max-width:600px){table{font-size:13px}th,td{padding:6px 4px}}
`;

export function csrfField(session: PanelSession | null): string {
  return session ? `<input type="hidden" name="_csrf" value="${e(session.csrf)}">` : '';
}

export function select(name: string, options: Option[], selected: string | null, placeholder = '— off —'): string {
  const opts = [`<option value="">${e(placeholder)}</option>`, ...options.map((o) => `<option value="${e(o.value)}"${o.value === selected ? ' selected' : ''}>${e(o.label)}</option>`)];
  return `<select name="${e(name)}">${opts.join('')}</select>`;
}

/** A POST button with CSRF token; destructive ones require ticking a checkbox (there's no script to confirm). */
export function actionButton(session: PanelSession | null, action: string, label: string, opts: { danger?: boolean; confirm?: boolean } = {}): string {
  return `<form class="inline" method="post" action="${e(action)}">${csrfField(session)}${
    opts.confirm ? '<label class="check"><input type="checkbox" name="confirm" value="yes" required> sure</label>' : ''
  }<button class="${opts.danger ? 'danger' : 'ghost'}">${e(label)}</button></form>`;
}

export function layout(title: string, body: string, pc: PageContext): string {
  const s = pc.session;
  const nav = s
    ? `<nav class="nav">${NAV.map(([key, label]) => `<a href="/admin/${key === 'overview' ? '' : key}" class="${pc.active === key ? 'on' : ''}">${label}</a>`).join('')}</nav>`
    : '';
  const user = s
    ? `<div class="user"><img src="${e(avatarUrl(s.userId, s.avatar))}" alt="">${e(s.username)}<form class="inline" method="post" action="/admin/logout">${csrfField(s)}<button class="ghost">Log out</button></form></div>`
    : '';
  const flash = [pc.flash?.ok ? `<div class="flash ok">${e(pc.flash.ok)}</div>` : '', pc.flash?.err ? `<div class="flash err">${e(pc.flash.err)}</div>` : ''].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(title)} · Ordis admin</title>
<link rel="icon" href="/logo.png">
<style nonce="${pc.nonce}">${STYLE}</style>
</head>
<body>
<header class="top"><img class="logo" src="/logo.png" alt=""><span class="brand">Cephalon Ordis · Admin</span>${user}</header>
${nav}
<main>${flash}${body}</main>
</body>
</html>`;
}

export function loginPage(pc: PageContext, clanName: string): string {
  return layout(
    'Sign in',
    `<div class="center"><img src="/logo.png" alt=""><h1>Ordis admin panel</h1><p class="muted">For ${e(clanName)} administrators. Sign in with your Discord account; only whitelisted admins get in.</p><a class="discord" href="/admin/login">Log in with Discord</a></div>`,
    pc,
  );
}

export function deniedPage(pc: PageContext, userId: string): string {
  return layout(
    'Not allowed',
    `<div class="center"><img src="/logo.png" alt=""><h1>Access denied</h1><p class="muted">Your Discord account (<code>${e(userId)}</code>) isn't on the admin whitelist. Ask a clan admin to add it under Admins.</p><p><a href="/">Back to the status page</a></p></div>`,
    pc,
  );
}

/** Names the missing settings (never their values) so a misconfigured stack is easy to spot. */
export function notConfiguredPage(pc: PageContext, missing: string[]): string {
  return layout(
    'Not configured',
    `<div class="center"><img src="/logo.png" alt=""><h1>Admin panel is off</h1><p class="muted">The bot's environment is missing ${missing.map((m) => `<code>${e(m)}</code>`).join(' and ')}. Add ${missing.length > 1 ? 'them' : 'it'} to the bot's <code>environment:</code> block in the stack and redeploy, and add <code>PUBLIC_URL/admin/callback</code> as a redirect in the Discord Developer Portal.</p></div>`,
    pc,
  );
}
