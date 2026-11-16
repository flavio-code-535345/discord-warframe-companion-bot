import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageFlags, type SendableChannels } from 'discord.js';
import { clearOldWeeklies } from '../src/discord/weekly.js';

const BOT = 'bot';
const weeklyRaw = {
  type: 17,
  components: [
    { type: 10, content: '## Weekly reset\nThe week of Monday' },
    { type: 1, components: [{ type: 2, custom_id: 'notify:weekly' }] },
  ],
};

type Fake = { id: string; deleted: boolean };

/** A post from before the cards: embeds titled "Weekly reset · week of …". */
function embedPost(id: string, title = 'Weekly reset · week of 2026-11-02') {
  const m = { id, deleted: false, author: { id: BOT }, flags: { has: () => false }, components: [], embeds: [{ title }], delete: async () => { m.deleted = true; } };
  return m;
}

/** A message as the channel hands it over: a V2 container that knows its own JSON. */
function message(id: string, raw: unknown, author = BOT, v2 = true, fail = false) {
  const m = {
    id,
    deleted: false,
    author: { id: author },
    flags: { has: (f: number) => v2 && f === MessageFlags.IsComponentsV2 },
    components: [{ toJSON: () => raw }],
    embeds: [],
    delete: async () => {
      if (fail) throw new Error('missing access');
      m.deleted = true;
    },
  };
  return m;
}

const channelOf = (messages: Fake[], fail = false) =>
  ({ messages: { fetch: async () => (fail ? Promise.reject(new Error('no access')) : new Map(messages.map((m) => [m.id, m]))) } }) as unknown as SendableChannels;

describe('clearing the old Monday posts from the weeklies channel', () => {
  it('deletes the cards and the embed posts, and leaves the live board, other posts and other authors alone', async () => {
    const card = message('card', weeklyRaw);
    const embeds = embedPost('embeds');
    const board = message('board', { type: 17, components: [{ type: 10, content: '## Daily sortie' }] });
    const foreign = message('foreign', weeklyRaw, 'someone');
    const otherEmbed = embedPost('other', 'Fissures');
    const count = await clearOldWeeklies(channelOf([card, embeds, board, foreign, otherEmbed]), BOT);
    assert.equal(count, 2);
    assert.ok(card.deleted && embeds.deleted);
    for (const m of [board, foreign, otherEmbed]) assert.equal(m.deleted, false, m.id);
  });

  it('a message it cannot delete stops nothing', async () => {
    const stuck = message('stuck', weeklyRaw, BOT, true, true);
    const card = message('card', weeklyRaw);
    assert.equal(await clearOldWeeklies(channelOf([stuck, card]), BOT), 1);
    assert.ok(card.deleted);
  });

  it('a channel it cannot read is no failure', async () => {
    assert.equal(await clearOldWeeklies(channelOf([], true), BOT), 0);
  });
});
