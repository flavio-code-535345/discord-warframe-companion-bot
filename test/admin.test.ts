import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { brain, resetBrainState } from '../src/agent/brain.js';
import { aiToggle, resetAiToggles } from '../src/ai/settings.js';
import { Store } from '../src/db.js';
import { startHttpServer } from '../src/http.js';
import { SESSION_COOKIE, sessionSecret, sign, unsign } from '../src/web/admin/auth.js';

const GUILD = '111111111111111111';
const OWNER = '603293720061935626';
let baseUrl = '';
let close: () => void = () => {};
let store: Store;

before(async () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'x',
    DISCORD_GUILD_ID: GUILD,
    DISCORD_CLIENT_SECRET: 'secret',
    PUBLIC_URL: 'https://ratsden.example/',
    HTTP_HOST: '127.0.0.1',
  });
  store = new Store(':memory:');
  const client = {
    isReady: () => false,
    application: { id: '1563696012705529997' },
    user: { id: 'bot' },
    users: { fetch: async (id: string) => ({ id, username: `user${id.slice(-3)}`, bot: false }) },
    channels: { cache: new Map() },
    guilds: { fetch: async () => ({ id: GUILD, channels: { fetch: async () => new Map(), cache: new Map() }, roles: { fetch: async () => new Map(), cache: new Map() } }) },
  } as unknown as Client;
  const ctx: AppContext = { config: { ...config, HTTP_PORT: 0 }, store, client, ai: null };
  const server = startHttpServer(ctx);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const get = (path: string, cookie?: string) => fetch(`${baseUrl}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const post = (path: string, form: Record<string, string>, cookie: string) =>
  fetch(`${baseUrl}${path}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });

