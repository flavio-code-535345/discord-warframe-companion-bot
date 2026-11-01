import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from 'discord.js';
import { MAX_MESSAGE_CHARS, cardEmbed, editOwnMessage, editOwnMessageCard, ownMessages } from '../src/discord/messages.js';

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

describe('turning a bot message into an embed', () => {
  it('builds the embed in the brand look, with the logo and footer when asked', () => {
    const e = cardEmbed({ title: 'Rules', description: 'Be nice.\r\nUse common sense.', fields: [{ name: 'Staff', value: 'Final say', inline: true }], logo: true, footer: 'The Rats Den 69' }, { color: 0x3b9ac7, icon: 'https://cdn/x.png' }).toJSON();
    assert.equal(e.color, 0x3b9ac7);
    assert.equal(e.description, 'Be nice.\nUse common sense.');
    assert.deepEqual(e.fields, [{ name: 'Staff', value: 'Final say', inline: true }]);
    assert.equal(e.thumbnail?.url, 'https://cdn/x.png');
    assert.equal(e.footer?.text, 'The Rats Den 69');
  });

  it("refuses an embed over Discord's total limit", () => {
    const fields = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, value: 'x'.repeat(1000) }));
    assert.throws(() => cardEmbed({ title: 't', fields }, { color: 1 }), /Discord allows 6000/);
  });

  it("replaces the old text with the embed, and refuses someone else's message", async () => {
    const { ch, edited } = channel({ a: { author: BOT, content: 'old text' }, b: { author: '5', content: 'theirs' } });
    const embed = cardEmbed({ title: 'Welcome' }, { color: 1 });
    await editOwnMessageCard(ch, 'a', embed, BOT);
    assert.equal(edited.length, 1);
    assert.equal(edited[0]!.content, '');
    assert.deepEqual((edited[0] as unknown as { embeds: unknown[] }).embeds, [embed]);
    await assert.rejects(editOwnMessageCard(ch, 'b', embed, BOT), /only edit messages he wrote/);
  });
});
