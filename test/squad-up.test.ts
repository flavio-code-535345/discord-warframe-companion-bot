import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { arbitrationBoard } from '../src/discord/feeds/arbitrations.js';
import { squadUpReply } from '../src/discord/feeds/handlers.js';
import { componentText } from '../src/discord/feeds/parts.js';
import type { FeedInput } from '../src/discord/feeds/types.js';
import { ARBITRATION_ACTIVITY, slotDetails, squadSlot, squadUpForArbitration } from '../src/lfg/arbitration-squad.js';
import type { ArbitrationSlot, ArbitrationView } from '../src/warframe/arbitrations.js';

const GUILD = '111111111111111111';
const LFG = '222222222222222222';
const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 10, 13, 18, 20);

const slot = (start: number, over: Partial<ArbitrationSlot> = {}): ArbitrationSlot => ({
  nodeKey: 'SolNode1',
  node: 'Casta (Ceres)',
  name: 'Casta',
  planet: 'Ceres',
  mission: 'Defense',
  faction: 'Grineer',
  start,
  end: start + HOUR,
  tier: 'S',
  ...over,
} as ArbitrationSlot);

const HOUR_START = Date.UTC(2026, 10, 13, 18, 0);
const view = (over: Partial<ArbitrationView> = {}): ArbitrationView => ({
  current: slot(HOUR_START),
  upcoming: [slot(HOUR_START + HOUR, { name: 'Odin', planet: 'Mercury', mission: 'Interception', tier: 'B' }), slot(HOUR_START + 2 * HOUR, { name: 'Seimeni', tier: 'A' })],
  best: [],
  scheduleTrusted: true,
  stale: false,
  ...over,
});

interface Posted {
  channel: string;
  id: string;
  title?: string;
  description?: string;
  content?: string;
  mentions?: string[];
  edits: number;
}

function world() {
  const posted: Posted[] = [];
  const channel = (id: string) => ({
    id,
    guildId: GUILD,
    isSendable: () => true,
    send: async (o: { embeds?: { data: { title?: string; description?: string } }[]; content?: string; allowedMentions?: { users?: string[]; parse?: string[] } }) => {
      const entry: Posted = { channel: id, id: `m${posted.length + 1}`, title: o.embeds?.[0]?.data.title, description: o.embeds?.[0]?.data.description, content: o.content, mentions: o.allowedMentions?.users, edits: 0 };
      posted.push(entry);
      return { id: entry.id };
    },
    messages: {
      fetch: async (messageId: string) => {
        const entry = posted.find((p) => p.id === messageId);
        return entry ? { id: messageId, edit: async () => void entry.edits++ } : Promise.reject(new Error('Unknown Message'));
      },
    },
  });
  const ctx: AppContext = {
    config: loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }),
    store: new Store(':memory:'),
    client: { isReady: () => false, user: { displayAvatarURL: () => 'https://cdn.example/avatar.png' }, channels: { fetch: async (id: string) => channel(id) } } as unknown as Client,
  };
  ctx.store.updateSettings(GUILD, { lfgChannelId: LFG });
  const tap = (id: string, opts: { now?: number; view?: ArbitrationView } = {}) => squadUpForArbitration(ctx, { id, name: `Rat ${id}` }, { now: NOW, view: view(), ...opts });
  return { ctx, posted, tap };
}

