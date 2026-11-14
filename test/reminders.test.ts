import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { UserError } from '../src/errors.js';
import { parseLength, parseReminderTime } from '../src/reminders/parse.js';
import { MAX_PENDING, addReminder, cancelReminder, neutralise, remindersJob } from '../src/reminders/service.js';

const G = '111111111111111111';
const U = '222222222222222222';
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0); // Sat 2026-11-14 12:00 UTC

describe('reminder time parser', () => {
  it('reads lengths', () => {
    assert.equal(parseLength('2h'), 2 * HOUR);
    assert.equal(parseLength('3 days'), 3 * DAY);
    assert.equal(parseLength('1w 2d'), 9 * DAY);
    assert.equal(parseLength('1 hour 30 min'), 90 * MIN);
    assert.equal(parseLength('2 weeks and 3 days'), 17 * DAY);
    assert.equal(parseLength('soon'), null);
  });

  it('counts relative times from now, with or without "in"', () => {
    assert.equal(parseReminderTime('in 90 minutes', NOW, 'UTC'), NOW + 90 * MIN);
    assert.equal(parseReminderTime('2h', NOW, 'UTC'), NOW + 2 * HOUR);
  });

  it('reads absolute dates in the clan zone', () => {
    assert.equal(parseReminderTime('2026-12-01 18:00', NOW, 'UTC'), Date.UTC(2026, 11, 1, 18));
    // Berlin is UTC+1 in winter and UTC+2 in summer
    assert.equal(parseReminderTime('2026-12-01 18:00', NOW, 'Europe/Berlin'), Date.UTC(2026, 11, 1, 17));
    assert.equal(parseReminderTime('2027-07-01 18:00', NOW, 'Europe/Berlin'), Date.UTC(2027, 6, 1, 16));
  });

  it('keeps an explicit zone as written', () => {
    assert.equal(parseReminderTime('2026-12-01T18:00:00Z', NOW, 'Europe/Berlin'), Date.UTC(2026, 11, 1, 18));
  });

  it('reads tomorrow and a time of day', () => {
    assert.equal(parseReminderTime('tomorrow 9am', NOW, 'UTC'), Date.UTC(2026, 10, 15, 9));
    assert.equal(parseReminderTime('tomorrow 18:30', NOW, 'UTC'), Date.UTC(2026, 10, 15, 18, 30));
    assert.equal(parseReminderTime('tomorrow', NOW, 'UTC'), Date.UTC(2026, 10, 15, 9));
  });

  it('a bare time of day is the next one', () => {
    assert.equal(parseReminderTime('18:00', NOW, 'UTC'), Date.UTC(2026, 10, 14, 18));
    assert.equal(parseReminderTime('9am', NOW, 'UTC'), Date.UTC(2026, 10, 15, 9));
  });

  it('rejects nonsense and impossible dates', () => {
    assert.equal(parseReminderTime('', NOW, 'UTC'), null);
    assert.equal(parseReminderTime('whenever', NOW, 'UTC'), null);
    assert.equal(parseReminderTime('5', NOW, 'UTC'), null);
    assert.equal(parseReminderTime('2026-02-31 10:00', NOW, 'UTC'), null);
    assert.equal(parseReminderTime('x'.repeat(100), NOW, 'UTC'), null);
  });
});

