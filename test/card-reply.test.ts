import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type ContainerBuilder, MessageFlags } from 'discord.js';
import { replyCard } from '../src/discord/card-reply.js';
import { card } from '../src/discord/feeds/parts.js';
import { UserError } from '../src/errors.js';

type Call = [string, { flags?: number; components?: unknown[]; allowedMentions?: unknown }];

function fake() {
  const calls: Call[] = [];
  const record = (name: string) => async (o: Call[1] = {}) => void calls.push([name, o]);
  return { calls, interaction: { reply: record('reply'), deferReply: record('deferReply'), editReply: record('editReply') } as unknown as Parameters<typeof replyCard>[0] };
}

const aCard = (): ContainerBuilder => card(0x123456, ['## A card']);
const later = <T>(ms: number, value: () => T): Promise<T> => new Promise((done) => setTimeout(() => done(value()), ms));

describe('a command answered with one card', () => {
  it('gets the card as its reply when the card is ready, for the member alone or for everyone', async () => {
    const mine = fake();
    await replyCard(mine.interaction, Promise.resolve(aCard()), { ephemeral: true });
    assert.deepEqual(mine.calls.map(([name]) => name), ['reply']);
    assert.equal(mine.calls[0]![1].flags, MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral);
    assert.equal(mine.calls[0]![1].components?.length, 1);
    assert.deepEqual(mine.calls[0]![1].allowedMentions, { parse: [] }, 'a card pings nobody');

    const shared = fake();
    await replyCard(shared.interaction, later(10, aCard), { ephemeral: false });
    assert.deepEqual(shared.calls.map(([name]) => name), ['reply']);
    assert.equal(shared.calls[0]![1].flags, MessageFlags.IsComponentsV2);
  });

  it('says it is thinking first when the card takes long, and brings the card afterwards', async () => {
    const slow = fake();
    await replyCard(slow.interaction, later(60, aCard), { ephemeral: true, quickMs: 5 });
    assert.deepEqual(slow.calls.map(([name]) => name), ['deferReply', 'editReply']);
    assert.equal(slow.calls[0]![1].flags, MessageFlags.Ephemeral, 'deferring takes no Components V2 flag');
    assert.equal(slow.calls[1]![1].flags, MessageFlags.IsComponentsV2);
    assert.equal(slow.calls[1]![1].components?.length, 1);
    assert.deepEqual(slow.calls[1]![1].allowedMentions, { parse: [] });

    const shared = fake();
    await replyCard(shared.interaction, later(60, aCard), { ephemeral: false, quickMs: 5 });
    assert.equal(shared.calls[0]![1].flags, undefined, 'a shared card is deferred in the open');
  });

  it('hands a failure to its caller, which answers it like any other', async () => {
    const early = fake();
    await assert.rejects(replyCard(early.interaction, Promise.reject(new UserError('No prime set is called that.')), { ephemeral: true }), /No prime set/);
    assert.equal(early.calls.length, 0, 'nothing was sent, so the error can still be the private reply');

    const late = fake();
    const failing = new Promise<ContainerBuilder>((_, fail) => setTimeout(() => fail(new UserError('AlecaFrame did not answer.')), 40));
    await assert.rejects(replyCard(late.interaction, failing, { ephemeral: true, quickMs: 5 }), /AlecaFrame did not answer/);
    assert.deepEqual(late.calls.map(([name]) => name), ['deferReply'], 'the error follows the "thinking" reply');
  });
});
