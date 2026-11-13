import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { nextOccurrence, repeatEvents, resetEventRepeat } from '../src/discord/event-repeat.js';
import { REPEAT_DAYS, UserError, cancelClanEvent, createClanEvent, newestRound, repeatText, setClanEventRepeat, whenText } from '../src/services/clan.js';
import { addDaysInZone, validTimeZone } from '../src/time.js';

const GUILD = '111111111111111111';
const EVENTS = '222222222222222222';
const ANNOUNCE = '333333333333333333';
const LOGS = '444444444444444444';
const HOUR = 3_600_000;
const DAY = 86_400_000;

interface Sent {
  channel: string;
  title: string;
  when: string;
  buttons: number;
}

/** A bot with a real database and channels that record what is posted in them; `gone` channels cannot be fetched, `mute` ones refuse a post. */
function setup(opts: { zone?: string } = {}) {
  const sent: Sent[] = [];
  const notices: { channel: string; title: string; text: string }[] = [];
  const gone = new Set<string>();
  const mute = new Set<string>();
  let messages = 0;
  const channel = (id: string) => ({
    id,
    guildId: GUILD,
    isSendable: () => true,
    send: async (o: { embeds: { data?: { title?: string; description?: string; fields?: { name: string; value: string }[] }; toJSON?(): { title?: string; description?: string } }[]; components?: unknown[] }) => {
      if (mute.has(id)) throw new Error('Missing Permissions');
      const embed = o.embeds[0]!;
      if (id === LOGS) {
        const json = embed.toJSON!();
        notices.push({ channel: id, title: json.title ?? '', text: json.description ?? '' });
      } else {
        sent.push({ channel: id, title: embed.data?.title ?? '', when: embed.data?.fields?.find((f) => f.name === 'When')?.value ?? '', buttons: o.components?.length ?? 0 });
      }
      return { id: `m${++messages}`, edit: async () => {} };
    },
    messages: { fetch: async (messageId: string) => ({ id: messageId, edit: async () => {} }) },
  });
  const ctx: AppContext = {
    config: { ...loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }), CLAN_TIMEZONE: opts.zone ?? 'UTC' },
    store: new Store(':memory:'),
    client: {
      isReady: () => false,
      user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' },
      channels: { fetch: async (id: string) => (gone.has(id) ? Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 })) : channel(id)) },
    } as unknown as Client,
  };
  ctx.store.updateSettings(GUILD, { announcementsChannelId: ANNOUNCE, statusChannelId: LOGS });
  /** A weekly event that started two hours ago, as the database would hold it. */
  const past = (over: Partial<Parameters<Store['createEvent']>[0]> = {}) => {
    const event = ctx.store.createEvent({ guildId: GUILD, title: 'Clan night', description: 'Bring relics', startsAt: Date.now() - 2 * HOUR, createdBy: 'u1', repeatDays: 7, ...over });
    ctx.store.setEventMessage(event.id, EVENTS, 'old');
    return ctx.store.getEvent(event.id)!;
  };
  return { ctx, sent, notices, gone, mute, past };
}

beforeEach(() => resetEventRepeat());

