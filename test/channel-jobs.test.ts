import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChannelType } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { registerAdminTools } from '../src/mcp/admin.js';
import { UserError, assertChannelFree } from '../src/services/clan.js';

const GUILD = '111111111111111111';
const config = loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD });

const storeWith = (settings: Parameters<Store['updateSettings']>[1] = {}) => {
  const store = new Store(':memory:');
  store.updateSettings(GUILD, settings);
  return { config, store };
};

describe('one message-reading job per channel', () => {
  it('refuses a channel that already has another job, and says which', () => {
    const ctx = storeWith({ ssRolesChannelId: 'ss', chatChannelId: 'chat' });
    assert.throws(() => assertChannelFree(ctx, { rivenChannelId: 'ss' }), (err) => err instanceof UserError && /screenshot roles.*riven scanning/.test(err.message));
    assert.throws(() => assertChannelFree(ctx, { honeypotChannelId: 'chat' }), /the Ordis chat/);
    assert.throws(() => assertChannelFree(ctx, { verifyChannelId: 'ss' }), /screenshot roles/);
    assert.throws(() => assertChannelFree(ctx, { chatChannelId: 'ss' }), /screenshot roles/);
  });

  it('lets a free channel through, and turning a job off or leaving it alone', () => {
    const ctx = storeWith({ ssRolesChannelId: 'ss' });
    assertChannelFree(ctx, { rivenChannelId: 'rivens' });
    assertChannelFree(ctx, { rivenChannelId: null, chatChannelId: undefined });
    assertChannelFree(ctx, { ssRolesChannelId: 'ss' }); // the job it already has
    assertChannelFree(ctx, {});
  });

  it('checks the whole change at once (two jobs moving onto one channel)', () => {
    const ctx = storeWith();
    assert.throws(() => assertChannelFree(ctx, { chatChannelId: 'same', honeypotChannelId: 'same' }), UserError);
  });

  it('does not let an old clash block an unrelated edit', () => {
    const ctx = storeWith({ chatChannelId: 'both', rivenChannelId: 'both' });
    assertChannelFree(ctx, { chatChannelId: 'both' });
    assertChannelFree(ctx, { ssRolesChannelId: 'elsewhere' });
  });
});

describe('update_bot_settings', () => {
  const TEXT = '200000000000000001';
  const TEXT2 = '200000000000000002';
  const VOICE = '200000000000000003';
  const CATEGORY = '200000000000000004';

  function setup(settings: Parameters<Store['updateSettings']>[1] = {}) {
    const store = new Store(':memory:');
    store.updateSettings(GUILD, settings);
    const channels = new Map([
      [TEXT, { id: TEXT, name: 'chat', type: ChannelType.GuildText }],
      [TEXT2, { id: TEXT2, name: 'alerts', type: ChannelType.GuildText }],
      [VOICE, { id: VOICE, name: 'lobby', type: ChannelType.GuildVoice }],
      [CATEGORY, { id: CATEGORY, name: 'squads', type: ChannelType.GuildCategory }],
    ]);
    const guild = {
      id: GUILD,
      channels: { cache: channels, fetch: async () => channels },
      roles: { cache: new Map(), fetch: async () => new Map() },
      members: { fetchMe: async () => ({ permissions: { has: () => true }, roles: { highest: { position: 10 } } }) },
    };
    const client = { guilds: { fetch: async () => guild } };
    const ctx = { config, store, client, ai: null } as unknown as AppContext;
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>>();
    registerAdminTools({ registerTool: (name: string, _meta: unknown, handler: never) => void handlers.set(name, handler) } as unknown as McpServer, ctx);
    const call = (args: Record<string, unknown>) => handlers.get('update_bot_settings')!(args);
    return { store, call };
  }

  it('refuses a channel of the wrong kind and saves nothing', async () => {
    const t = setup();
    const res = await t.call({ alerts_channel_id: TEXT2, chat_channel_id: VOICE });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /chat_channel_id: lobby is the wrong kind of channel.*text channel/);
    assert.equal(t.store.getSettings(GUILD).alertsChannelId, null, 'the valid half is not applied either');
    assert.equal((await t.call({ lfg_voice_category_id: TEXT })).isError, true);
    assert.equal((await t.call({ auto_vc_hub_channel_id: CATEGORY })).isError, true);
  });

  it('accepts the right kinds', async () => {
    const t = setup();
    const res = await t.call({ chat_channel_id: TEXT, lfg_voice_category_id: CATEGORY, auto_vc_hub_channel_id: VOICE });
    assert.equal(res.isError, undefined);
    const s = t.store.getSettings(GUILD);
    assert.deepEqual([s.chatChannelId, s.lfgVoiceCategoryId, s.autoVcHubChannelId], [TEXT, CATEGORY, VOICE]);
  });

  it('refuses a channel that already has another job before saving any part of the change', async () => {
    const t = setup({ ssRolesChannelId: TEXT });
    const res = await t.call({ alerts_channel_id: TEXT2, chat_channel_id: TEXT });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /already used for screenshot roles/);
    assert.equal(t.store.getSettings(GUILD).alertsChannelId, null);
    assert.equal(t.store.getSettings(GUILD).chatChannelId, null);
  });
});
