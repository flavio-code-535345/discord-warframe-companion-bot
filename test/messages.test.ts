import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from 'discord.js';
import { MAX_MESSAGE_CHARS, editOwnMessage, ownMessages } from '../src/discord/messages.js';

const BOT = 'bot';
function channel(messages: Record<string, { author: string; content: string }>) {
  const edited: { id: string; content: string; allowedMentions: unknown }[] = [];
  const make = (id: string): Message =>
    ({ id, author: { id: messages[id]!.author }, content: messages[id]!.content, edit: async (o: { content: string; allowedMentions: unknown }) => { edited.push({ id, ...o }); return make(id); } }) as unknown as Message;
  const ch = {
    messages: {
      fetch: async (o: string | { limit: number }) => {
        if (typeof o === 'string') {
          if (!messages[o]) throw new Error('Unknown Message');
          return make(o);
        }
        return new Map(Object.keys(messages).slice(0, o.limit).map((id) => [id, make(id)]));
      },
    },
  } as never;
  return { ch, edited };
}

describe('editing the bot\'s own messages', () => {
  it('lists only what the bot wrote', async () => {
    const { ch } = channel({ a: { author: BOT, content: 'rules' }, b: { author: '5', content: 'hi' }, c: { author: BOT, content: 'guide' } });
    assert.deepEqual((await ownMessages(ch, BOT)).map((m) => m.id), ['a', 'c']);
  });

  it('replaces the text without pinging anyone', async () => {
    const { ch, edited } = channel({ a: { author: BOT, content: 'old' } });
    await editOwnMessage(ch, 'a', '  @everyone new text\r\nline two ', BOT);
    assert.deepEqual(edited, [{ id: 'a', content: '@everyone new text\nline two', allowedMentions: { parse: [] } }]);
  });

  it('refuses someone else\'s message, a missing one, empty text and text over the limit', async () => {
    const { ch, edited } = channel({ a: { author: '5', content: 'theirs' }, b: { author: BOT, content: 'mine' } });
    await assert.rejects(editOwnMessage(ch, 'a', 'x', BOT), /only edit messages he wrote/);
    await assert.rejects(editOwnMessage(ch, 'zzz', 'x', BOT), /no longer exists/);
    await assert.rejects(editOwnMessage(ch, 'b', '   ', BOT), /cannot be empty/);
    await assert.rejects(editOwnMessage(ch, 'b', 'x'.repeat(MAX_MESSAGE_CHARS + 1), BOT), /Discord allows 2000/);
    assert.deepEqual(edited, []);
  });
});