describe('neutralise', () => {
  it('breaks every mention', () => {
    for (const s of ['@everyone', '@here', '<@123>', '<@!123>', '<@&123>', '<#123>']) {
      const out = neutralise(`hi ${s}`);
      assert.notEqual(out, `hi ${s}`);
      assert.ok(!/@everyone|@here|<@!?&?\d+>|<#\d+>/.test(out), out);
    }
  });
});

interface Sent {
  to: string;
  content: string;
  allowedMentions: unknown;
}

function setup(opts: { dm?: 'ok' | 'closed' | 'fail'; channel?: boolean } = {}) {
  const store = new Store(':memory:');
  const dms: Sent[] = [];
  const posts: Sent[] = [];
  const channel = {
    id: 'c1',
    guildId: G,
    isSendable: () => true,
    isTextBased: () => true,
    send: async (p: { content: string; allowedMentions: unknown }) => {
      posts.push({ to: 'c1', content: p.content, allowedMentions: p.allowedMentions });
    },
  };
  const ctx = {
    config: { DISCORD_GUILD_ID: G, CLAN_TIMEZONE: 'UTC' },
    store,
    client: {
      users: {
        fetch: async (id: string) => ({
          send: async (p: { content: string; allowedMentions: unknown }) => {
            if (opts.dm === 'closed') throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
            if (opts.dm === 'fail') throw new Error('boom');
            dms.push({ to: id, content: p.content, allowedMentions: p.allowedMentions });
          },
        }),
      },
      channels: { fetch: async () => (opts.channel === false ? null : channel), cache: { get: () => (opts.channel === false ? undefined : channel) } },
      guilds: { cache: { get: () => ({ id: G, channels: { fetch: async () => channel, cache: { get: () => channel } } }) } },
    },
  } as unknown as AppContext;
  return { ctx, store, dms, posts };
}

const add = (ctx: AppContext, when = '2h', message = 'feed the cat', now = NOW) => addReminder(ctx, { userId: U, channelId: 'c1', when, message }, now);

describe('addReminder limits', () => {
  it('stores a reminder with epoch ms', () => {
    const { ctx, store } = setup();
    const r = add(ctx);
    assert.equal(r.dueAt, NOW + 2 * HOUR);
    assert.equal(store.listReminders(G, U).length, 1);
  });

  it('refuses too soon, in the past, too far and unreadable times', () => {
    const { ctx } = setup();
    assert.throws(() => add(ctx, '30s'), UserError);
    assert.throws(() => add(ctx, '2026-11-01 10:00'), /passed/);
    assert.throws(() => add(ctx, '800 days'), /2 years/);
    assert.throws(() => add(ctx, 'someday'), /could not read/);
    add(ctx, '700 days');
  });

  it('refuses an empty or long message', () => {
    const { ctx } = setup();
    assert.throws(() => add(ctx, '2h', '   '), UserError);
    assert.throws(() => add(ctx, '2h', 'x'.repeat(301)), UserError);
  });

  it('caps the pending reminders per member', () => {
    const { ctx } = setup();
    for (let i = 0; i < MAX_PENDING; i++) add(ctx);
    assert.throws(() => add(ctx), /already have/);
    // another member is not affected
    addReminder(ctx, { userId: '333', channelId: null, when: '2h', message: 'x' }, NOW);
  });
});

describe('cancelReminder', () => {
  it('only the owner can cancel', () => {
    const { ctx, store } = setup();
    const r = add(ctx);
    assert.throws(() => cancelReminder(ctx, '999', r.id), UserError);
    assert.equal(store.listReminders(G, U).length, 1);
    cancelReminder(ctx, U, r.id);
    assert.equal(store.listReminders(G, U).length, 0);
    assert.throws(() => cancelReminder(ctx, U, r.id), UserError);
  });
});

describe('reminders job', () => {
  it('sends what is due, once, and leaves the rest', async () => {
    const { ctx, store, dms } = setup();
    add(ctx, '2h', 'soon');
    add(ctx, '3 days', 'later');
    await remindersJob(ctx, NOW + 2 * HOUR + 10_000);
    assert.equal(dms.length, 1);
    assert.equal(dms[0]!.to, U);
    assert.match(dms[0]!.content, /soon/);
    assert.doesNotMatch(dms[0]!.content, /late/);
    assert.deepEqual(dms[0]!.allowedMentions, { parse: [] });
    assert.equal(store.listReminders(G, U).length, 1);
    await remindersJob(ctx, NOW + 2 * HOUR + 40_000);
    assert.equal(dms.length, 1, 'not delivered twice');
  });

  it('says so when it is late after downtime', async () => {
    const { ctx, dms } = setup();
    add(ctx, '2h', 'old one');
    await remindersJob(ctx, NOW + 2 * HOUR + 3 * HOUR);
    assert.equal(dms.length, 1);
    assert.match(dms[0]!.content, /sorry, I am late/);
  });

  it('neutralises mentions in the text', async () => {
    const { ctx, dms } = setup();
    add(ctx, '2h', 'hey @everyone');
    await remindersJob(ctx, NOW + 2 * HOUR);
    assert.ok(!dms[0]!.content.includes('@everyone'));
  });

  it('answers in the channel pinging only the member when DMs are closed, then drops it', async () => {
    const { ctx, store, posts } = setup({ dm: 'closed' });
    add(ctx);
    await remindersJob(ctx, NOW + 2 * HOUR);
    assert.equal(posts.length, 1);
    assert.match(posts[0]!.content, new RegExp(`^<@${U}>`));
    assert.deepEqual(posts[0]!.allowedMentions, { users: [U] });
    assert.equal(store.listReminders(G, U).length, 0);
  });

  it('drops it when DMs are closed and there is no channel', async () => {
    const { ctx, store, posts } = setup({ dm: 'closed' });
    addReminder(ctx, { userId: U, channelId: null, when: '2h', message: 'x' }, NOW);
    await remindersJob(ctx, NOW + 2 * HOUR);
    assert.equal(posts.length, 0);
    assert.equal(store.listReminders(G, U).length, 0);
  });

  it('retries a failing DM up to three times, then gives up', async () => {
    const { ctx, store } = setup({ dm: 'fail', channel: false });
    add(ctx);
    const t = NOW + 2 * HOUR;
    await remindersJob(ctx, t);
    assert.equal(store.listReminders(G, U).length, 1);
    await remindersJob(ctx, t + 30_000);
    assert.equal(store.listReminders(G, U).length, 1);
    await remindersJob(ctx, t + 60_000);
    assert.equal(store.listReminders(G, U).length, 0);
  });
});
