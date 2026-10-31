import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { ENV_ONLY, SETTINGS, adoptEnvironment, initRuntimeConfig, onSettingChange, parseSetting, resetRuntimeConfig, resetSetting, setSetting, settingStates } from '../src/runtime-config.js';

afterEach(() => resetRuntimeConfig());

const env = { DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: '1', SEARXNG_URL: 'http://searx:8888', LOCAL_AI_URL: 'http://ollama:11434/v1', ENABLE_MESSAGE_CONTENT: 'true' };
const setup = (extra: Record<string, string> = {}) => {
  const e = { ...env, ...extra };
  return { env: e, config: loadConfig(e), store: new Store(':memory:') };
};
const state = (s: ReturnType<typeof setup>, key: string) => settingStates(s.config, s.store, s.env).find((x) => x.def.key === key)!;

describe('runtime settings', () => {
  it('start from the environment, report where each value comes from, and a panel value wins', () => {
    const s = setup();
    initRuntimeConfig(s.config, s.store);
    assert.equal(state(s, 'SEARXNG_URL').source, 'environment');
    assert.equal(state(s, 'WORLDSTATE_POLL_SECONDS').source, 'default');
    assert.equal(s.config.WORLDSTATE_ENABLED, false);

    assert.equal(setSetting(s.config, s.store, 'WORLDSTATE_ENABLED', 'true'), null);
    assert.equal(s.config.WORLDSTATE_ENABLED, true);
    assert.equal(setSetting(s.config, s.store, 'SEARXNG_URL', 'http://other:8888'), null);
    assert.equal(s.config.SEARXNG_URL, 'http://other:8888');
    assert.equal(state(s, 'SEARXNG_URL').source, 'panel');
    assert.equal(state(s, 'SEARXNG_URL').fallback, 'http://searx:8888');
    assert.equal(s.store.getMeta('cfg_SEARXNG_URL'), 'v:http://other:8888');
  });

  it('survives a restart: the stored value is applied on top of the environment again', () => {
    const s = setup();
    initRuntimeConfig(s.config, s.store);
    setSetting(s.config, s.store, 'RIVEN_CRAWL_INTERVAL_SECONDS', '120');
    setSetting(s.config, s.store, 'OPERATOR_IDS', '603293720061935626, 220147375786688512');
    resetRuntimeConfig();
    const again = { config: loadConfig(s.env), store: s.store, env: s.env };
    initRuntimeConfig(again.config, again.store);
    assert.equal(again.config.RIVEN_CRAWL_INTERVAL_SECONDS, 120);
    assert.deepEqual(again.config.OPERATOR_IDS, ['603293720061935626', '220147375786688512']);
  });

  it('clearing a value returns to the default; clearing an optional one switches it off even when the environment sets it', () => {
    const s = setup();
    initRuntimeConfig(s.config, s.store);
    setSetting(s.config, s.store, 'WORLDSTATE_POLL_SECONDS', '900');
    assert.equal(s.config.WORLDSTATE_POLL_SECONDS, 900);
    setSetting(s.config, s.store, 'WORLDSTATE_POLL_SECONDS', '');
    assert.equal(s.config.WORLDSTATE_POLL_SECONDS, 600);
    assert.equal(state(s, 'WORLDSTATE_POLL_SECONDS').source, 'default');

    setSetting(s.config, s.store, 'SEARXNG_URL', '');
    assert.equal(s.config.SEARXNG_URL, undefined, 'explicitly off');
    assert.equal(state(s, 'SEARXNG_URL').source, 'panel');
    resetSetting(s.config, s.store, 'SEARXNG_URL');
    assert.equal(s.config.SEARXNG_URL, 'http://searx:8888', 'back to the environment');
  });

  it('refuses values the environment would refuse, and unknown settings', () => {
    const s = setup();
    initRuntimeConfig(s.config, s.store);
    assert.match(setSetting(s.config, s.store, 'WORLDSTATE_POLL_SECONDS', '5')!, /Number must be|too small|>=|60/i);
    assert.match(setSetting(s.config, s.store, 'LOCAL_AI_URL', 'not a url')!, /Ollama URL/);
    assert.match(setSetting(s.config, s.store, 'WARFRAME_PLATFORM', 'gameboy')!, /Platform/);
    assert.equal(setSetting(s.config, s.store, 'DISCORD_TOKEN', 'x'), 'Unknown setting.');
    assert.equal(setSetting(s.config, s.store, 'MCP_AUTH_TOKEN', 'y'.repeat(30)), 'Unknown setting.');
    assert.equal(s.config.WORLDSTATE_POLL_SECONDS, 600);
    assert.equal(s.store.getMeta('cfg_WORLDSTATE_POLL_SECONDS'), null, 'nothing was stored');
    assert.equal(parseSetting('WARFRAME_PLATFORM', 'ps4').ok, true);
  });

  it('tells the app when something changed, and flags settings that need a restart', () => {
    const s = setup();
    initRuntimeConfig(s.config, s.store);
    const seen: string[] = [];
    onSettingChange((k) => seen.push(k));
    setSetting(s.config, s.store, 'WORLDSTATE_URL', 'http://relay:8080/worldState.php');
    resetSetting(s.config, s.store, 'WORLDSTATE_URL');
    assert.deepEqual(seen, ['WORLDSTATE_URL', 'WORLDSTATE_URL']);

    assert.equal(state(s, 'ENABLE_WELCOME').pendingRestart, false);
    setSetting(s.config, s.store, 'ENABLE_WELCOME', 'true');
    assert.equal(state(s, 'ENABLE_WELCOME').pendingRestart, true);
    assert.equal(state(s, 'ENABLE_MESSAGE_CONTENT').pendingRestart, false, 'unchanged');
    setSetting(s.config, s.store, 'ENABLE_WELCOME', 'false');
    assert.equal(state(s, 'ENABLE_WELCOME').pendingRestart, false, 'back to what is running');
  });

  it('copies only the values the environment sets, so those variables can be removed', () => {
    const s = setup();
    initRuntimeConfig(s.config, s.store);
    setSetting(s.config, s.store, 'ENABLE_MESSAGE_CONTENT', 'false');
    const adopted = adoptEnvironment(s.config, s.store, s.env);
    assert.deepEqual(adopted.sort(), ['LOCAL_AI_URL', 'SEARXNG_URL']);
    assert.equal(state(s, 'SEARXNG_URL').source, 'panel');
    assert.equal(s.store.getMeta('cfg_SEARXNG_URL'), 'v:http://searx:8888');
    assert.deepEqual(adoptEnvironment(s.config, s.store, s.env), [], 'nothing left to copy');
  });

  it('covers no secret and no setting the panel login or the network binding depends on', () => {
    const covered = new Set<string>(SETTINGS.map((x) => x.key));
    for (const name of ['DISCORD_TOKEN', 'FREE_AI_KEY', 'LOCAL_AI_KEY', 'MCP_AUTH_TOKEN', 'WATCHTOWER_TOKEN', 'DISCORD_CLIENT_SECRET', 'PUBLIC_URL', 'PANEL_OWNER_IDS', 'HTTP_PORT', 'HTTP_HOST', 'DATA_DIR', 'DISCORD_GUILD_ID', 'ALLOW_CODE_EDIT', 'MCP_ALLOWED_HOSTS', 'WATCHTOWER_URL']) {
      assert.ok(!covered.has(name), `${name} must stay environment-only`);
    }
    assert.ok(ENV_ONLY.flatMap((o) => o.names).includes('ALLOW_CODE_EDIT'));
    assert.ok(SETTINGS.find((x) => x.key === 'OPERATOR_IDS')!.ownerOnly);
  });
});