describe('the same time of day, some days later', () => {
  it('keeps the wall clock of a time zone through a clock change', () => {
    assert.equal(validTimeZone('Europe/Berlin'), true);
    assert.equal(validTimeZone('UTC'), true);
    assert.equal(validTimeZone('Mars/Olympus'), false);
    assert.equal(validTimeZone(''), false);

    // 20:00 in Berlin is 18:00 UTC in summer and 19:00 UTC in winter; the clocks go back on 25 October 2026.
    const summer = Date.UTC(2026, 9, 20, 18, 0);
    assert.equal(addDaysInZone(summer, 7, 'Europe/Berlin'), Date.UTC(2026, 9, 27, 19, 0));
    assert.equal(addDaysInZone(summer, 7, 'UTC'), Date.UTC(2026, 9, 27, 18, 0));
    assert.equal(addDaysInZone(summer, 7, 'Mars/Olympus'), Date.UTC(2026, 9, 27, 18, 0), 'an unknown zone counts as UTC');
    // And forward on 28 March 2027.
    const winter = Date.UTC(2027, 2, 25, 19, 0);
    assert.equal(addDaysInZone(winter, 7, 'Europe/Berlin'), Date.UTC(2027, 3, 1, 18, 0));
    assert.equal(addDaysInZone(winter, 1, 'Europe/Berlin'), Date.UTC(2027, 2, 26, 19, 0));
    assert.equal(addDaysInZone(summer + 1234, 14, 'Europe/Berlin'), Date.UTC(2026, 10, 3, 19, 0) + 1234, 'seconds and milliseconds stay');
    assert.equal(addDaysInZone(Date.UTC(2026, 10, 1, 1, 0), 28, 'America/New_York'), Date.UTC(2026, 10, 29, 2, 0), '21:00 in New York before and after its own change');
  });

  it('finds the next round from the first start, past whatever was missed', () => {
    const first = Date.UTC(2026, 9, 6, 18, 0); // a Tuesday, 20:00 in Berlin
    const zone = 'Europe/Berlin';
    assert.equal(nextOccurrence(first, first, 7, zone, first + 2 * HOUR), Date.UTC(2026, 9, 13, 18, 0));
    assert.equal(nextOccurrence(first, Date.UTC(2026, 9, 20, 18, 0), 7, zone, Date.UTC(2026, 9, 20, 20, 0)), Date.UTC(2026, 9, 27, 19, 0), 'the round after the clock change');
    assert.equal(nextOccurrence(first, Date.UTC(2026, 9, 27, 19, 0), 7, zone, Date.UTC(2026, 9, 27, 21, 0)), Date.UTC(2026, 10, 3, 19, 0));
    // Ordis was off for a month: the rounds in between are not posted late.
    assert.equal(nextOccurrence(first, Date.UTC(2026, 9, 13, 18, 0), 7, zone, Date.UTC(2026, 10, 12, 9, 0)), Date.UTC(2026, 10, 17, 19, 0));
    // A round that was an hour off does not shift the ones after it.
    assert.equal(nextOccurrence(first, Date.UTC(2026, 9, 13, 19, 0), 7, zone, Date.UTC(2026, 9, 13, 21, 0)), Date.UTC(2026, 9, 20, 18, 0));
    assert.equal(nextOccurrence(first, first, 1, 'UTC', first + 3 * DAY + HOUR), first + 4 * DAY);
    assert.equal(nextOccurrence(first, first, 28, 'UTC', first + HOUR), first + 28 * DAY);
  });
});

