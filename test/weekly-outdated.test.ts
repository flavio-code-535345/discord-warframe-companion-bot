import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageFlags, type SendableChannels } from 'discord.js';
import { markOutdatedWeeklies, outdatedCard } from '../src/discord/weekly.js';
import { COLORS } from '../src/discord/style.js';

const BOT = 'bot';
const weeklyRaw = (accent: number = COLORS.brand) => ({
  type: 17,
  accent_color: accent,
  components: [
    { type: 10, content: '## Weekly reset\nThe week of Monday' },
    { type: 14, divider: true, spacing: 1 },
    { type: 1, components: [{ type: 2, custom_id: 'notify:weekly' }] },
  ],
});

/** A message as the channel hands it over: a V2 container that knows its own JSON. */
function message(id: string, raw: unknown, author = BOT, v2 = true) {
  const edits: unknown[] = [];
  return {
    id,
    author: { id: author },
    flags: { has: (f: number) => v2 && f === MessageFlags.IsComponentsV2 },
    components: [{ toJSON: () => raw }],
    edit: async (p: unknown) => edits.push(p),
    edits,
  };
}

const channelOf = (messages: ReturnType<typeof message>[], fail = false) =>
  ({ messages: { fetch: async () => (fail ? Promise.reject(new Error('no access')) : new Map(messages.map((m) => [m.id, m]))) } }) as unknown as SendableChannels;

describe('older weekly posts', () => {
  it('turns grey, loses its buttons and says it is outdated', () => {
    const out = outdatedCard(weeklyRaw());
    assert.equal(out.accent_color, COLORS.muted);
    assert.match(out.components![0]!.content!, /Outdated/);
    assert.ok(!out.components!.some((c) => c.type === 1), 'no buttons');
    assert.ok(out.components!.some((c) => c.content?.includes('Weekly reset')), 'the text stays');
  });

  it('greys out the earlier posts and leaves the new one, other messages and foreign posts alone', async () => {
    const old = message('old', weeklyRaw());
    const fresh = message('fresh', weeklyRaw());
    const board = message('board', { type: 17, accent_color: COLORS.brand, components: [{ type: 10, content: '## Fissures' }] });
    const foreign = message('foreign', weeklyRaw(), 'someone');
    const plain = message('plain', weeklyRaw(), BOT, false);
    const count = await markOutdatedWeeklies(channelOf([old, fresh, board, foreign, plain]), BOT, 'fresh');
    assert.equal(count, 1);
    assert.equal(old.edits.length, 1);
    for (const m of [fresh, board, foreign, plain]) assert.equal(m.edits.length, 0, m.id);
  });

  it('does not touch a post that is grey already', async () => {
    const done = message('done', weeklyRaw(COLORS.muted));
    assert.equal(await markOutdatedWeeklies(channelOf([done]), BOT, 'fresh'), 0);
    assert.equal(done.edits.length, 0);
  });

  it('a channel it cannot read is no failure', async () => {
    assert.equal(await markOutdatedWeeklies(channelOf([], true), BOT, 'fresh'), 0);
  });
});
