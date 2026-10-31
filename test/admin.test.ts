import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { ChannelType, type Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { aiToggle, resetAiToggles } from '../src/ai/settings.js';
import { addCorrection } from '../src/answers/corrections.js';
import { Store } from '../src/db.js';
import { startHttpServer } from '../src/http.js';
import { SESSION_COOKIE, sessionSecret, sign, unsign } from '../src/web/admin/auth.js';

const GUILD = '111111111111111111';
const OWNER = '603293720061935626';
let baseUrl = '';
let close: () => void = () => {};
let store: Store;
const testChannels = new Map<string, unknown>();

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
    guilds: { fetch: async () => ({ id: GUILD, channels: { fetch: async (id?: string) => (id ? testChannels.get(id) ?? null : testChannels), cache: testChannels }, roles: { fetch: async () => new Map(), cache: new Map() } }) },
  } as unknown as Client;
  const ctx: AppContext = { config: { ...config, HTTP_PORT: 0 }, store, client };
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

test('the AI page has the switches and no answer cache any more', async () => {
  const { cookie } = sessionCookie(OWNER);
  const body = await (await get('/admin/ai', cookie)).text();
  assert.match(body, /<h2>Switches<\/h2>/);
  assert.doesNotMatch(body, /Answer cache|Refresh now/);
});

test('the Config page edits settings that used to be environment variables, with limits for non-owners', async () => {
  const { cookie } = sessionCookie(OWNER);
  const page = await get('/admin/config', cookie);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<h1>Config<\/h1>/);
  assert.match(body, /Live world state/);
  assert.match(body, /Still environment-only/);
  assert.match(body, /DISCORD_TOKEN/);
  assert.doesNotMatch(body, /name="s_DISCORD_TOKEN"|name="s_MCP_AUTH_TOKEN"/);

  assert.equal((await post('/admin/config/save', { group: 'Warframe data', s_WORLDSTATE_ENABLED: 'true' }, cookie)).status, 403);
  const flash = (r: Response) => decodeURIComponent((r.headers.get('location') ?? '').replace(/[+]/g, ' '));

  const saved = await post('/admin/config/save', { group: 'Warframe data', s_WORLDSTATE_ENABLED: 'true', s_WORLDSTATE_POLL_SECONDS: '900', s_WORLDSTATE_URL: '', s_WARFRAME_PLATFORM: 'pc', _csrf: 'csrf-token' }, cookie);
  assert.match(flash(saved), /Saved 2 settings\. Applied\./);
  assert.equal(store.getMeta('cfg_WORLDSTATE_ENABLED'), 'v:true');
  assert.equal(store.getMeta('cfg_WORLDSTATE_POLL_SECONDS'), 'v:900');
  assert.equal(store.getMeta('cfg_WARFRAME_PLATFORM'), null, 'unchanged values are not pinned');
  assert.match(await (await get('/admin/config', cookie)).text(), /set here/);

  const bad = await post('/admin/config/save', { group: 'Warframe data', s_WORLDSTATE_POLL_SECONDS: '5', _csrf: 'csrf-token' }, cookie);
  assert.match(flash(bad), /World state poll interval/);
  assert.equal(store.getMeta('cfg_WORLDSTATE_POLL_SECONDS'), 'v:900', 'a refused value changes nothing');

  const restartNeeded = await post('/admin/config/save', { group: 'Needs a restart', s_WIKI_INDEX: 'false', _csrf: 'csrf-token' }, cookie);
  assert.match(flash(restartNeeded), /Local wiki copy: applies after a restart/);

  const reset = await post('/admin/config/save', { group: 'Warframe data', reset_WORLDSTATE_ENABLED: '1', reset_WORLDSTATE_POLL_SECONDS: '1', _csrf: 'csrf-token' }, cookie);
  assert.match(flash(reset), /Saved 2 settings/);
  assert.equal(store.getMeta('cfg_WORLDSTATE_POLL_SECONDS'), '');
  await post('/admin/config/save', { group: 'Needs a restart', reset_WIKI_INDEX: '1', _csrf: 'csrf-token' }, cookie);

  assert.match(flash(await post('/admin/config/restart', { _csrf: 'csrf-token' }, cookie)), /Tick "sure"/);

  // A panel admin who is not an owner cannot change who the operators are.
  await post('/admin/admins', { user_id: '333333333333333333', note: 'officer', _csrf: 'csrf-token' }, cookie);
  const officer = sessionCookie('333333333333333333');
  assert.match(flash(await post('/admin/config/save', { group: 'Operators', s_OPERATOR_IDS: '333333333333333333', _csrf: 'csrf-token' }, officer.cookie)), /Only panel owners/);
  assert.equal(store.getMeta('cfg_OPERATOR_IDS'), null);
  assert.match(flash(await post('/admin/config/save', { group: 'Operators', s_OPERATOR_IDS: '603293720061935626', _csrf: 'csrf-token' }, cookie)), /Saved 1 setting/);
  await post('/admin/config/save', { group: 'Operators', reset_OPERATOR_IDS: '1', _csrf: 'csrf-token' }, cookie);
});

