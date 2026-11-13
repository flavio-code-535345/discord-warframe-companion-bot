import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { SETTING_USES, checkSettings, lostSettings, reportDeletedChannel, reportDeletedRole } from '../src/discord/broken-settings.js';
import { postRolesPanel } from '../src/selfroles/service.js';

const G = '111111111111111111';

interface Notice {
  channel: string;
  title: string;
  description: string;
  fields: { name: string; value: string }[];
}

/** A bot with a real database and a guild whose channels can be there, gone, or out of reach. */
function world(opts: { cached?: string[]; unknown?: string[]; noAccess?: string[]; unreachable?: string[] } = {}) {
  const store = new Store(':memory:');
  const notices: Notice[] = [];
  const edits: string[] = [];
  const asked: string[] = [];
  let messages = 0;
  const channel = (id: string) => ({
    id,
    guildId: G,
    isSendable: () => true,
    send: async (payload: { embeds?: { toJSON(): Omit<Notice, 'channel'> }[] }) => {
      const embed = payload.embeds?.[0]?.toJSON();
      if (embed && 'title' in embed) notices.push({ channel: id, title: embed.title, description: embed.description, fields: embed.fields ?? [] });
      return { id: `m${++messages}`, channelId: id };
    },
    messages: { fetch: async (messageId: string) => ({ id: messageId, edit: async () => void edits.push(id) }), delete: async () => {} },
  });
  const guild = {
    id: G,
    channels: {
      cache: new Map((opts.cached ?? []).map((id) => [id, { id }])),
      fetch: async (id: string) => {
        asked.push(id);
        if (opts.unknown?.includes(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        if (opts.noAccess?.includes(id)) throw Object.assign(new Error('Missing Access'), { code: 50001 });
        throw new Error('fetch failed');
      },
    },
  };
  const client = {
    user: null,
    channels: {
      fetch: async (id: string) => {
        // A deleted channel can't be posted in either.
        if (opts.unknown?.includes(id) || opts.unreachable?.includes(id)) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
        return channel(id);
      },
    },
    guilds: { fetch: async () => guild },
  };
  const ctx = { config: { CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Cephalon Ordis', DISCORD_GUILD_ID: G }, client, store } as unknown as AppContext;
  return { ctx, store, notices, edits, asked };
}

const text = (id: string, name: string) => ({ id, name, guildId: G, isTextBased: () => true });

describe('a channel Ordis uses is deleted', () => {
  it('knows every setting that holds a channel or a category', () => {
    const settings = new Store(':memory:').getSettings(G);
    const inSettings = Object.keys(settings).filter((k) => /(ChannelId|CategoryId)$/.test(k)).sort();
    const known = SETTING_USES.map((u) => u.key as string).sort();
    assert.deepEqual(known, inSettings, 'a new channel setting needs a line in SETTING_USES');
    assert.equal(new Set(known).size, known.length);
    for (const use of SETTING_USES) assert.match(use.setup, /^\/setup [a-z]+$/, use.key);
  });

  it('clears the settings that pointed at it, tells the staff what is off and remembers it', async () => {
    const w = world();
    w.store.updateSettings(G, { statusChannelId: 'c-logs', alertsChannelId: 'c-alerts', newsChannelId: 'c-alerts', fissuresChannelId: 'c-fissures' });
    const lost = await reportDeletedChannel(w.ctx, text('c-alerts', 'alerts'));
    assert.deepEqual(lost.map((l) => l.key), ['alertsChannelId', 'newsChannelId']);
    const s = w.store.getSettings(G);
    assert.equal(s.alertsChannelId, null);
    assert.equal(s.newsChannelId, null);
    assert.equal(s.fissuresChannelId, 'c-fissures', 'another channel is none of its business');

    assert.equal(w.notices.length, 1);
    assert.equal(w.notices[0]!.channel, 'c-logs');
    assert.equal(w.notices[0]!.title, '⚠️ A channel Ordis used was deleted');
    assert.match(w.notices[0]!.description, /\*\*#alerts\*\* is gone\. What it was for is switched off until it gets a new channel/);
    assert.equal(w.notices[0]!.fields[0]!.value, '• the Alerts board: `/setup feed`\n• game news: `/setup news`');

    assert.deepEqual(lostSettings(w.ctx).map((l) => [l.key, l.name]), [['alertsChannelId', '#alerts'], ['newsChannelId', '#alerts']]);
    w.store.updateSettings(G, { alertsChannelId: 'c-new' });
    assert.deepEqual(lostSettings(w.ctx).map((l) => l.key), ['newsChannelId'], 'a setting with a channel again is no longer lost');
  });

  it('says nothing about a channel it does not use, or one of another server', async () => {
    const w = world();
    w.store.updateSettings(G, { statusChannelId: 'c-logs', alertsChannelId: 'c-alerts' });
    assert.deepEqual(await reportDeletedChannel(w.ctx, text('c-other', 'memes')), []);
    assert.deepEqual(await reportDeletedChannel(w.ctx, { id: 'c-alerts', name: 'alerts', guildId: '222222222222222222' }), []);
    assert.deepEqual(await reportDeletedChannel(w.ctx, { id: 'c-alerts', name: 'a DM' }), [], 'a DM channel has no server');
    assert.equal(w.store.getSettings(G).alertsChannelId, 'c-alerts');
    assert.deepEqual(w.notices, []);
    assert.deepEqual(lostSettings(w.ctx), []);
  });

  it('names a category without a hash, and posts in the moderation log when the status channel is the one that went', async () => {
    const w = world({ unreachable: ['c-status'] });
    w.store.updateSettings(G, { statusChannelId: 'c-status', modLogChannelId: 'c-mod', lfgVoiceCategoryId: 'cat' });
    await reportDeletedChannel(w.ctx, { id: 'cat', name: 'SQUAD VOICE', guildId: G, isTextBased: () => false });
    assert.match(w.notices[0]!.description, /\*\*SQUAD VOICE\*\* is gone/);
    assert.equal(w.notices[0]!.channel, 'c-mod', 'the status channel could not be posted in');

    await reportDeletedChannel(w.ctx, text('c-status', 'bot-status'));
    assert.equal(w.store.getSettings(G).statusChannelId, null);
    assert.equal(w.notices[1]!.channel, 'c-mod');
    assert.match(w.notices[1]!.fields[0]!.value, /the start and stop reports: `\/setup status`/);
  });

  it('at a start, finds what was deleted while it was offline, and only that', async () => {
    const w = world({ cached: ['c-alerts'], unknown: ['c-news'], noAccess: ['c-weekly'] });
    w.store.updateSettings(G, { statusChannelId: 'c-logs', alertsChannelId: 'c-alerts', newsChannelId: 'c-news', weeklyChannelId: 'c-weekly', promoChannelId: 'c-promo' });
    const lost = await checkSettings(w.ctx);
    assert.deepEqual(lost.map((l) => l.key), ['newsChannelId']);
    assert.deepEqual(w.asked.sort(), ['c-logs', 'c-news', 'c-promo', 'c-weekly'], 'a channel in the cache is not asked for');
    const s = w.store.getSettings(G);
    assert.equal(s.newsChannelId, null);
    assert.equal(s.weeklyChannelId, 'c-weekly', 'no access is not the same as deleted');
    assert.equal(s.promoChannelId, 'c-promo', 'neither is a request that failed');
    assert.equal(s.statusChannelId, 'c-logs');
    assert.match(w.notices[0]!.description, /\*\*channel c-news\*\* is gone \(deleted while Ordis was offline\)/);

    assert.deepEqual(await checkSettings(w.ctx), [], 'the next start has nothing new to say');
    assert.equal(w.notices.length, 1);
  });

  it('forgets a record it cannot read', () => {
    const w = world();
    w.store.setMeta('settings_lost', '{not json');
    assert.deepEqual(lostSettings(w.ctx), []);
    w.store.setMeta('settings_lost', JSON.stringify([{ key: 'constructor', name: 'x', at: 1 }, null, { key: 'newsChannelId', name: '#news', at: 5 }]));
    assert.deepEqual(lostSettings(w.ctx).map((l) => [l.key, l.what, l.name]), [['newsChannelId', 'game news', '#news']]);
  });
});

describe('a role Ordis uses is deleted', () => {
  const role = (id: string, name: string, guildId = G) => ({ id, name, guild: { id: guildId } });

  it('takes a self-assign role out of the menu and redraws the panel', async () => {
    const w = world();
    w.store.updateSettings(G, { modLogChannelId: 'c-mod' });
    w.store.upsertSelfRole(G, { roleId: 'r-pc', group: 'Platform', label: 'PC', emoji: null, description: null, position: 0 });
    w.store.upsertSelfRole(G, { roleId: 'r-xbox', group: 'Platform', label: 'Xbox', emoji: null, description: null, position: 1 });
    await postRolesPanel(w.ctx, 'c-roles');
    const effects = await reportDeletedRole(w.ctx, role('r-xbox', 'Xbox'));
    assert.equal(effects.length, 1);
    assert.deepEqual(w.store.listSelfRoles(G).map((r) => r.roleId), ['r-pc']);
    assert.deepEqual(w.edits, ['c-roles']);
    // The panel itself was posted in c-roles; what the staff are told goes to their channel.
    const notice = w.notices.find((n) => n.channel === 'c-mod')!;
    assert.equal(notice.title, '⚠️ A role Ordis used was deleted');
    assert.match(notice.description, /The role \*\*Xbox\*\* is gone/);
    assert.match(notice.fields[0]!.value, /self-assign menu/);
  });

  it('says so when leveling or the screenshot roles handed it out, and nothing for any other role', async () => {
    const w = world();
    w.store.updateSettings(G, { modLogChannelId: 'c-mod' });
    assert.match((await reportDeletedRole(w.ctx, role('r1', 'Level 10+')))[0]!, /Leveling handed it out/);
    assert.match((await reportDeletedRole(w.ctx, role('r2', 'MR 16')))[0]!, /screenshot roles handed it out/);
    assert.deepEqual(await reportDeletedRole(w.ctx, role('r3', 'Movie night')), []);
    assert.deepEqual(await reportDeletedRole(w.ctx, role('r4', 'Level 10+', '222222222222222222')), [], 'another server');
    assert.equal(w.notices.length, 2);
  });
});
