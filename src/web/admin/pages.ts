import type { PanelSession } from '../../db.js';
import { escapeHtml as e } from '../status.js';
import { ADMIN_CSS } from '../theme.js';
import { avatarUrl } from './auth.js';

/** Server-rendered admin pages: plain HTML forms, no client script of their own, styles allowed by a per-request nonce. */
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

/** The sidebar: page key, label, and the group it sits under (the first group has no heading). */
const NAV: { group: string | null; items: [string, string][] }[] = [
  { group: null, items: [['overview', 'Overview']] },
  { group: 'Server', items: [['settings', 'Settings'], ['announce', 'Announce'], ['messages', 'Messages'], ['events', 'Events'], ['members', 'Members'], ['backups', 'Backups']] },
  { group: 'Ordis AI', items: [['ai', 'AI'], ['brain', 'Brain'], ['corrections', 'Corrections'], ['sstest', 'Screenshots'], ['rivens', 'Rivens']] },
  { group: 'System', items: [['config', 'Config'], ['admins', 'Admins']] },
];

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

/** The title every page starts with, plus one line saying what the page is for. */
export function head(title: string, lede?: string): string {
  return `<h1>${e(title)}</h1>${lede ? `<p class="lede">${e(lede)}</p>` : ''}`;
}

/** A number (or short state) with its label above it. `value` and `note` are HTML: escape what comes from outside. */
export function statCard(label: string, value: string, note = '', opts: { small?: boolean; tone?: 'ok' | 'bad' } = {}): string {
  return `<div class="card statcard"><div class="statlabel">${e(label)}</div><div class="stat${opts.small ? ' small' : ''}${opts.tone ? ` ${opts.tone}` : ''}">${value}</div>${note ? `<div class="statnote">${note}</div>` : ''}</div>`;
}

/** A small coloured label for a state ("auto", "owner", "on"). */
export function badge(text: string, tone: 'ok' | 'warn' | 'bad' | 'info' | '' = ''): string {
  return `<span class="badge${tone ? ` ${tone}` : ''}">${e(text)}</span>`;
}

export function layout(title: string, body: string, pc: PageContext): string {
  const s = pc.session;
  const flash = [pc.flash?.ok ? `<div class="flash ok">${e(pc.flash.ok)}</div>` : '', pc.flash?.err ? `<div class="flash err">${e(pc.flash.err)}</div>` : ''].join('');
  const nav = NAV.map(
    ({ group, items }) =>
      `${group ? `<div class="navgroup">${e(group)}</div>` : ''}${items
        .map(([key, label]) => `<a class="navlink${pc.active === key ? ' on' : ''}" href="/admin/${key === 'overview' ? '' : key}">${e(label)}</a>`)
        .join('')}`,
  ).join('');
  const page = s
    ? `<div class="shell">
<aside class="side">
<a class="brandbar" href="/admin/"><img src="/logo.png" alt=""><div><b>Cephalon Ordis</b><span>Admin panel</span></div></a>
<nav>${nav}<div class="navgroup">Public</div><a class="navlink" href="/">Status page</a></nav>
</aside>
<div class="content">
<div class="topbar"><div class="user"><img src="${e(avatarUrl(s.userId, s.avatar))}" alt="">${e(s.username)}<form class="inline" method="post" action="/admin/logout">${csrfField(s)}<button class="ghost">Log out</button></form></div></div>
<main>${flash}${body}</main>
</div>
</div>`
    : `<main class="solo">${flash}${body}</main>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#07121d">
<title>${e(title)} · Ordis admin</title>
<link rel="icon" href="/logo.png">
<style nonce="${pc.nonce}">${ADMIN_CSS}</style>
</head>
<body>
${page}
</body>
</html>`;
}

export function loginPage(pc: PageContext, clanName: string): string {
  return layout(
    'Sign in',
    `<img src="/logo.png" alt=""><h1>Ordis admin panel</h1><p class="muted">For ${e(clanName)} administrators. Sign in with your Discord account; only whitelisted admins get in.</p><p><a class="discord" href="/admin/login">Log in with Discord</a></p>`,
    pc,
  );
}

export function deniedPage(pc: PageContext, userId: string): string {
  return layout(
    'Not allowed',
    `<img src="/logo.png" alt=""><h1>Access denied</h1><p class="muted">Your Discord account (<code>${e(userId)}</code>) isn't on the admin whitelist. Ask a clan admin to add it under Admins.</p><p><a href="/">Back to the status page</a></p>`,
    pc,
  );
}

/** Names the missing settings (never their values) so a misconfigured stack is easy to spot. */
export function notConfiguredPage(pc: PageContext, missing: string[]): string {
  return layout(
    'Not configured',
    `<img src="/logo.png" alt=""><h1>Admin panel is off</h1><p class="muted">The bot's environment is missing ${missing.map((m) => `<code>${e(m)}</code>`).join(' and ')}. Add ${missing.length > 1 ? 'them' : 'it'} to the bot's <code>environment:</code> block in the stack and redeploy, and add <code>PUBLIC_URL/admin/callback</code> as a redirect in the Discord Developer Portal.</p>`,
    pc,
  );
}