test('the Screenshots test page runs one reader per request and needs the CSRF header', async () => {
  const { cookie } = sessionCookie(OWNER);
  const page = await get('/admin/sstest', cookie);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /1\. OCR/);
  assert.match(html, /2\. Gemma \(Ollama\)/);
  assert.match(html, /3\. Gemini/);
  assert.ok(html.indexOf('1. OCR') < html.indexOf('2. Gemma') && html.indexOf('2. Gemma') < html.indexOf('3. Gemini'), 'the bot order');

  const run = (method: string, headers: Record<string, string>, body: Uint8Array = new Uint8Array([1, 2, 3])) =>
    fetch(`${baseUrl}/admin/sstest/run?method=${method}`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'image/png', ...headers }, body });
  assert.equal((await run('ocr', {})).status, 403, 'no token');
  assert.equal((await run('bogus', { 'x-csrf-token': 'csrf-token' })).status, 400);
  assert.equal((await fetch(`${baseUrl}/admin/sstest/run?method=ocr`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'text/plain', 'x-csrf-token': 'csrf-token' }, body: 'x' })).status, 400, 'not an image');

  const results: Record<string, any> = {};
  for (const m of ['ocr', 'local', 'cloud']) {
    const res = await run(m, { 'x-csrf-token': 'csrf-token' });
    assert.equal(res.status, 200);
    results[m] = (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.equal(results[m].t, 'result');
    assert.equal(results[m].method, m);
  }
  // Not a real picture: OCR cannot decode it; the test bot has no vision model configured.
  assert.equal(results.ocr.status, 'incomplete');
  assert.equal(results.local.status, 'skipped');
  assert.match(results.local.note, /not configured/i);
  assert.equal(results.cloud.status, 'skipped');
  assert.match(results.cloud.note, /FREE_AI_KEY/);
});

