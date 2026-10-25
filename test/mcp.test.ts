import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { startHttpServer } from '../src/http.js';

const TOKEN = 'test-token-test-token-test-token';
const GUILD = '111111111111111111';

let baseUrl = '';
let close: () => void = () => {};
let store: Store;

before(async () => {
  const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD, MCP_AUTH_TOKEN: TOKEN, HTTP_HOST: '127.0.0.1', HTTP_PORT: '1' });
  store = new Store(':memory:');
  // Only the store-backed tools are exercised here, so a minimal Discord client stub is enough.
  const client = { isReady: () => false } as unknown as Client;
  const ctx: AppContext = { config: { ...config, HTTP_PORT: 0 }, store, client, ai: null };
  const server = startHttpServer(ctx);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});

after(() => close());

async function connect(token: string) {
  const client = new McpClient({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

test('health endpoint reports Discord readiness without auth', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { status: 'starting', discord: false });
});

test('logo is served as a PNG', async () => {
  const res = await fetch(`${baseUrl}/logo.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('MCP rejects missing or wrong bearer tokens', async () => {
  const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  await assert.rejects(connect('wrong-token-wrong-token-wrong'));
});

test('MCP lists tools and serves clan data', async () => {
  const client = await connect(TOKEN);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of ['get_worldstate', 'get_fissures', 'price_check', 'search_drops', 'lookup_item', 'search_wiki', 'create_event', 'send_announcement', 'list_events']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }

  store.createEvent({ guildId: GUILD, title: 'Eidolon hunt', description: null, startsAt: Date.now() + 3_600_000, createdBy: 'u1' });
  const result = await client.callTool({ name: 'list_events', arguments: {} });
  const content = result.content as { type: string; text: string }[];
  const events = JSON.parse(content[0]!.text) as { title: string }[];
  assert.deepEqual(events.map((e) => e.title), ['Eidolon hunt']);

  const bad = await client.callTool({ name: 'cancel_event', arguments: { event_id: 999 } });
  assert.equal(bad.isError, true);
  await client.close();
});
