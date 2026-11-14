import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { COMMANDS } from '../src/discord/bot.js';
import { DM_COMMAND_NAMES, clearMemberCache, dmCommandData, isClanMember, syncDmCommands } from '../src/discord/dm-commands.js';

const G = '111111111111111111';

/** A client whose guild knows the given members; any other id is "Unknown Member" (10007), and `broken` ids fail some other way. */
function ctxWith(members: string[], broken: string[] = []) {
  const sets: unknown[][] = [];
  let asked = 0;
  const guild = {
    members: {
      fetch: async (id: string) => {
        asked++;
        if (broken.includes(id)) throw new Error('Discord is down');
        if (!members.includes(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return { id };
      },
    },
  };
  const client = { guilds: { fetch: async () => guild }, application: { commands: { set: async (d: unknown[]) => void sets.push(d) } } };
  const ctx = { client, config: { DISCORD_GUILD_ID: G }, store: new Store(':memory:') } as unknown as AppContext;
  return { ctx, sets, asked: () => asked };
}

describe('commands in a DM with Ordis', () => {
  beforeEach(() => clearMemberCache());

  it('only the personal commands go to DMs, and each one exists', () => {
    const names = COMMANDS.map((c) => c.data.name);
    for (const n of DM_COMMAND_NAMES) assert.ok(names.includes(n), `/${n} is a command`);
    const dm = dmCommandData(COMMANDS).map((d) => d.name);
    assert.deepEqual([...dm].sort(), [...DM_COMMAND_NAMES].sort());
    for (const server of ['setup', 'purge', 'lock', 'backup', 'event', 'lfg', 'roles', 'sticky', 'vc', 'giveaway', 'inactive']) {
      assert.ok(!dm.includes(server), `/${server} stays in the server`);
    }
  });

  it('they are for the bot DM only, so the server does not list them twice', () => {
    for (const d of dmCommandData(COMMANDS)) {
      assert.deepEqual(d.contexts, [1], d.name);
      assert.deepEqual(d.integration_types, [0], d.name);
    }
  });

  it('registers the DM commands once and again only when they change', async () => {
    const { ctx, sets } = ctxWith([]);
    assert.equal(await syncDmCommands(ctx, COMMANDS), true);
    assert.equal(await syncDmCommands(ctx, COMMANDS), false, 'nothing changed');
    assert.equal(sets.length, 1);
    assert.equal(await syncDmCommands(ctx, COMMANDS.slice(0, 3)), true, 'a different list is sent');
  });

  it('a member of the server may use them, anyone else may not', async () => {
    const { ctx } = ctxWith(['member']);
    assert.equal(await isClanMember(ctx, 'member'), true);
    assert.equal(await isClanMember(ctx, 'stranger'), false);
  });

  it('asks Discord once for a while, not on every command', async () => {
    const { ctx, asked } = ctxWith(['member']);
    const t = 1_000_000;
    await isClanMember(ctx, 'member', t);
    await isClanMember(ctx, 'member', t + 60_000);
    assert.equal(asked(), 1, 'kept five minutes');
    await isClanMember(ctx, 'member', t + 6 * 60_000);
    assert.equal(asked(), 2);
    await isClanMember(ctx, 'stranger', t);
    await isClanMember(ctx, 'stranger', t + 30_000);
    assert.equal(asked(), 3, 'a no is kept a minute');
  });

  it('a failure to ask is no answer: it throws and nothing is cached', async () => {
    const { ctx } = ctxWith([], ['unlucky']);
    await assert.rejects(isClanMember(ctx, 'unlucky'), /Discord is down/);
    await assert.rejects(isClanMember(ctx, 'unlucky'), /Discord is down/, 'asked again, not remembered as "not a member"');
  });
});