test('the Rivens page shows the scan channel, needs the CSRF header to scan, and turns scanning off', async () => {
  const { cookie } = sessionCookie(OWNER);
  const flash = (r: Response) => decodeURIComponent((r.headers.get('location') ?? '').replace(/[+]/g, ' '));
  const realFetch = globalThis.fetch;
  // The page asks for the weapon list; keep the test off the network (loopback requests to the test server still go through).
  globalThis.fetch = ((url: string, init?: RequestInit) => (String(url).startsWith(baseUrl) ? realFetch(url, init) : Promise.reject(new Error('offline')))) as typeof fetch;
  try {
    store.updateSettings(GUILD, { rivenChannelId: '222222222222222222' });
    const page = await get('/admin/rivens', cookie);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<h1>Rivens<\/h1>/);
    assert.match(html, /Scan channel/);
    assert.match(html, /Turn scanning off/);
    assert.match(html, /<a class="navlink on" href="\/admin\/rivens">Rivens<\/a>/);

    const scan = (headers: Record<string, string>, body: Uint8Array | string = new Uint8Array([1, 2, 3]), type = 'image/png') =>
      fetch(`${baseUrl}/admin/rivens/scan`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': type, ...headers }, body });
    assert.equal((await scan({})).status, 403, 'no token');
    assert.equal((await scan({ 'x-csrf-token': 'csrf-token' }, 'x', 'text/plain')).status, 400, 'not an image');

    assert.match(flash(await post('/admin/rivens/off', { _csrf: 'csrf-token' }, cookie)), /Tick "sure"/);
    assert.equal(store.getSettings(GUILD).rivenChannelId, '222222222222222222');
    assert.match(flash(await post('/admin/rivens/off', { confirm: 'yes', _csrf: 'csrf-token' }, cookie)), /off/);
    assert.equal(store.getSettings(GUILD).rivenChannelId, null);
    assert.match(flash(await post('/admin/rivens/channel', { _csrf: 'csrf-token' }, cookie)), /Pick a channel/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the Corrections page approves suggestions, edits and deletes corrections, adds one, and rates answers', async () => {
  const { cookie } = sessionCookie(OWNER);
  const logId = store.addAiLog(GUILD, { at: Date.now(), userId: '55', userName: 'Asker', channelId: 'c', via: 'chat', question: 'How do I unlock Venus?', intent: 'wiki', source: 'local', model: 'gemma', found: true, ms: 5, answer: 'Complete the Earth quest.', messageId: 'msg-1' });
  const entry = store.getAiLog(GUILD, logId)!;
  const suggested = addCorrection({ config: { DISCORD_GUILD_ID: GUILD }, store } as never, { entry, text: 'Finish Vor’s Prize.', authorId: '66', authorName: 'Rat', staff: false, source: 'member_reply' })!;

  const page = await get('/admin/corrections', cookie);
  assert.equal(page.status, 200);
  const body = await page.text();
  assert.match(body, /<h1>Corrections<\/h1>/);
  assert.match(body, /href="\/admin\/corrections"/, 'in the navigation');
  assert.match(body, /suggested by <strong>Rat<\/strong>/);
  assert.match(body, /Finish Vor’s Prize/);

  assert.equal((await post(`/admin/corrections/${suggested.id}/approve`, { text: 'x' }, cookie)).status, 403, 'needs the CSRF token');
  await post(`/admin/corrections/${suggested.id}/approve`, { text: 'Finish Vor’s Prize first.', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getCorrection(GUILD, suggested.id)!.status, 'approved');
  assert.equal(store.getCorrection(GUILD, suggested.id)!.correction, 'Finish Vor’s Prize first.');
  assert.equal(store.getAiLog(GUILD, logId)!.rating, 'wrong', 'approving marks the original answer wrong');
  assert.match(await (await get('/admin/corrections', cookie)).text(), /Finish Vor’s Prize first\./);

  await post(`/admin/corrections/${suggested.id}/save`, { text: 'Complete Vor’s Prize.', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getCorrection(GUILD, suggested.id)!.correction, 'Complete Vor’s Prize.');
  const noConfirm = await post(`/admin/corrections/${suggested.id}/delete`, { _csrf: 'csrf-token' }, cookie);
  assert.match(decodeURIComponent((noConfirm.headers.get('location') ?? '').replace(/[+]/g, ' ')), /Tick/);
  await post(`/admin/corrections/${suggested.id}/delete`, { confirm: 'yes', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getCorrection(GUILD, suggested.id), null);

  await post('/admin/corrections/add', { question: 'What is a Kuva Lich?', text: 'An enemy that steals your Kuva.', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.listCorrections(GUILD, 'approved')[0]!.source, 'panel');

  const second = addCorrection({ config: { DISCORD_GUILD_ID: GUILD }, store } as never, { entry, text: 'Nope.', authorId: '67', authorName: 'Other', staff: false, source: 'member_reply' })!;
  await post(`/admin/corrections/${second.id}/reject`, { _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getCorrection(GUILD, second.id)!.status, 'rejected');

  const fresh = store.addAiLog(GUILD, { at: Date.now(), userId: '55', userName: 'Asker', channelId: 'c', via: 'chat', question: 'What is Nightwave?', intent: 'wiki', source: 'local', model: 'gemma', found: true, ms: 5, answer: 'A series of challenges.', messageId: 'msg-2' });
  await post('/admin/corrections/rate', { id: String(fresh), rating: 'right', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getAiLog(GUILD, fresh)!.rating, 'right');
  await post('/admin/corrections/rate', { id: String(fresh), rating: 'clear', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getAiLog(GUILD, fresh)!.rating, null);
  await post('/admin/corrections/from-answer', { id: String(fresh), text: 'Nightwave is a weekly challenge series by Nora Night.', _csrf: 'csrf-token' }, cookie);
  assert.equal(store.getAiLog(GUILD, fresh)!.rating, 'wrong');
  assert.equal(store.listCorrections(GUILD, 'approved').some((c) => c.question === 'What is Nightwave?'), true);
  assert.equal((await post('/admin/corrections/rate', { id: String(fresh), rating: 'bogus', _csrf: 'csrf-token' }, cookie)).status, 302);
});

test('the Messages page lists only the bots own messages in a channel and edits their text', async () => {
  const { cookie } = sessionCookie(OWNER);
  const BOT = 'bot';
  const edits: { id: string; content: string; allowedMentions: unknown }[] = [];
  const mk = (id: string, authorId: string, content: string) => ({ id, author: { id: authorId }, content, url: `https://discord.com/channels/${GUILD}/700000000000000001/${id}`, pinned: false, embeds: [], createdTimestamp: 1_700_000_000_000, edit: async (o: { content: string; allowedMentions: unknown }) => { edits.push({ id, ...o }); return { ...mk(id, authorId, o.content) }; } });
  const mine = mk('800000000000000001', BOT, '@Rat Baron · old text');
  const theirs = mk('800000000000000002', '123', 'a member wrote this');
  const messages = new Map([[mine.id, mine], [theirs.id, theirs]]);
  testChannels.set('700000000000000001', {
    id: '700000000000000001', name: 'roles', type: ChannelType.GuildText, rawPosition: 0, parent: null,
    messages: { fetch: async (o: string | { limit: number }) => (typeof o === 'string' ? messages.get(o) ?? Promise.reject(new Error('Unknown Message')) : messages) },
  });
  try {
    const page = await (await get('/admin/messages?channel=700000000000000001', cookie)).text();
    assert.match(page, /<h1>Messages<\/h1>/);
    assert.match(page, /@Rat Baron · old text/);
    assert.doesNotMatch(page, /a member wrote this/, 'a message someone else wrote cannot be edited, so it is not offered');

    assert.equal((await post('/admin/messages/edit', { channel: '700000000000000001', message: mine.id, content: 'x' }, cookie)).status, 403, 'needs the CSRF token');
    const saved = await post('/admin/messages/edit', { channel: '700000000000000001', message: mine.id, content: '@Rat Baron · Knowledgeable mentors', _csrf: 'csrf-token' }, cookie);
    assert.match(decodeURIComponent(saved.headers.get('location') ?? ''), /channel=700000000000000001/);
    assert.deepEqual(edits, [{ id: mine.id, content: '@Rat Baron · Knowledgeable mentors', allowedMentions: { parse: [] } }]);

    const refused = await post('/admin/messages/edit', { channel: '700000000000000001', message: theirs.id, content: 'hijack', _csrf: 'csrf-token' }, cookie);
    assert.match(decodeURIComponent((refused.headers.get('location') ?? '').replace(/[+]/g, ' ')), /only edit messages he wrote/);
    assert.equal(edits.length, 1);
    const empty = await post('/admin/messages/edit', { channel: '700000000000000001', message: mine.id, content: '   ', _csrf: 'csrf-token' }, cookie);
    assert.match(decodeURIComponent((empty.headers.get('location') ?? '').replace(/[+]/g, ' ')), /cannot be empty/);
  } finally {
    testChannels.delete('700000000000000001');
  }
});

test('the Events page offers an optional end time and shows it for a timed event', async () => {
  const { cookie } = sessionCookie(OWNER);
  const start = Date.now() + 3_600_000;
  store.createEvent({ guildId: GUILD, title: 'Timed weekend', description: null, startsAt: start, endsAt: start + 7_200_000, createdBy: 'u1' });
  const page = await (await get('/admin/events', cookie)).text();
  assert.match(page, /name="ends"/);
  assert.match(page, /Timed weekend/);
  assert.match(page, / → /, 'the table shows start to end');
  const bad = await post('/admin/events', { title: 'x', when: '2099-01-01T20:00', ends: 'soonish', _csrf: 'csrf-token' }, cookie);
  assert.match(decodeURIComponent((bad.headers.get('location') ?? '').replace(/[+]/g, ' ')), /Could not read the end time/);
});
