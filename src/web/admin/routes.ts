import { randomBytes } from 'node:crypto';
import { ChannelType, type Guild } from 'discord.js';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { summaryOf, takeBackup } from '../../backup/service.js';
import type { AppContext } from '../../context.js';
import type { GuildSettings, PanelSession } from '../../db.js';
import { disableVerification, setupVerification } from '../../discord/verification.js';
import { validImageUrl } from '../../lfg/lifecycle.js';
import { HONEYPOT_ACTIONS, disableHoneypot, honeypotAction, setupHoneypot } from '../../moderation/honeypot.js';
import { modLog } from '../../moderation/service.js';
import { UserError, assertChannelFree, cancelClanEvent, createClanEvent, postAnnouncement } from '../../services/clan.js';
import { parseWhen } from '../../time.js';
import { buildStatus, escapeHtml as e } from '../status.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STATE_COOKIE,
  authorizeUrl,
  clearCookie,
  cookie,
  exchangeCode,
  isPanelAdmin,
  parseCookies,
  randomToken,
  safeEqual,
  sessionSecret,
  sign,
  unsign,
} from './auth.js';
import { registerAiRoutes } from './ai-page.js';
import { registerBrainRoutes } from './brain-page.js';
import { registerRivenRoutes } from './riven-page.js';
import { registerSsTestRoutes } from './sstest-page.js';
import { registerConfigRoutes } from './config-page.js';
import { type Option, type PageContext, actionButton, badge, csrfField, deniedPage, head, layout, loginPage, notConfiguredPage, select, statCard } from './pages.js';

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const kb = (bytes: number) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const id = (v: unknown) => (typeof v === 'string' && /^\d{15,22}$/.test(v) ? v : null);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The /admin web panel: Discord login, whitelist check on every request, CSRF token on every form. */
export function adminRouter(ctx: AppContext): Router {
  const { config, store, client } = ctx;
  const router = express.Router();
  const guildId = config.DISCORD_GUILD_ID;
  const enabled = Boolean(config.DISCORD_CLIENT_SECRET && config.PUBLIC_URL);
  let secret: Buffer | null = null;
  const key = () => (secret ??= sessionSecret(store));

  router.use(express.urlencoded({ extended: false, limit: '100kb' }));
  router.use((_req, res, next) => {
    const nonce = randomBytes(16).toString('base64');
    res.locals.nonce = nonce;
    res.set({
      'Content-Security-Policy': `default-src 'none'; img-src 'self' https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });

  const pc = (res: Response, active?: string, req?: Request): PageContext => ({
    nonce: res.locals.nonce as string,
    session: (res.locals.session as PanelSession | undefined) ?? null,
    active,
    flash: req ? { ok: text(req.query.ok, 300) || undefined, err: text(req.query.err, 300) || undefined } : undefined,
  });
  const html = (res: Response, body: string, status = 200) => res.status(status).type('html').send(body);
  const sessionOf = (req: Request) => {
    const sid = unsign(parseCookies(req.headers.cookie)[SESSION_COOKIE], key());
    return sid ? store.getPanelSession(sid) : null;
  };

  if (!enabled) {
    const missing = [!config.DISCORD_CLIENT_SECRET && 'DISCORD_CLIENT_SECRET', !config.PUBLIC_URL && 'PUBLIC_URL'].filter((m): m is string => Boolean(m));
    console.warn(`[admin] panel disabled: missing ${missing.join(', ')}`);
    router.use((_req, res) => html(res, notConfiguredPage(pc(res), missing), 503));
    return router;
  }

  // --- login flow ---

  router.get('/login', (_req, res) => {
    const clientId = client.application?.id ?? client.user?.id;
    if (!clientId) return html(res, loginPage({ ...pc(res), flash: { err: 'Ordis is still starting up. Try again in a moment.' } }, config.CLAN_NAME), 503);
    const state = randomToken();
    res.setHeader('Set-Cookie', cookie(STATE_COOKIE, sign(state, key()), 600));
    res.redirect(authorizeUrl(clientId, config, state));
  });

  router.get('/callback', async (req, res) => {
    const expected = unsign(parseCookies(req.headers.cookie)[STATE_COOKIE], key());
    const fail = (msg: string) => html(res.setHeader('Set-Cookie', clearCookie(STATE_COOKIE)), loginPage({ ...pc(res), flash: { err: msg } }, config.CLAN_NAME), 400);
    if (!expected || !safeEqual(text(req.query.state, 200), expected)) return fail('That login link expired or was not started here. Please try again.');
    const code = text(req.query.code, 200);
    if (!code) return fail('Discord did not send a login code. Please try again.');
    const clientId = client.application?.id ?? client.user?.id ?? '';
    try {
      const user = await exchangeCode(clientId, config, code);
      if (!isPanelAdmin(config, store, user.id)) {
        console.warn(`[admin] login refused for ${user.username} (${user.id}): not whitelisted`);
        res.setHeader('Set-Cookie', clearCookie(STATE_COOKIE));
        return html(res, deniedPage(pc(res), user.id), 403);
      }
      const session = store.createPanelSession(
        { id: randomToken(), userId: user.id, username: user.global_name ?? user.username, avatar: user.avatar, csrf: randomToken() },
        SESSION_TTL_MS,
      );
      res.setHeader('Set-Cookie', [clearCookie(STATE_COOKIE), cookie(SESSION_COOKIE, sign(session.id, key()), SESSION_TTL_MS / 1000)]);
      console.log(`[admin] ${user.username} (${user.id}) logged in`);
      res.redirect('/admin/');
    } catch (err) {
      console.error('[admin] login failed:', err);
      fail((err as Error).message);
    }
  });

  // --- everything below needs a whitelisted admin; POSTs also need the session's CSRF token ---

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const session = sessionOf(req);
    if (!session) {
      if (req.method === 'GET' && (req.path === '/' || req.path === '')) return html(res, loginPage(pc(res), config.CLAN_NAME));
      return res.redirect('/admin/');
    }
    if (!isPanelAdmin(config, store, session.userId)) {
      store.deletePanelSession(session.id);
      return html(res, deniedPage(pc(res), session.userId), 403);
    }
    res.locals.session = session;
    // Forms carry the token in the body; the screenshot test page posts a raw image, so its script sends it in a header.
    if (req.method === 'POST' && !safeEqual(req.body?._csrf ?? req.get('x-csrf-token'), session.csrf)) return html(res, layout('Expired', '<p>That form expired. Go back, reload and try again.</p>', pc(res)), 403);
    next();
  };
  router.use(guard);

  const back = (res: Response, path: string, msg: { ok?: string; err?: string }) =>
    res.redirect(`/admin/${path}?${new URLSearchParams(msg.ok ? { ok: msg.ok } : { err: msg.err ?? '' })}`);

  /** Runs a POST action and redirects back with a flash message; UserErrors become the message. */
  const action =
    (path: string, fn: (req: Request, session: PanelSession) => Promise<string>) =>
    async (req: Request, res: Response) => {
      const session = res.locals.session as PanelSession;
      try {
        back(res, path, { ok: await fn(req, session) });
      } catch (err) {
        if (!(err instanceof UserError)) console.error(`[admin] ${req.path} failed:`, err);
        back(res, path, { err: err instanceof UserError ? err.message : 'Something went wrong; check the bot logs.' });
      }
    };

  const audit = async (session: PanelSession, what: string, fields: { name: string; value: string }[] = []) => {
    const user = await client.users.fetch(session.userId).catch(() => null);
    if (user) await modLog(ctx, { action: 'Admin panel', moderator: user, reason: what, fields });
  };

  const guild = () => client.guilds.fetch(guildId);
  async function channelOptions(g: Guild): Promise<Option[]> {
    const channels = await g.channels.fetch();
    return [...channels.values()]
      .filter((c) => c && (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement))
      .sort((a, b) => (a!.parent?.rawPosition ?? -1) - (b!.parent?.rawPosition ?? -1) || a!.rawPosition - b!.rawPosition)
      .map((c) => ({ value: c!.id, label: `#${c!.name}${c!.parent ? ` (${c!.parent.name})` : ''}` }));
  }
  async function categoryOptions(g: Guild): Promise<Option[]> {
    const channels = await g.channels.fetch();
    return [...channels.values()]
      .filter((c) => c?.type === ChannelType.GuildCategory)
      .sort((a, b) => a!.rawPosition - b!.rawPosition)
      .map((c) => ({ value: c!.id, label: c!.name }));
  }
  async function roleOptions(g: Guild): Promise<Option[]> {
    const roles = await g.roles.fetch();
    return [...roles.values()]
      .filter((r) => r.id !== g.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({ value: r.id, label: r.name }));
  }
  const nameOf = async (userId: string) => (await client.users.fetch(userId).catch(() => null))?.username ?? userId;

  // --- overview ---

  router.get('/', async (req, res) => {
    const s = await buildStatus(ctx);
    const settings = store.getSettings(guildId);
    const latest = store.listBackups(guildId)[0];
    const ch = (cid: string | null) => (cid ? `<code>#${e(client.channels.cache.get(cid) && 'name' in client.channels.cache.get(cid)! ? (client.channels.cache.get(cid) as { name: string }).name : cid)}</code>` : badge('off'));
    const body = `${head('Overview', 'How Ordis and the clan server are doing right now.')}
<div class="grid">
${statCard('Bot', s.online ? 'Online' : 'Offline', `${s.pingMs !== null ? `${s.pingMs} ms ping · ` : ''}up ${Math.floor(s.uptimeSeconds / 3600)}h ${Math.floor((s.uptimeSeconds % 3600) / 60)}m`, { tone: s.online ? 'ok' : 'bad' })}
${statCard('Discord members', e(String(s.server?.memberCount ?? '—')))}
${statCard('Registered Tenno', String(s.registeredMembers))}
${statCard('Upcoming events', String(s.upcomingEvents.length))}
${statCard('Latest backup', latest ? `#${latest.id}` : '—', latest ? utc(latest.createdAt) : 'No backups yet')}
</div>
<h2>Bot channels</h2>
<div class="card"><table>
<tr><td>Worldstate alerts</td><td>${ch(settings.alertsChannelId)}</td></tr>
<tr><td>Announcements &amp; events</td><td>${ch(settings.announcementsChannelId)}</td></tr>
<tr><td>Moderation log</td><td>${ch(settings.modLogChannelId)}</td></tr>
<tr><td>Welcome</td><td>${ch(settings.welcomeChannelId)}</td></tr>
<tr><td>Honeypot</td><td>${settings.honeypotChannelId ? `${ch(settings.honeypotChannelId)} ${badge(honeypotAction(settings.honeypotAction), 'warn')}` : badge('off')}</td></tr>
<tr><td>Verification</td><td>${settings.verifyRoleId ? `${ch(settings.verifyChannelId)}${settings.verifyMinAccountAgeDays ? ` ${badge(`accounts ≥ ${settings.verifyMinAccountAgeDays} days`, 'info')}` : ''}` : badge('off')}</td></tr>
</table><p class="mt"><a href="/admin/settings">Change settings →</a></p></div>`;
    html(res, layout('Overview', body, pc(res, 'overview', req)));
  });

  // --- settings ---

  router.get('/settings', async (req, res) => {
    const g = await guild();
    const [channels, roles, categories] = await Promise.all([channelOptions(g), roleOptions(g), categoryOptions(g)]);
    const s = store.getSettings(guildId);
    const p = pc(res, 'settings', req);
    const activities = store.listActivities();
    const nameOfId = (cid: string | null, list: Option[]) => (cid ? e(list.find((o) => o.value === cid)?.label ?? cid) : '—');
    const field = (label: string, name: keyof GuildSettings, opts: Option[]) => `<label>${label}${select(name, opts, s[name] as string | null)}</label>`;
    const body = `${head('Settings', 'Where Ordis posts, and which safety tools are switched on.')}
<h2>Channels</h2>
<div class="card"><form class="stack" method="post" action="/admin/settings">${csrfField(p.session)}
<div class="row">
${field('Worldstate alerts channel', 'alertsChannelId', channels)}
${field('Alerts ping role', 'alertsRoleId', roles)}
${field('Announcements & events channel', 'announcementsChannelId', channels)}
${field('Moderation log channel', 'modLogChannelId', channels)}
${field('Welcome channel', 'welcomeChannelId', channels)}
${field('Ordis chat channel', 'chatChannelId', channels)}
</div><div><button>Save</button></div></form></div>
<h2>Squad voice channels</h2>
<div class="card"><form class="stack" method="post" action="/admin/settings/lfgvoice">${csrfField(p.session)}
<p class="muted">Every /lfg squad gets its own temporary voice channel in this category. Joining the squad unlocks it, and it is deleted when the squad ends and the channel is empty.</p>
<div class="row">
<label>Category${select('category', categories, s.lfgVoiceCategoryId, '— pick a category —')}</label>
<label>Host grace (minutes)<input type="number" name="grace" min="1" max="60" value="${s.lfgVoiceGraceMinutes ?? 5}"></label>
</div><div><button>${s.lfgVoiceCategoryId ? 'Update squad voice' : 'Turn on squad voice'}</button></div></form>
${s.lfgVoiceCategoryId ? `<p>${actionButton(p.session, '/admin/settings/lfgvoice/off', 'Turn squad voice off', { danger: true, confirm: true })}</p>` : ''}</div>
<h2>LFG activities</h2>
<div class="card">
${
  activities.length
    ? `<table><tr><th>Activity</th><th>Picture</th><th>Ping role</th><th>Channel</th><th></th></tr>${activities
        .map(
          (a) =>
            `<tr><td>${e(a.name)}</td><td>${a.imageUrl ? `<img src="${e(a.imageUrl)}" alt="" width="40" height="40" class="thumb">` : '—'}</td><td>${nameOfId(a.roleId, roles)}</td><td>${nameOfId(a.channelId, channels)}</td><td>${actionButton(p.session, `/admin/settings/activity/remove?name=${encodeURIComponent(a.name)}`, 'Remove', { danger: true, confirm: true })}</td></tr>`,
        )
        .join('')}</table>`
    : '<p class="muted">No activity has a picture, role or channel yet.</p>'
}
<form class="stack" method="post" action="/admin/settings/activity">${csrfField(p.session)}
<p class="muted">Add an activity or update one by using its name again. Empty fields keep what is already set. The picture must be a direct https image link.</p>
<div class="row">
<label>Activity name<input name="name" maxlength="100" required placeholder="Eidolon hunt"></label>
<label>Picture URL<input name="image" maxlength="1000" placeholder="https://…/image.png"></label>
<label>Ping role${select('role', roles, null, '— unchanged —')}</label>
<label>Fixed channel${select('channel', channels, null, '— unchanged —')}</label>
</div><div><button>Save activity</button></div></form></div>
<h2>Honeypot</h2>
<div class="card"><form class="stack" method="post" action="/admin/settings/honeypot">${csrfField(p.session)}
<p class="muted">Anyone without moderator powers who posts in this channel is removed. Pick a channel nobody should write in; a "do not post" notice is posted there.</p>
<div class="row">
<label>Trap channel${select('channel', channels, s.honeypotChannelId, '— pick a channel —')}</label>
<label>Action${select('action', HONEYPOT_ACTIONS.map((a) => ({ value: a, label: a })), honeypotAction(s.honeypotAction), '— softban —')}</label>
</div><div><button>${s.honeypotChannelId ? 'Update honeypot' : 'Turn on honeypot'}</button></div></form>
${s.honeypotChannelId ? `<p>${actionButton(p.session, '/admin/settings/honeypot/off', 'Turn honeypot off', { danger: true, confirm: true })}</p>` : ''}</div>
<h2>Verification</h2>
<div class="card"><form class="stack" method="post" action="/admin/settings/verification">${csrfField(p.session)}
<div class="row">
<label>Panel channel${select('channel', channels, s.verifyChannelId, '— pick a channel —')}</label>
<label>Role to give${select('role', roles, s.verifyRoleId, '— pick a role —')}</label>
<label>Minimum account age (days)<input type="number" name="min_age" min="0" max="365" value="${s.verifyMinAccountAgeDays ?? 0}"></label>
</div><div><button>${s.verifyRoleId ? 'Update and re-post panel' : 'Turn on verification'}</button></div></form>
${s.verifyRoleId ? `<p>${actionButton(p.session, '/admin/settings/verification/off', 'Turn verification off', { danger: true, confirm: true })}</p>` : ''}</div>`;
    html(res, layout('Settings', body, p));
  });

  router.post(
    '/settings',
    action('settings', async (req, session) => {
      const g = await guild();
      await Promise.all([g.channels.fetch(), g.roles.fetch()]);
      const ch = (k: string) => {
        const v = id(req.body[k]);
        if (v && !g.channels.cache.has(v)) throw new UserError('One of the channels no longer exists.');
        return v;
      };
      const role = id(req.body.alertsRoleId);
      if (role && !g.roles.cache.has(role)) throw new UserError('That role no longer exists.');
      const chatChannelId = ch('chatChannelId');
      assertChannelFree(ctx, { chatChannelId });
      store.updateSettings(guildId, {
        alertsChannelId: ch('alertsChannelId'),
        alertsRoleId: role,
        announcementsChannelId: ch('announcementsChannelId'),
        modLogChannelId: ch('modLogChannelId'),
        welcomeChannelId: ch('welcomeChannelId'),
        chatChannelId,
      });
      await audit(session, 'Changed bot channel settings');
      return 'Settings saved.';
    }),
  );

  router.post(
    '/settings/lfgvoice',
    action('settings', async (req, session) => {
      const category = id(req.body.category);
      if (!category) throw new UserError('Pick a category for the squad voice channels.');
      const g = await guild();
      const found = await g.channels.fetch(category).catch(() => null);
      if (found?.type !== ChannelType.GuildCategory) throw new UserError('That category no longer exists.');
      const grace = Math.max(1, Math.min(60, Number(req.body.grace) || 5));
      store.updateSettings(guildId, { lfgVoiceCategoryId: category, lfgVoiceGraceMinutes: grace });
      await audit(session, 'Turned on squad voice', [{ name: 'Category', value: found.name }]);
      return 'Squad voice is on.';
    }),
  );

  router.post(
    '/settings/lfgvoice/off',
    action('settings', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      store.updateSettings(guildId, { lfgVoiceCategoryId: null, lfgVoiceGraceMinutes: null });
      await audit(session, 'Turned squad voice off');
      return 'Squad voice is off. Existing squad channels are cleaned up as usual.';
    }),
  );

  router.post(
    '/settings/activity',
    action('settings', async (req, session) => {
      const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) : '';
      if (!name) throw new UserError('Give the activity a name.');
      const g = await guild();
      await Promise.all([g.channels.fetch(), g.roles.fetch()]);
      const existing = store.getActivity(name);
      const imageText = typeof req.body.image === 'string' ? req.body.image.trim() : '';
      const imageUrl = imageText ? validImageUrl(imageText) : (existing?.imageUrl ?? null);
      if (imageText && !imageUrl) throw new UserError('The picture must be a direct https link to an image, without spaces.');
      const role = id(req.body.role) ?? existing?.roleId ?? null;
      const channel = id(req.body.channel) ?? existing?.channelId ?? null;
      if (role && !g.roles.cache.has(role)) throw new UserError('That role no longer exists.');
      if (channel && !g.channels.cache.has(channel)) throw new UserError('That channel no longer exists.');
      if (!imageUrl && !role && !channel) throw new UserError('Set a picture, a role or a channel.');
      store.saveActivity({ name: existing?.name ?? name, imageUrl, roleId: role, channelId: channel });
      await audit(session, existing ? 'Updated an LFG activity' : 'Added an LFG activity', [{ name: 'Activity', value: name }]);
      return `Saved "${name}".`;
    }),
  );

  router.post(
    '/settings/activity/remove',
    action('settings', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      const name = typeof req.query.name === 'string' ? req.query.name : '';
      if (!store.removeActivity(name)) throw new UserError('That activity has no settings.');
      await audit(session, 'Removed an LFG activity', [{ name: 'Activity', value: name }]);
      return `Removed "${name}".`;
    }),
  );

  router.post(
    '/settings/honeypot',
    action('settings', async (req, session) => {
      const channel = id(req.body.channel);
      if (!channel) throw new UserError('Pick a channel for the trap.');
      const chosen = honeypotAction(typeof req.body.action === 'string' ? req.body.action : null);
      await setupHoneypot(ctx, channel, chosen);
      await audit(session, 'Set up the honeypot', [{ name: 'Channel', value: `<#${channel}> · ${chosen}` }]);
      return 'Honeypot is on.';
    }),
  );

  router.post(
    '/settings/honeypot/off',
    action('settings', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      disableHoneypot(ctx);
      await audit(session, 'Turned the honeypot off');
      return 'Honeypot is off.';
    }),
  );

  router.post(
    '/settings/verification',
    action('settings', async (req, session) => {
      const channel = id(req.body.channel);
      const role = id(req.body.role);
      if (!channel || !role) throw new UserError('Pick both a channel and a role.');
      const minAge = Math.max(0, Math.min(365, Number(req.body.min_age) || 0));
      const url = await setupVerification(ctx, channel, role, minAge || null);
      await audit(session, 'Set up verification', [{ name: 'Panel', value: url }]);
      return 'Verification panel posted.';
    }),
  );

  router.post(
    '/settings/verification/off',
    action('settings', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      await disableVerification(ctx);
      await audit(session, 'Turned verification off');
      return 'Verification is off and its panel was removed.';
    }),
  );

  // --- AI (same controls as the /ai command) ---

  registerAiRoutes({ router, ctx, pc, html, action, audit });
  registerBrainRoutes({ router, ctx, pc, html, action, audit });
  registerSsTestRoutes({ router, ctx, pc, html });
  registerRivenRoutes({ router, ctx, pc, html, action, audit, channelOptions: async () => channelOptions(await guild()) });
  registerConfigRoutes({ router, ctx, pc, html, action, audit });

  // --- announcements ---

  router.get('/announce', async (req, res) => {
    const g = await guild();
    const [channels, roles] = await Promise.all([channelOptions(g), roleOptions(g)]);
    const p = pc(res, 'announce', req);
    const body = `${head('Announce', 'Post a message as Ordis, optionally pinging a role.')}
<div class="card"><form class="stack" method="post" action="/admin/announce">${csrfField(p.session)}
<div class="row">
<label>Channel${select('channel', channels, store.getSettings(guildId).announcementsChannelId, '— pick a channel —')}</label>
<label>Ping role (optional)${select('role', roles, null, '— no ping —')}</label>
</div>
<label>Title (optional)<input name="title" maxlength="256"></label>
<label>Message (Discord markdown)<textarea name="message" maxlength="4000" required></textarea></label>
<div><button>Post announcement</button></div></form></div>`;
    html(res, layout('Announce', body, p));
  });

  router.post(
    '/announce',
    action('announce', async (req, session) => {
      const message = text(req.body.message, 4000);
      if (!message) throw new UserError('Write a message first.');
      const sent = await postAnnouncement(ctx, { message, title: text(req.body.title, 256) || null, channelId: id(req.body.channel), pingRoleId: id(req.body.role) });
      await audit(session, 'Posted an announcement', [{ name: 'Message', value: sent.url }]);
      return 'Announcement posted.';
    }),
  );

  // --- events ---

  router.get('/events', async (req, res) => {
    const p = pc(res, 'events', req);
    const events = store.upcomingEvents(guildId);
    const rows = events
      .map((ev) => {
        const r = store.getRsvps(ev.id);
        return `<tr><td>#${ev.id}</td><td>${e(ev.title)}</td><td>${utc(ev.startsAt)}</td><td>${r.going.length} going · ${r.maybe.length} maybe</td><td>${actionButton(p.session, `/admin/events/${ev.id}/cancel`, 'Cancel', { danger: true, confirm: true })}</td></tr>`;
      })
      .join('');
    const body = `${head('Events', 'Clan events get RSVP buttons in the announcements channel and a reminder 15 minutes before they start.')}
<div class="card"><form class="stack" method="post" action="/admin/events">${csrfField(p.session)}
<div class="row">
<label>Title<input name="title" maxlength="200" required></label>
<label>Starts (UTC)<input type="datetime-local" name="when" required></label>
</div>
<label>Description (optional)<textarea name="description" maxlength="2000"></textarea></label>
<div class="actions"><button>Create event</button> <span class="muted">Posted with RSVP buttons in the announcements channel.</span></div></form></div>
<h2>Upcoming</h2>
<div class="card">${events.length ? `<table><tr><th>#</th><th>Title</th><th>Starts</th><th>RSVPs</th><th></th></tr>${rows}</table>` : '<p class="muted">Nothing scheduled.</p>'}</div>`;
    html(res, layout('Events', body, p));
  });

  router.post(
    '/events',
    action('events', async (req, session) => {
      const title = text(req.body.title, 200);
      const startsAt = parseWhen(text(req.body.when, 40));
      if (!title || startsAt === null) throw new UserError('Give the event a title and a start time.');
      const event = await createClanEvent(ctx, { title, description: text(req.body.description, 2000) || null, startsAt, createdBy: session.userId });
      await audit(session, `Created event #${event.id}: ${title}`);
      return `Event #${event.id} posted.`;
    }),
  );

  router.post(
    '/events/:id/cancel',
    action('events', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      const event = await cancelClanEvent(ctx, Number(req.params.id));
      await audit(session, `Cancelled event #${event.id}: ${event.title}`);
      return `Event #${event.id} cancelled.`;
    }),
  );

  // --- members & warnings ---

  router.get('/members', async (req, res) => {
    const p = pc(res, 'members', req);
    const members = store.listMembers(guildId);
    const warnings = store.listAllWarnings(guildId);
    const memberRows = (
      await Promise.all(
        members.map(
          async (m) =>
            `<tr><td>${e(m.ign)}</td><td>${e(await nameOf(m.userId))}</td><td>${m.masteryRank ?? '—'}</td><td>${e(m.platform ?? '—')}</td><td>${actionButton(p.session, `/admin/members/${m.userId}/remove`, 'Remove', { danger: true, confirm: true })}</td></tr>`,
        ),
      )
    ).join('');
    const warnedUsers = [...new Set(warnings.map((w) => w.userId))];
    const warningRows = (
      await Promise.all(
        warnedUsers.map(async (u) => {
          const list = warnings.filter((w) => w.userId === u);
          return `<tr><td>${e(await nameOf(u))}</td><td>${list.length}</td><td>${list.map((w) => `${utc(w.createdAt).slice(0, 10)}: ${e(w.reason)}`).join('<br>')}</td><td>${actionButton(p.session, `/admin/warnings/${u}/clear`, 'Clear', { danger: true, confirm: true })}</td></tr>`;
        }),
      )
    ).join('');
    const body = `${head('Members', 'Who has registered their in-game name, and who has been warned.')}
<h2>Roster (${members.length})</h2>
<div class="card">${members.length ? `<table><tr><th>In-game name</th><th>Discord</th><th>MR</th><th>Platform</th><th></th></tr>${memberRows}</table>` : '<p class="muted">Nobody has registered with /clan register yet.</p>'}</div>
<h2>Warnings</h2>
<div class="card">${warnedUsers.length ? `<table><tr><th>Member</th><th>Count</th><th>Warnings</th><th></th></tr>${warningRows}</table>` : '<p class="muted">No warnings.</p>'}</div>`;
    html(res, layout('Members', body, p));
  });

  router.post(
    '/members/:user/remove',
    action('members', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      if (!store.removeMember(guildId, String(req.params.user))) throw new UserError('That member is not on the roster.');
      await audit(session, `Removed ${await nameOf(String(req.params.user))} from the roster`);
      return 'Removed from the roster.';
    }),
  );

  router.post(
    '/warnings/:user/clear',
    action('members', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      const n = store.clearWarnings(guildId, String(req.params.user));
      await audit(session, `Cleared ${n} warning(s) for ${await nameOf(String(req.params.user))}`);
      return `Cleared ${n} warning${n === 1 ? '' : 's'}.`;
    }),
  );

  // --- backups ---

  router.get('/backups', (req, res) => {
    const p = pc(res, 'backups', req);
    const list = store.listBackups(guildId);
    const rows = list
      .map((b) => {
        const s = summaryOf(b);
        return `<tr><td>#${b.id}</td><td>${utc(b.createdAt)}</td><td>${badge(b.auto ? 'auto' : 'manual', b.auto ? '' : 'info')}${b.label ? ` ${e(b.label)}` : ''}</td><td>${s.roles} roles · ${s.channels} channels · ${s.emojis} emojis · ${kb(s.sizeBytes)}</td><td><a href="/admin/backups/${b.id}/download">Download</a> ${actionButton(p.session, `/admin/backups/${b.id}/delete`, 'Delete', { danger: true, confirm: true })}</td></tr>`;
      })
      .join('');
    const body = `${head('Backups', 'Snapshots of the server (roles, channels, emojis, bans and Ordis settings). A new one is taken every day and the newest 14 are kept.')}
<div class="card"><form class="stack" method="post" action="/admin/backups">${csrfField(p.session)}
<div class="row"><label>Label (optional)<input name="label" maxlength="80"></label></div>
<div class="actions"><button>Back up now</button> <span class="muted">Restoring is done in Discord with <code>/backup load</code>, which previews every change first.</span></div></form></div>
<div class="card">${list.length ? `<table><tr><th>#</th><th>Taken</th><th>Kind</th><th>Contents</th><th></th></tr>${rows}</table>` : '<p class="muted">No backups yet.</p>'}</div>`;
    html(res, layout('Backups', body, p));
  });

  router.post(
    '/backups',
    action('backups', async (req, session) => {
      const stored = await takeBackup(ctx, text(req.body.label, 80) || null, false);
      await audit(session, `Took backup #${stored.id}`);
      return `Backup #${stored.id} saved.`;
    }),
  );

  router.get('/backups/:id/download', (req, res) => {
    const backupId = Number(req.params.id);
    const data = store.getBackupData(guildId, backupId);
    if (!data) return back(res, 'backups', { err: `There is no backup #${backupId}.` });
    const b = store.listBackups(guildId).find((x) => x.id === backupId)!;
    res.setHeader('Content-Disposition', `attachment; filename="ordis-backup-${backupId}-${new Date(b.createdAt).toISOString().slice(0, 10)}.json"`);
    res.type('application/json').send(data);
  });

  router.post(
    '/backups/:id/delete',
    action('backups', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      if (!store.deleteBackup(guildId, Number(req.params.id))) throw new UserError('That backup does not exist.');
      await audit(session, `Deleted backup #${req.params.id}`);
      return `Backup #${req.params.id} deleted.`;
    }),
  );

  // --- admins ---

  router.get('/admins', async (req, res) => {
    const p = pc(res, 'admins', req);
    const owners = await Promise.all(config.PANEL_OWNER_IDS.map(async (u) => `<tr><td>${e(await nameOf(u))}</td><td><code>${u}</code></td><td>${badge('owner', 'info')}</td><td class="muted">set in PANEL_OWNER_IDS</td></tr>`));
    const admins = await Promise.all(
      store
        .listPanelAdmins()
        .filter((a) => !config.PANEL_OWNER_IDS.includes(a.userId))
        .map(
          async (a) =>
            `<tr><td>${e(await nameOf(a.userId))}</td><td><code>${a.userId}</code></td><td>${e(a.note ?? '')}<div class="muted">added ${utc(a.addedAt).slice(0, 10)} by ${e(await nameOf(a.addedBy))}</div></td><td>${actionButton(p.session, `/admin/admins/${a.userId}/remove`, 'Remove', { danger: true, confirm: true })}</td></tr>`,
        ),
    );
    const body = `${head('Admins', 'Who may sign in to this panel. Owners come from PANEL_OWNER_IDS; everyone else is added here.')}
<div class="card"><form class="stack" method="post" action="/admin/admins">${csrfField(p.session)}
<div class="row">
<label>Discord user ID<input name="user_id" pattern="\\d{15,22}" required placeholder="e.g. 603293720061935626"></label>
<label>Note (optional)<input name="note" maxlength="100" placeholder="e.g. clan officer"></label>
</div><div class="actions"><button>Add admin</button> <span class="muted">Right-click a member in Discord → Copy User ID (Developer Mode on).</span></div></form></div>
<div class="card"><table><tr><th>User</th><th>ID</th><th>Role</th><th></th></tr>${owners.join('')}${admins.join('')}</table></div>`;
    html(res, layout('Admins', body, p));
  });

  router.post(
    '/admins',
    action('admins', async (req, session) => {
      const userId = id(req.body.user_id);
      if (!userId) throw new UserError('That is not a Discord user ID (15-22 digits).');
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) throw new UserError('Discord has no user with that ID.');
      if (user.bot) throw new UserError("Bots can't be panel admins.");
      store.addPanelAdmin(userId, session.userId, text(req.body.note, 100) || null);
      await audit(session, `Added ${user.username} as a panel admin`);
      return `${user.username} can now sign in.`;
    }),
  );

  router.post(
    '/admins/:user/remove',
    action('admins', async (req, session) => {
      if (req.body.confirm !== 'yes') throw new UserError('Tick "sure" to confirm.');
      const userId = String(req.params.user);
      if (config.PANEL_OWNER_IDS.includes(userId)) throw new UserError('Owners are set in PANEL_OWNER_IDS and can only be removed there.');
      if (!store.removePanelAdmin(userId)) throw new UserError('That user is not an admin.');
      await audit(session, `Removed ${await nameOf(userId)} as a panel admin`);
      return 'Admin removed and signed out.';
    }),
  );

  router.post('/logout', (_req, res) => {
    const session = res.locals.session as PanelSession;
    store.deletePanelSession(session.id);
    res.setHeader('Set-Cookie', clearCookie(SESSION_COOKIE));
    res.redirect('/admin/');
  });

  return router;
}
