import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, describe, it } from 'node:test';
import { Collection } from 'discord.js';
import { Store } from '../src/db.js';
import { ocr } from '../src/ssroles/ocr.js';
import { handleRankRow, handleSsMessage } from '../src/ssroles/service.js';

const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(() => ocr.release());

const role = (id: string, name: string, position: number) => ({ id, name, position, managed: false, permissions: { any: () => false } });

function setup(attachmentNames: string[], uid = 'u1') {
  const store = new Store(':memory:');
  store.updateSettings('g', { ssRolesChannelId: 'c' });
  // Earlier, a profile card showing "TheRareGamer#1234" was verified for this member.
  store.claimSs('g', 'ign', 'theraregamer1234', uid);

  const files = new Map(attachmentNames.map((n, i) => [`https://cdn.test/${i}.png`, asset(n)]));
  globalThis.fetch = (async (url: string) => new Response(files.get(String(url)) ?? new Uint8Array(), { status: 200 })) as typeof fetch;

  const held = new Map<string, ReturnType<typeof role>>();
  const roles = new Map([role('clan', 'Clan', 5), role('lr3', 'LR 3', 6), role('squire', 'Rat Squire', 7)].map((r) => [r.id, r]));
  const member = {
    nickname: null as string | null,
    roles: { cache: held, add: async (id: string) => void held.set(id, roles.get(id)!), remove: async (id: string) => void held.delete(id) },
    setNickname: async (n: string) => void (member.nickname = n),
  };
  const sent: { content?: string; embeds?: { data: { title?: string } }[] }[] = [];
  const reply = { edit: async () => reply, delete: async () => {} };
  const channel = {
    send: async (p: (typeof sent)[number]) => {
      sent.push(p);
      return { edit: async (e: (typeof sent)[number]) => (sent.push(e), reply), delete: async () => {} };
    },
  };
  const message = {
    inGuild: () => true,
    guildId: 'g',
    channelId: 'c',
    author: { id: uid, username: 'rat', bot: false },
    member: { ...member, permissions: { has: () => false } },
    channel,
    attachments: new Collection(attachmentNames.map((n, i) => [String(i), { url: `https://cdn.test/${i}.png`, contentType: 'image/png', size: 1000 }])),
    guild: { id: 'g', members: { fetchMe: async () => ({ roles: { highest: { position: 50 } } }) }, roles: { cache: roles } },
    delete: async () => {},
  };
  // The handler takes the member from message.member: give it the same roles/nickname handles.
  message.member = Object.assign(member, { permissions: { has: () => false } }) as never;
  const ctx = {
    config: { DISCORD_GUILD_ID: 'g', CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Ordis', FREE_AI_KEY: undefined },
    store,
    client: { user: { id: 'bot', displayAvatarURL: () => undefined } },
  };
  return { ctx, message, sent, held, member };
}

describe('profile card and clan row in one message', () => {
  it('handles both, the card first, and answers once with two results', async () => {
    const t = setup(['ss-roles-example-rank.png', 'ss-roles-example.png']); // the row is attached first on purpose
    await handleSsMessage(t.message as never, t.ctx as never);
    const last = t.sent.at(-1)!;
    assert.equal(last.embeds?.length, 2);
    assert.match(last.embeds![0]!.data.title!, /Profile card verified/);
    assert.match(last.embeds![1]!.data.title!, /Clan rank not verified/);
    assert.deepEqual([...t.held.keys()].sort(), ['clan', 'lr3']);
  });

  it('still handles a single picture', async () => {
    const t = setup(['ss-roles-example.png'], 'u2');
    await handleSsMessage(t.message as never, t.ctx as never);
    assert.equal(t.sent.at(-1)!.embeds?.length, 1);
  });
});

describe('clan rank also gives the clan role', () => {
  it('adds Clan together with Rat Squire', async () => {
    const t = setup([], 'u3');
    const me = { roles: { highest: { position: 50 } } };
    const out = await handleRankRow(t.ctx as never, t.message as never, t.member as never, me as never, new Uint8Array([1, 2, 3]), { rank: 'squire', name: 'TheRareGamer' });
    assert.match(out.embed.data.title!, /Clan rank verified/);
    assert.deepEqual([...t.held.keys()].sort(), ['clan', 'squire']);
    assert.match(out.embed.data.description!, /Roles added/);
  });
});
