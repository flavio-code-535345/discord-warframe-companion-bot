import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { UserError, createClanEvent, isOver, refreshEventMessage, renderEvent, whenText } from '../src/services/clan.js';
import { MAX_EVENT_LENGTH_MS, parseEnd } from '../src/time.js';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';
const HOUR = 3_600_000;
const DAY = 86_400_000;

function setup() {
  const sent: { embeds: { data: { title?: string; fields?: { name: string; value: string }[] } }[]; components: unknown[] }[] = [];
  const edits: typeof sent = [];
  const message = { id: 'm1', edit: async (o: (typeof sent)[number]) => void edits.push(o) };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    isSendable: () => true,
    send: async (o: (typeof sent)[number]) => {
      sent.push(o);
      return message;
    },
    messages: { fetch: async () => message },
  };
  const ctx: AppContext = {
    config: loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }),
    store: new Store(':memory:'),
    client: { isReady: () => false, user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' }, channels: { fetch: async () => channel } } as unknown as Client,
  };
  return { ctx, sent, edits };
}

describe('event end times', () => {
  it('reads an end as a length after the start, or as a time', () => {
    const start = Date.UTC(2026, 10, 2, 20, 0);
    assert.equal(parseEnd('2h', start), start + 2 * HOUR);
    assert.equal(parseEnd('1d 2h30m', start), start + DAY + 2.5 * HOUR);
    assert.equal(parseEnd('in 90m', start), start + 1.5 * HOUR);
    assert.equal(parseEnd('2026-11-02 22:30', start), Date.UTC(2026, 10, 2, 22, 30));
    assert.equal(parseEnd('2026-11-02T22:30', start), Date.UTC(2026, 10, 2, 22, 30), 'what the panel form sends');
    assert.equal(parseEnd('', start), null);
    assert.equal(parseEnd('soonish', start), null);
    assert.equal(parseEnd('0h', start), null);
  });

  it('stores the end, and keeps an event with no end exactly as before', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    const timed = store.createEvent({ guildId: GUILD, title: 'Weekend', description: null, startsAt: now + HOUR, endsAt: now + 3 * HOUR, createdBy: 'u' });
    const open = store.createEvent({ guildId: GUILD, title: 'Hunt', description: null, startsAt: now + 2 * HOUR, createdBy: 'u' });
    assert.equal(timed.endsAt, now + 3 * HOUR);
    assert.equal(timed.ended, false);
    assert.equal(open.endsAt, null);
  });

  it('keeps a running event in the upcoming list until it ends, but not one without an end that has started', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    const running = store.createEvent({ guildId: GUILD, title: 'Running', description: null, startsAt: now - HOUR, endsAt: now + HOUR, createdBy: 'u' });
    const finished = store.createEvent({ guildId: GUILD, title: 'Finished', description: null, startsAt: now - 3 * HOUR, endsAt: now - HOUR, createdBy: 'u' });
    const started = store.createEvent({ guildId: GUILD, title: 'Started', description: null, startsAt: now - HOUR, createdBy: 'u' });
    const ids = store.upcomingEvents(GUILD).map((e) => e.id);
    assert.deepEqual(ids, [running.id]);
    assert.ok(!ids.includes(finished.id) && !ids.includes(started.id));
  });

  it('finds events whose end has passed once, and not cancelled ones', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    const over = store.createEvent({ guildId: GUILD, title: 'Over', description: null, startsAt: now - 3 * HOUR, endsAt: now - HOUR, createdBy: 'u' });
    const cancelled = store.createEvent({ guildId: GUILD, title: 'Cancelled', description: null, startsAt: now - 3 * HOUR, endsAt: now - HOUR, createdBy: 'u' });
    store.cancelEvent(cancelled.id);
    store.createEvent({ guildId: GUILD, title: 'Later', description: null, startsAt: now - HOUR, endsAt: now + HOUR, createdBy: 'u' });
    store.createEvent({ guildId: GUILD, title: 'No end', description: null, startsAt: now - 3 * HOUR, createdBy: 'u' });
    assert.deepEqual(store.eventsDueToEnd(now).map((e) => e.id), [over.id]);
    store.markEventEnded(over.id);
    assert.deepEqual(store.eventsDueToEnd(now), []);
  });

  it('says when an event is over and how its time reads at each stage', () => {
    const now = 1_800_000_000_000;
    assert.equal(isOver({ startsAt: now - 2 * HOUR, endsAt: null }, now), true, 'no end: an hour after the start');
    assert.equal(isOver({ startsAt: now - 2 * HOUR, endsAt: now + HOUR }, now), false, 'a long event stays open past the first hour');
    assert.equal(isOver({ startsAt: now - 2 * HOUR, endsAt: now - 1 }, now), true);
    assert.doesNotMatch(whenText({ startsAt: now + HOUR, endsAt: null }, now), /Ends|Ended/);
    assert.match(whenText({ startsAt: now + HOUR, endsAt: now + 2 * HOUR }, now), /Ends/);
    assert.match(whenText({ startsAt: now - HOUR, endsAt: now + HOUR }, now), /Happening now[\s\S]*Ends/);
    assert.match(whenText({ startsAt: now - 2 * HOUR, endsAt: now - HOUR }, now), /Ended/);
  });

  it('posts the end in the event message and, after it ends, shows it as ended with no buttons', async () => {
    const { ctx, sent, edits } = setup();
    const created = await createClanEvent(ctx, { title: 'Weekend', startsAt: Date.now() + HOUR, endsAt: Date.now() + 3 * HOUR, createdBy: 'u', channelId: CHANNEL });
    assert.match(sent[0]!.embeds[0]!.data.fields![0]!.value, /Ends/);
    assert.equal(sent[0]!.components.length, 1, 'RSVP buttons while it is on');

    ctx.store.createEvent({ guildId: GUILD, title: 'x', description: null, startsAt: 1, createdBy: 'u' });
    const past = { ...created, startsAt: Date.now() - 3 * HOUR, endsAt: Date.now() - HOUR };
    const view = renderEvent(ctx, past);
    assert.match((view.embeds![0] as unknown as { data: { title: string } }).data.title, /ENDED/);
    assert.deepEqual(view.components, []);
    await refreshEventMessage(ctx, created.id);
    assert.equal(edits.length, 1);
  });

  it('turns away an end before the start and an event longer than 30 days', async () => {
    const { ctx, sent } = setup();
    const start = Date.now() + HOUR;
    const run = (endsAt: number | null) => createClanEvent(ctx, { title: 'x', startsAt: start, endsAt, createdBy: 'u', channelId: CHANNEL });
    await assert.rejects(run(start), (e) => e instanceof UserError && /end after it starts/.test(e.message));
    await assert.rejects(run(start - 1), /end after it starts/);
    await assert.rejects(run(Number.NaN), /end after it starts/);
    await assert.rejects(run(start + MAX_EVENT_LENGTH_MS + 1), /at most 30 days/);
    assert.equal(sent.length, 0, 'nothing was posted');
    await run(start + MAX_EVENT_LENGTH_MS);
    assert.equal(sent.length, 1);
  });
});