describe('repeating events', () => {
  it('stores how often an event repeats and which series a round belongs to', () => {
    const store = new Store(':memory:');
    const once = store.createEvent({ guildId: GUILD, title: 'Hunt', description: null, startsAt: 1, createdBy: 'u' });
    assert.deepEqual([once.repeatDays, once.seriesId, once.nextId], [null, null, null]);
    const first = store.createEvent({ guildId: GUILD, title: 'Night', description: null, startsAt: 2, createdBy: 'u', repeatDays: 7 });
    assert.deepEqual([first.repeatDays, first.seriesId, first.nextId], [7, first.id, null]);
    const second = store.createEvent({ guildId: GUILD, title: 'Night', description: null, startsAt: 3, createdBy: 'u', repeatDays: 7, after: first });
    assert.equal(second.seriesId, first.id);
    assert.equal(store.getEvent(first.id)!.nextId, second.id);
    const third = store.createEvent({ guildId: GUILD, title: 'Night', description: null, startsAt: 4, createdBy: 'u', repeatDays: 7, after: second });
    assert.equal(third.seriesId, first.id, 'every round names the first one');

    store.setRsvp(third.id, 'u2', 'going');
    store.deleteEvent(third.id);
    assert.equal(store.getEvent(third.id), null);
    assert.equal(store.getEvent(second.id)!.nextId, null, 'the round before is free to be followed again');
    assert.deepEqual(store.getRsvps(third.id), { going: [], maybe: [], declined: [] });

    store.setEventRepeat(once.id, 14);
    assert.deepEqual([store.getEvent(once.id)!.repeatDays, store.getEvent(once.id)!.seriesId], [14, once.id], 'an event that starts repeating is the first of its series');
    store.setEventRepeat(second.id, null);
    assert.deepEqual([store.getEvent(second.id)!.repeatDays, store.getEvent(second.id)!.seriesId], [null, first.id]);
  });

  it('knows which events are due for their next round', () => {
    const store = new Store(':memory:');
    const now = Date.UTC(2026, 10, 13, 12, 0);
    const mk = (title: string, e: Partial<Parameters<Store['createEvent']>[0]>) => store.createEvent({ guildId: GUILD, title, description: null, startsAt: now - 2 * HOUR, createdBy: 'u', repeatDays: 7, ...e });
    mk('over, no end', {});
    mk('started 30 min ago', { startsAt: now - HOUR / 2 });
    mk('ended', { startsAt: now - 3 * HOUR, endsAt: now - HOUR });
    mk('still running', { startsAt: now - HOUR * 5, endsAt: now + HOUR });
    mk('once', { repeatDays: null });
    mk('other server', { guildId: '999999999999999999' });
    const cancelled = mk('cancelled round', {});
    store.cancelEvent(cancelled.id);
    const followed = mk('already followed', {});
    mk('its next round', { startsAt: now + 7 * DAY, after: followed });
    assert.deepEqual(store.eventsDueToRepeat(GUILD, now).map((e) => e.title).sort(), ['cancelled round', 'ended', 'over, no end']);
  });

  it('says on the post how often it repeats, and refuses a rhythm that does not fit', async () => {
    const { ctx, sent } = setup();
    assert.deepEqual(REPEAT_DAYS.map((d) => repeatText(d)), ['every day', 'every week', 'every 2 weeks', 'every 4 weeks']);
    assert.equal(repeatText(3), '');
    assert.equal(repeatText(null), '');
    assert.match(whenText({ startsAt: Date.now() + HOUR, endsAt: null, repeatDays: 7 }), /\n🔁 Repeats every week$/);
    assert.doesNotMatch(whenText({ startsAt: Date.now() + HOUR, endsAt: null }), /Repeats/);

    const start = Date.now() + DAY;
    const event = await createClanEvent(ctx, { title: 'Clan night', startsAt: start, endsAt: start + 2 * HOUR, createdBy: 'u1', repeatDays: 7 });
    assert.equal(event.repeatDays, 7);
    assert.equal(event.seriesId, event.id);
    assert.equal(sent[0]!.channel, ANNOUNCE);
    assert.match(sent[0]!.when, /🔁 Repeats every week/);

    await assert.rejects(createClanEvent(ctx, { title: 'x', startsAt: start, createdBy: 'u1', repeatDays: 3 }), /every day, every week, every 2 weeks or every 4 weeks/);
    await assert.rejects(createClanEvent(ctx, { title: 'x', startsAt: start, endsAt: start + DAY, createdBy: 'u1', repeatDays: 1 }), /must be over before its next round starts/);
    await assert.rejects(createClanEvent(ctx, { title: 'x', startsAt: start, endsAt: start + DAY, createdBy: 'u1', repeatDays: 7.5 }), UserError);
    assert.equal(ctx.store.upcomingEvents(GUILD).length, 1, 'nothing was stored for the refused ones');
  });

  it('does not keep an event whose post failed', async () => {
    const { ctx, mute } = setup();
    mute.add(ANNOUNCE);
    await assert.rejects(createClanEvent(ctx, { title: 'Hunt', startsAt: Date.now() + DAY, createdBy: 'u1' }), /Missing Permissions/);
    assert.deepEqual(ctx.store.upcomingEvents(GUILD), []);
  });

  it('posts the next round once one is over: same event, a week later, fresh buttons, once', async () => {
    const { ctx, sent, past } = setup();
    const first = past({ endsAt: Date.now() - HOUR });
    ctx.store.setRsvp(first.id, 'u2', 'going');

    const posted = await repeatEvents(ctx);
    assert.equal(posted.length, 1);
    const next = posted[0]!;
    assert.equal(next.title, 'Clan night');
    assert.equal(next.description, 'Bring relics');
    assert.equal(next.createdBy, 'u1');
    assert.equal(next.startsAt, first.startsAt + 7 * DAY);
    assert.equal(next.endsAt, first.endsAt! + 7 * DAY, 'as long as the round before');
    assert.deepEqual([next.repeatDays, next.seriesId], [7, first.id]);
    assert.equal(ctx.store.getEvent(first.id)!.nextId, next.id);
    assert.deepEqual(ctx.store.getRsvps(next.id), { going: [], maybe: [], declined: [] }, 'nobody is signed up for the new round yet');
    assert.deepEqual(sent.map((s) => [s.channel, s.title, s.buttons]), [[EVENTS, '📅 Clan night', 1]], 'in the channel the series lives in, with RSVP buttons');
    assert.match(sent[0]!.when, /🔁 Repeats every week/);

    assert.deepEqual(await repeatEvents(ctx), [], 'the next minute has nothing to do');
    assert.equal(sent.length, 1);
    assert.equal(newestRound(ctx, ctx.store.getEvent(first.id)!).id, next.id);
  });

  it('keeps the time of day in the clan time zone when the clocks change', async (t) => {
    // Tuesday 20 October 2026, 21:30 in Berlin; the clocks go back on the 25th.
    t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 20, 19, 30) });
    const { ctx, past } = setup({ zone: 'Europe/Berlin' });
    const first = past({ startsAt: Date.UTC(2026, 9, 20, 18, 0) });
    const [next] = await repeatEvents(ctx);
    assert.equal(next!.startsAt, Date.UTC(2026, 9, 27, 19, 0), '20:00 in Berlin again, which is an hour later in UTC');
    assert.equal(first.seriesId, first.id);
  });

  it('follows a cancelled round too, until the series is stopped', async () => {
    const { ctx, sent, past } = setup();
    const first = past();
    ctx.store.cancelEvent(first.id);
    const [second] = await repeatEvents(ctx);
    assert.ok(second, 'one evening off does not end the clan night');

    // Cancelling the upcoming round with the series: nothing follows it.
    await cancelClanEvent(ctx, second.id, { stopSeries: true });
    assert.equal(ctx.store.getEvent(second.id)!.cancelled, true);
    assert.equal(ctx.store.getEvent(second.id)!.repeatDays, null);
    assert.equal(ctx.store.eventsDueToRepeat(GUILD, second.startsAt + DAY).length, 0);
    assert.equal(sent.length, 1);
  });

  it('changes or stops the repetition on the newest round of a series', async () => {
    const { ctx, past } = setup();
    const first = past();
    const [second] = await repeatEvents(ctx);
    const changed = await setClanEventRepeat(ctx, first.id, 14);
    assert.equal(changed.id, second!.id, 'the newest round carries the series on');
    assert.equal(changed.repeatDays, 14);
    assert.equal(ctx.store.getEvent(first.id)!.repeatDays, 7, 'the old round stays as it was');
    await assert.rejects(setClanEventRepeat(ctx, first.id, 14), /already repeats every 2 weeks/);
    await assert.rejects(setClanEventRepeat(ctx, first.id, 5), /every day, every week/);
    await assert.rejects(setClanEventRepeat(ctx, 9999, 7), /does not exist/);

    const stopped = await setClanEventRepeat(ctx, second!.id, null);
    assert.equal(stopped.repeatDays, null);
    await assert.rejects(setClanEventRepeat(ctx, second!.id, null), /does not repeat/);
    assert.equal(ctx.store.eventsDueToRepeat(GUILD, second!.startsAt + DAY).length, 0);

    // An event that happened once can be made to repeat afterwards.
    const once = past({ repeatDays: null, title: 'Eidolon hunt' });
    assert.deepEqual(await repeatEvents(ctx), []);
    await setClanEventRepeat(ctx, once.id, 7);
    assert.deepEqual((await repeatEvents(ctx)).map((e) => [e.title, e.seriesId]), [['Eidolon hunt', once.id]]);
  });

  it('skips the rounds missed while Ordis was off', async () => {
    const { ctx, past } = setup();
    const first = past({ startsAt: Date.now() - 30 * DAY - 2 * HOUR, repeatDays: 7 });
    const [next] = await repeatEvents(ctx);
    assert.equal(next!.startsAt, first.startsAt + 35 * DAY, 'the first round that is still ahead');
  });

  it('moves to the announcements channel when its own is gone, and tells the staff when it cannot post at all', async () => {
    const { ctx, sent, notices, gone, mute, past } = setup();
    const first = past();
    gone.add(EVENTS);
    const [next] = await repeatEvents(ctx);
    assert.equal(next!.channelId, ANNOUNCE);
    assert.equal(sent[0]!.channel, ANNOUNCE);
    assert.equal(notices.length, 0);

    // The round after that: nowhere to post it.
    const second = past({ title: 'Raid night' });
    gone.add(ANNOUNCE);
    const at = Date.now();
    assert.deepEqual(await repeatEvents(ctx, at), []);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.title, '⚠️ A repeating event could not be posted');
    assert.match(notices[0]!.text, /\*\*Raid night\*\* repeats every week, but its next round .* could not be posted: Channel \d+ is not a text channel/);
    assert.match(notices[0]!.text, new RegExp(`/event repeat id:${second.id} every:Never`));
    assert.equal(ctx.store.getEvent(second.id)!.nextId, null);

    gone.clear();
    assert.deepEqual(await repeatEvents(ctx, at + 5 * 60_000), [], 'not tried again before 15 minutes have passed');
    mute.add(EVENTS);
    assert.deepEqual(await repeatEvents(ctx, at + 16 * 60_000), [], 'a post that is refused is no round either');
    assert.equal(ctx.store.getEvent(second.id)!.nextId, null, 'the half-made round was taken back');
    assert.equal(notices.length, 1, 'the staff are told once');
    mute.clear();
    const [raid] = await repeatEvents(ctx, at + 32 * 60_000);
    assert.equal(raid!.title, 'Raid night');
    assert.equal(ctx.store.getEvent(first.id)!.nextId, next!.id);
  });
});
