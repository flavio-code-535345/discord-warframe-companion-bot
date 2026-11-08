import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { Store } from '../src/db.js';
import {
  type BoardChannel,
  type BoardComponent,
  type NoteChannel,
  BOARD_MIN_EDIT_MS,
  BOARD_VERIFY_MS,
  boardKey,
  clearBoard,
  expireNote,
  noteKey,
  postNote,
  syncBoard,
} from '../src/discord/board.js';

const text = (s: string) => new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(s));

/** A channel that records what was sent, edited and deleted; `gone` holds message ids that no longer exist. */
function fakeChannel() {
  let next = 1;
  const log: string[] = [];
  const live = new Map<string, string>();
  const gone = new Set<string>();
  const body = (components: BoardComponent[]) => components.map((c) => JSON.stringify(c.toJSON())).join('');
  const missing = () => Object.assign(new Error('Unknown Message'), { code: 10008 });
  const channel: BoardChannel = {
    id: 'c1',
    guildId: 'g1',
    async send(p) {
      const id = `m${next++}`;
      live.set(id, body(p.components));
      log.push(`send ${id}`);
      return { id };
    },
    messages: {
      async edit(id, p) {
        if (gone.has(id) || !live.has(id)) throw missing();
        live.set(id, body(p.components));
        log.push(`edit ${id}`);
      },
      async delete(id) {
        log.push(`delete ${id}`);
        live.delete(id);
      },
      async fetch(id) {
        if (gone.has(id) || !live.has(id)) throw missing();
        return {};
      },
    },
  };
  return { channel, log, live, gone };
}

/** A board of two messages; the second one says when it was updated. */
const render = (first: string, second = 'b') => (stamp: number) => [[text(first)], [text(stamp ? `${second} @${stamp}` : second)]];

describe('live boards', () => {
  it('posts every message once, then leaves an unchanged board alone', async () => {
    const store = new Store(':memory:');
    const { channel, log } = fakeChannel();
    const t0 = 1_000_000;
    const first = await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 });
    assert.equal(first.action, 'posted');
    assert.equal(first.url, 'https://discord.com/channels/g1/c1/m1');
    assert.deepEqual(log, ['send m1', 'send m2']);
    const again = await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 + 60_000 });
    assert.equal(again.action, 'unchanged');
    assert.equal(log.length, 2, 'the time on the board alone does not count as a change');
  });

  it('waits before editing a changed board unless forced, and then edits only what changed plus the last message', async () => {
    const store = new Store(':memory:');
    const { channel, log, live } = fakeChannel();
    const t0 = 1_000_000;
    await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 });
    log.length = 0;
    assert.equal((await syncBoard({ store }, channel, 'arby', render('changed'), { now: t0 + 1_000 })).action, 'waiting');
    assert.equal(log.length, 0);
    assert.equal((await syncBoard({ store }, channel, 'arby', render('changed'), { now: t0 + 2_000, force: true })).action, 'edited');
    assert.deepEqual(log, ['edit m1', 'edit m2']);
    assert.match(live.get('m1')!, /changed/);
    log.length = 0;
    // Only the second message changed: the first one is left alone.
    await syncBoard({ store }, channel, 'arby', render('changed', 'new'), { now: t0 + 2_000 + BOARD_MIN_EDIT_MS });
    assert.deepEqual(log, ['edit m2']);
  });

  it('posts the whole board again when one of its messages was deleted', async () => {
    const store = new Store(':memory:');
    const { channel, log, gone } = fakeChannel();
    const t0 = 1_000_000;
    await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 });
    gone.add('m2');
    log.length = 0;
    // Unchanged boards are only checked every so often.
    assert.equal((await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 + 1_000 })).action, 'unchanged');
    const res = await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 + BOARD_VERIFY_MS });
    assert.equal(res.action, 'posted');
    assert.deepEqual(log, ['delete m1', 'delete m2', 'send m3', 'send m4'], 'the old first message goes too, so the order stays');
    assert.deepEqual(JSON.parse(store.getMeta(boardKey('arby', 'c1'))!).ids, ['m3', 'm4']);
  });

  it('reposts when an edit finds the message gone, and when the number of messages changes', async () => {
    const store = new Store(':memory:');
    const { channel, log, gone } = fakeChannel();
    const t0 = 1_000_000;
    await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 });
    gone.add('m1');
    log.length = 0;
    assert.equal((await syncBoard({ store }, channel, 'arby', render('b'), { now: t0, force: true })).action, 'posted');
    assert.deepEqual(log, ['delete m1', 'delete m2', 'send m3', 'send m4']);
    log.length = 0;
    const one = () => [[text('only')]];
    assert.equal((await syncBoard({ store }, channel, 'arby', one, { now: t0 + 1 })).action, 'posted');
    assert.deepEqual(log, ['delete m3', 'delete m4', 'send m5']);
  });

  it('redraws a board once when its version changes, and passes on errors other than a deleted message', async () => {
    const store = new Store(':memory:');
    const { channel, log } = fakeChannel();
    const t0 = 1_000_000;
    await syncBoard({ store }, channel, 'arby', render('a'), { now: t0, version: '1' });
    log.length = 0;
    assert.equal((await syncBoard({ store }, channel, 'arby', render('a'), { now: t0 + BOARD_MIN_EDIT_MS, version: '2' })).action, 'edited');
    assert.deepEqual(log, ['edit m1', 'edit m2']);
    channel.messages.edit = async () => {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    };
    await assert.rejects(syncBoard({ store }, channel, 'arby', render('z'), { now: t0 + 2 * BOARD_MIN_EDIT_MS, version: '2' }), /Missing Permissions/);
  });

  it('keeps one ping note per channel and removes it when its time is over', async () => {
    const store = new Store(':memory:');
    const sent: { id: string; content: string; roles: string[] }[] = [];
    const deleted: string[] = [];
    const channel: NoteChannel = {
      id: 'c1',
      send: async (p) => {
        const id = `n${sent.length + 1}`;
        sent.push({ id, content: p.content, roles: p.allowedMentions.roles });
        return { id };
      },
      messages: { delete: async (id) => void deleted.push(id) },
    };
    await postNote({ store }, channel, '⚖️ **S tier** now', 'r1', 1_000);
    assert.deepEqual(sent[0], { id: 'n1', content: '<@&r1> ⚖️ **S tier** now', roles: ['r1'] });
    await postNote({ store }, channel, 'next one', 'r1', 2_000);
    assert.deepEqual(deleted, ['n1'], 'the next note replaces the last');
    await expireNote({ store }, channel, 1_999);
    assert.deepEqual(deleted, ['n1']);
    await expireNote({ store }, channel, 2_000);
    assert.deepEqual(deleted, ['n1', 'n2']);
    assert.equal(store.getMeta(noteKey('c1')), '');
    await expireNote({ store }, channel, Infinity);
    assert.deepEqual(deleted, ['n1', 'n2'], 'nothing left to remove');
  });

  it('clears a board', async () => {
    const store = new Store(':memory:');
    const { channel, log } = fakeChannel();
    await syncBoard({ store }, channel, 'arby', render('a'), { now: 1 });
    log.length = 0;
    await clearBoard({ store }, channel, 'arby');
    assert.deepEqual(log, ['delete m1', 'delete m2']);
    assert.equal(store.getMeta(boardKey('arby', 'c1')), '');
    assert.equal((await syncBoard({ store }, channel, 'arby', render('a'), { now: 2 })).action, 'posted');
  });
});