describe('Squad up on the Arbitration board', () => {
  it('picks the Arbitration that is running, or the next one when this one is nearly over', () => {
    const v = view();
    assert.equal(squadSlot(v, NOW)?.name, 'Casta');
    assert.equal(squadSlot(v, HOUR_START + 45 * MIN)?.name, 'Casta', 'exactly a quarter of an hour left');
    assert.equal(squadSlot(v, HOUR_START + 46 * MIN)?.name, 'Odin', 'too late to get a squad together for this one');
    assert.equal(squadSlot({ ...v, scheduleTrusted: false }, HOUR_START + 50 * MIN)?.name, 'Casta', 'the next hours are not known when the schedule and the game disagree');
    assert.equal(squadSlot({ ...v, current: null }, NOW)?.name, 'Odin');
    assert.equal(squadSlot({ current: null, upcoming: [], scheduleTrusted: true }, NOW), null);
    assert.equal(squadSlot({ ...v, upcoming: [] }, HOUR_START + 61 * MIN), null, 'an hour that is over is no Arbitration');

    assert.equal(slotDetails(slot(HOUR_START), NOW), `S tier · Casta, Ceres · Defense · Grineer · ends <t:${(HOUR_START + HOUR) / 1000}:R>`);
    assert.equal(slotDetails(slot(HOUR_START + HOUR, { nodeKey: '', planet: '', faction: '' }), NOW), `Casta · Defense · starts <t:${(HOUR_START + HOUR) / 1000}:R>`, 'no tier without the schedule');
  });

  it('starts a squad with the first tap and seats the next members in it', async () => {
    const w = world();
    const first = await w.tap('u1');
    assert.equal(first.kind, 'created');
    assert.equal(first.post.activity, ARBITRATION_ACTIVITY);
    assert.equal(first.post.channelId, LFG);
    assert.equal(first.post.size, 4);
    assert.equal(first.post.expiresAt, HOUR_START + HOUR, 'it ends with the Arbitration');
    assert.match(first.post.details ?? '', /^S tier · Casta, Ceres · Defense · Grineer · ends /);
    assert.equal(w.posted.length, 1);
    assert.equal(w.posted[0]!.title, '🐀 LFG: Arbitrations');
    assert.deepEqual(w.ctx.store.lfgMembers(first.post.id), ['u1']);
    assert.match(squadUpReply(w.ctx, first), new RegExp(`^🐀 Squad #${first.post.id} for \\*\\*Casta, Ceres\\*\\* \\(Defense\\) is up in <#${LFG}>: \\[open the post\\]\\(https://discord.com/channels/${GUILD}/${LFG}/m1\\)\\.`));

    const second = await w.tap('u2');
    assert.equal(second.kind, 'joined');
    assert.equal(second.post.id, first.post.id);
    assert.equal(second.full, false);
    assert.deepEqual(w.ctx.store.lfgMembers(first.post.id), ['u1', 'u2']);
    assert.equal(w.posted[0]!.edits, 1, 'the squad post shows the new member');
    assert.equal(w.posted.length, 1, 'no second squad');
    assert.match(squadUpReply(w.ctx, second), /^🐀 You joined <@u1>'s squad for \*\*Casta, Ceres\*\* \(Defense\): \[open the post\]/);

    const again = await w.tap('u2');
    assert.equal(again.kind, 'already');
    assert.deepEqual(w.ctx.store.lfgMembers(first.post.id), ['u1', 'u2']);
    assert.match(squadUpReply(w.ctx, again), /^You are already in the squad/);
  });

  it('says so when the squad is full, and starts another for whoever comes next', async () => {
    const w = world();
    const first = await w.tap('u1');
    await w.tap('u2');
    await w.tap('u3');
    const fourth = await w.tap('u4');
    assert.equal(fourth.full, true);
    assert.equal(w.posted.length, 2);
    assert.match(w.posted[1]!.content ?? '', /^🐀 Squad full for \*\*Arbitrations\*\*! <@u1> <@u2> <@u3> <@u4> — host: <@u1>, send invites\.$/);
    assert.deepEqual(w.posted[1]!.mentions, ['u1', 'u2', 'u3', 'u4'], 'only its own members are pinged');
    assert.match(squadUpReply(w.ctx, fourth), /The squad is full now\.$/);

    const fifth = await w.tap('u5');
    assert.equal(fifth.kind, 'created');
    assert.notEqual(fifth.post.id, first.post.id);
    assert.equal((await w.tap('u6')).post.id, fifth.post.id, 'the board now seats members in the new squad');
  });

  it('starts a new squad when the old one was closed, and one of its own for the next hour', async () => {
    const w = world();
    const first = await w.tap('u1');
    w.ctx.store.closeLfg(first.post.id);
    const second = await w.tap('u2');
    assert.equal(second.kind, 'created');

    // Ten minutes before the hour ends: the squad is for the next Arbitration, and separate from this hour's.
    const late = await w.tap('u3', { now: HOUR_START + 50 * MIN });
    assert.equal(late.kind, 'created');
    assert.equal(late.slot.name, 'Odin');
    assert.equal(late.post.expiresAt, HOUR_START + 2 * HOUR);
    assert.match(late.post.details ?? '', /^B tier · Odin, Mercury · Interception · Grineer · starts /);
    assert.equal((await w.tap('u4', { now: HOUR_START + 55 * MIN })).post.id, late.post.id);
    assert.equal((await w.tap('u5')).post.id, second.post.id, 'while this hour still has its own');
  });

  it('makes one squad of two taps in the same moment', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.tap('u1'), w.tap('u2')]);
    assert.deepEqual([a.kind, b.kind], ['created', 'joined']);
    assert.equal(a.post.id, b.post.id);
  });

  it('explains what is missing', async () => {
    const w = world();
    await assert.rejects(w.tap('u1', { view: view({ current: null, upcoming: [] }) }), /No Arbitration is known right now/);
    w.ctx.store.updateSettings(GUILD, { lfgChannelId: null });
    await assert.rejects(w.tap('u1'), /no channel to post the squad in.*\/setup lfg/);
    // A failed tap does not block the next one.
    w.ctx.store.updateSettings(GUILD, { lfgChannelId: LFG });
    assert.equal((await w.tap('u1')).kind, 'created');
    w.ctx.store.setMeta('arby_squads', '{broken');
    assert.equal((await w.tap('u2')).kind, 'created', 'a record that cannot be read is no squad');
  });

  it('is on the board only when squads have a channel', () => {
    const settings = new Store(':memory:').getSettings(GUILD);
    const input = (lfgChannelId: string | null): FeedInput => ({ now: NOW, ws: null, arby: view(), arbyData: null, stale: false, settings: { ...settings, lfgChannelId } });
    const last = (i: FeedInput) => componentText(arbitrationBoard(i).at(-1)!);
    assert.match(last(input(LFG)), /\[Squad up\] \[Plan ahead\] \[My notifications\]/);
    assert.match(last(input(null)), /\n\[Plan ahead\] \[My notifications\]/);
  });
});
