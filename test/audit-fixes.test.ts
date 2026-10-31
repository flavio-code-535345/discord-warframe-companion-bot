import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { dropsEmbed } from '../src/discord/embeds.js';
import { UserError, createClanEvent } from '../src/services/clan.js';
import { parseWhen } from '../src/time.js';
import { describeAnswer } from '../src/warframe/worldstate.js';
import type { WorldState } from '../src/warframe/worldstate.js';
import { buildStatus } from '../src/web/status.js';

const GUILD = '111111111111111111';
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = 86_400_000;

const ctx = (): AppContext => ({
  config: loadConfig({ DISCORD_TOKEN: 'x', DISCORD_GUILD_ID: GUILD }),
  store: new Store(':memory:'),
  client: { isReady: () => false } as unknown as Client,
});

describe('dates that cannot be shown', () => {
  it('parseWhen refuses an offset beyond what a Date can hold, and still takes a far but real one', () => {
    assert.equal(parseWhen('99999999d', NOW), null);
    assert.equal(parseWhen('99999999999999w', NOW), null);
    assert.equal(parseWhen('5000d', NOW), NOW + 5000 * DAY);
  });

  it('createClanEvent turns away a start in the past, one more than two years away, and one that is not a number', async () => {
    const c = ctx();
    const input = (startsAt: number) => ({ guildId: GUILD, title: 'Eidolons', description: null, startsAt, createdBy: 'u1', channelId: null }) as never;
    await assert.rejects(createClanEvent(c, input(Date.now() - 1000)), (err) => err instanceof UserError && /in the future/.test(err.message));
    await assert.rejects(createClanEvent(c, input(Number.NaN)), /in the future/);
    await assert.rejects(createClanEvent(c, input(Date.now() + 3 * 365 * DAY)), (err) => err instanceof UserError && /more than two years away/.test(err.message));
    assert.deepEqual(c.store.upcomingEvents(GUILD), [], 'nothing was stored');
  });

  it('the status page leaves out an event with an impossible start instead of failing', async () => {
    const c = ctx();
    c.store.createEvent({ guildId: GUILD, title: 'Typo', description: null, startsAt: 9e15, createdBy: 'u1' });
    c.store.createEvent({ guildId: GUILD, title: 'Real', description: null, startsAt: Date.now() + 3_600_000, createdBy: 'u1' });
    const s = await buildStatus(c, async () => ({}) as WorldState);
    assert.deepEqual(s.upcomingEvents.map((e) => e.title), ['Real']);
  });
});

describe('a feed with parts missing', () => {
  it('still gives the world tiles when the cycles are absent', async () => {
    const later = new Date(Date.now() + 3_600_000);
    const ws = { sortie: { boss: 'Alad V', faction: 'Corpus', expiry: later, variants: [] } } as unknown as WorldState;
    const s = await buildStatus(ctx(), async () => ws);
    assert.equal(s.world?.sortie?.boss, 'Alad V');
  });

  it('describes a page that is not JSON on one line', () => {
    const text = describeAnswer('<html>\n  <body>   Just a moment...\n</body></html>');
    assert.match(text, /answered something that is not JSON: "<html> <body> Just a moment... <\/body><\/html>"/);
    assert.ok(!/\n/.test(text));
  });
});

describe('long input in an embed', () => {
  it('the drops embed keeps its title inside the 256 characters Discord allows', () => {
    const embed = dropsEmbed('x'.repeat(300), []);
    assert.ok(embed.data.title!.length <= 256, `${embed.data.title!.length} characters`);
    assert.match(embed.data.title!, /Drop locations: x+/);
  });
});