function sessionCookie(userId: string) {
  const session = store.createPanelSession({ id: `sess-${userId}-${Math.random()}`, userId, username: 'Rat', avatar: null, csrf: 'csrf-token' }, 60_000);
  return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sign(session.id, sessionSecret(store)))}`, session };
}

test('signed cookies reject tampering', () => {
  const key = Buffer.alloc(32, 7);
  assert.equal(unsign(sign('abc', key), key), 'abc');
  assert.equal(unsign(`${sign('abc', key)}x`, key), null);
  assert.equal(unsign('abc.def', key), null);
});

test('anonymous visitors get the login page; /login redirects to Discord with state and redirect URI', async () => {
  const page = await get('/admin/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Log in with Discord/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

  const login = await get('/admin/login');
  assert.equal(login.status, 302);
  const url = new URL(login.headers.get('location')!);
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://ratsden.example/admin/callback');
  assert.equal(url.searchParams.get('scope'), 'identify');
  assert.ok(url.searchParams.get('state'));
  assert.match(login.headers.get('set-cookie') ?? '', /HttpOnly; Secure; SameSite=Lax/);

  const forged = await get('/admin/callback?code=x&state=wrong');
  assert.equal(forged.status, 400);
});

test('a session for someone off the whitelist is refused and destroyed', async () => {
  const { cookie, session } = sessionCookie('999999999999999999');
  const res = await get('/admin/admins', cookie);
  assert.equal(res.status, 403);
  assert.match(await res.text(), /isn't on the admin whitelist/);
  assert.equal(store.getPanelSession(session.id), null);
});

test('owners can use the panel; forms need the CSRF token; owners cannot be removed', async () => {
  const { cookie } = sessionCookie(OWNER);
  const page = await get('/admin/admins', cookie);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /Add admin/);
  assert.match(body, new RegExp(OWNER));

  const noToken = await post('/admin/admins', { user_id: '222222222222222222' }, cookie);
  assert.equal(noToken.status, 403);
  assert.equal(store.isPanelAdmin('222222222222222222'), false);

  const added = await post('/admin/admins', { user_id: '222222222222222222', note: 'officer', _csrf: 'csrf-token' }, cookie);
  assert.equal(added.status, 302);
  assert.match(added.headers.get('location') ?? '', /\/admin\/admins\?ok=/);
  assert.equal(store.isPanelAdmin('222222222222222222'), true);

  const removeOwner = await post(`/admin/admins/${OWNER}/remove`, { confirm: 'yes', _csrf: 'csrf-token' }, cookie);
  assert.match(new URL(removeOwner.headers.get('location') ?? '', baseUrl).searchParams.get('err') ?? '', /Owners are set in PANEL_OWNER_IDS/);

  const removed = await post('/admin/admins/222222222222222222/remove', { confirm: 'yes', _csrf: 'csrf-token' }, cookie);
  assert.match(removed.headers.get('location') ?? '', /ok=/);
  assert.equal(store.isPanelAdmin('222222222222222222'), false);
});

test('LFG activities: a picture is saved, bad pictures are refused, and removal needs confirmation', async () => {
  const { cookie } = sessionCookie(OWNER);
  const errOf = (res: Response) => new URL(res.headers.get('location') ?? '', baseUrl).searchParams.get('err') ?? '';

  const bad = await post('/admin/settings/activity', { name: 'Eidolon hunt', image: 'http://insecure.example/e.png', _csrf: 'csrf-token' }, cookie);
  assert.match(errOf(bad), /direct https link/);
  assert.equal(store.getActivity('Eidolon hunt'), null);

  const empty = await post('/admin/settings/activity', { name: 'Eidolon hunt', _csrf: 'csrf-token' }, cookie);
  assert.match(errOf(empty), /picture, a role or a channel/);

  const saved = await post('/admin/settings/activity', { name: 'Eidolon hunt', image: 'https://example.com/e.png', _csrf: 'csrf-token' }, cookie);
  assert.match(saved.headers.get('location') ?? '', /ok=/);
  assert.equal(store.getActivity('eidolon hunt')?.imageUrl, 'https://example.com/e.png');

  const page = await get('/admin/settings', cookie);
  assert.match(await page.text(), /https:\/\/example\.com\/e\.png/);

  const unconfirmed = await post('/admin/settings/activity/remove?name=Eidolon%20hunt', { _csrf: 'csrf-token' }, cookie);
  assert.match(errOf(unconfirmed), /confirm/);
  assert.ok(store.getActivity('Eidolon hunt'));
  const removed = await post('/admin/settings/activity/remove?name=Eidolon%20hunt', { confirm: 'yes', _csrf: 'csrf-token' }, cookie);
  assert.match(removed.headers.get('location') ?? '', /ok=/);
  assert.equal(store.getActivity('Eidolon hunt'), null);
});

test('logout ends the session', async () => {
  const { cookie, session } = sessionCookie(OWNER);
  const res = await post('/admin/logout', { _csrf: 'csrf-token' }, cookie);
  assert.equal(res.status, 302);
  assert.equal(store.getPanelSession(session.id), null);
});

test('the AI page shows the switches, and a switch flipped there is the one the bot uses', async () => {
  const { cookie } = sessionCookie(OWNER);
  const page = await get('/admin/ai', cookie);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<h1>AI<\/h1>/);
  assert.match(body, /Web search/);
  assert.match(body, /No local AI server is set up/);

  const noCsrf = await post('/admin/ai/toggle', { feature: 'websearch', on: '0' }, cookie);
  assert.equal(noCsrf.status, 403);

  const res = await post('/admin/ai/toggle', { feature: 'websearch', on: '0', _csrf: 'csrf-token' }, cookie);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent((res.headers.get('location') ?? '').replace(/[+]/g, ' ')), /is now off/);
  assert.equal(aiToggle('websearch'), false);
  assert.equal(store.getMeta('ai_toggle_websearch'), 'off');
  assert.match(await (await get('/admin/ai', cookie)).text(), /Turn on/);

  const bad = await post('/admin/ai/toggle', { feature: 'nope', on: '1', _csrf: 'csrf-token' }, cookie);
  assert.match(decodeURIComponent((bad.headers.get('location') ?? '').replace(/[+]/g, ' ')), /Unknown switch/);
  resetAiToggles();
});

test('the Brain page shows the prompt and slider, and saving clamps and applies the settings', async () => {
  const { cookie } = sessionCookie(OWNER);
  const page = await get('/admin/brain', cookie);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<h1>Brain<\/h1>/);
  assert.match(body, /type="range" name="ordisness"/);
  assert.match(body, /You are Cephalon Ordis, the Cephalon of the Warframe clan/);

  const noCsrf = await post('/admin/brain/save', { ordisness: '90' }, cookie);
  assert.equal(noCsrf.status, 403);

  const saved = await post('/admin/brain/save', { ordisness: '900', temperature: '0.8', maxSteps: '3', agentFor: 'everyone', scope: 'all', toolMode: 'text', prompt: 'Custom prompt {{persona}}', show_tools: '1', tool_search_wiki: '1', _csrf: 'csrf-token' }, cookie);
  assert.equal(saved.status, 302);
  assert.equal(brain().ordisness, 100);
  assert.equal(brain().temperature, 0.8);
  assert.equal(brain().agentFor, 'everyone');
  assert.equal(brain().prompt, 'Custom prompt {{persona}}');
  assert.equal(brain().showTools, true);
  assert.ok(brain().disabledTools.includes('search_web') && !brain().disabledTools.includes('search_wiki'), 'unticked tools are switched off');
  assert.match(store.getMeta('brain_settings') ?? '', /"ordisness":100/);
  assert.match(await (await get('/admin/brain', cookie)).text(), /Custom prompt/);

  const noConfirm = await post('/admin/brain/reset', { _csrf: 'csrf-token' }, cookie);
  assert.match(decodeURIComponent((noConfirm.headers.get('location') ?? '').replace(/[+]/g, ' ')), /Tick/);
  await post('/admin/brain/reset', { confirm: 'yes', _csrf: 'csrf-token' }, cookie);
  assert.equal(brain().ordisness, 20);
  assert.equal(brain().prompt, '');
  resetBrainState();
});

test('the Brain chat streams the run as JSON lines, and only the Brain page may run a script', async () => {
  const { cookie } = sessionCookie(OWNER);
  const page = await get('/admin/brain', cookie);
  assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'nonce-[^']+'; connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /<script nonce="[^"]+">/);
  assert.match(html, /id="chatform"/);
  assert.doesNotMatch(await (await get('/admin/ai', cookie)).text(), /<script/);

  const noCsrf = await post('/admin/brain/chat', { question: 'hi' }, cookie);
  assert.equal(noCsrf.status, 403);
  const empty = await post('/admin/brain/chat', { question: ' ', _csrf: 'csrf-token' }, cookie);
  assert.equal(empty.status, 400);

  // The test bot has no model, so the run fails at once: a start line, then the reason.
  const res = await post('/admin/brain/chat', { question: 'what is a Kuva Lich?', history: '[{"role":"user","content":"x"},{"bad":1}]', _csrf: 'csrf-token' }, cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /x-ndjson/);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].t, 'start');
  assert.equal(lines.at(-1).t, 'error');
  assert.match(lines.at(-1).message, /No model is available/);
});
