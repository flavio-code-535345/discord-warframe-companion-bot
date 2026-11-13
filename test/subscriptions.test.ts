import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ChannelType, MessageFlags } from 'discord.js';
import type { AppContext } from '../src/context.js';
import { Store } from '../src/db.js';
import { handleButton } from '../src/discord/buttons.js';
import { track } from '../src/discord/commands/track.js';
import { componentText } from '../src/discord/feeds/parts.js';
import { ROLE_SUBSCRIPTIONS, convertPingRoles, pingRoleConversion } from '../src/discord/ping-roles.js';
import { handleNotifyButton, notifyClanEvent, notifySquad, subscribe, subscribersOf, unsubscribe } from '../src/discord/subscriptions.js';
import { createSquad } from '../src/lfg/squads.js';
import { postRolesPanel } from '../src/selfroles/service.js';
import { UserError } from '../src/services/clan.js';
import { MAX_TRACKERS_PER_USER, type TrackerSpec } from '../src/trackers.js';

const G = '111111111111111111';
const LEGACY = `legacy_ping_roles:${G}`;

interface Post {
  channel: string;
  payload: Record<string, unknown>;
}

/** A bot with a real database, DMs that are recorded instead of sent, and channels that record what is posted in them. */
function world(opts: { closedDms?: string[]; failSendIn?: string[]; memberListFails?: boolean } = {}) {
  const store = new Store(':memory:');
  const dms: { to: string; text: string }[] = [];
  const posts: Post[] = [];
  const edits: Post[] = [];
  const deleted: string[] = [];
  const members = new Map<string, unknown>();
  const roles = new Map<string, { name: string }>();
  const guildChannels = new Map<string, Record<string, unknown>>();
  let messages = 0;
  let voices = 0;
  const channel = (id: string) => ({
    id,
    guildId: G,
    isSendable: () => true,
    send: async (payload: Record<string, unknown>) => {
      if (opts.failSendIn?.includes(id)) throw new Error('Missing Access');
      posts.push({ channel: id, payload });
      return { id: `m${++messages}`, channelId: id };
    },
    messages: {
      fetch: async (messageId: string) => ({ id: messageId, edit: async (payload: Record<string, unknown>) => void edits.push({ channel: id, payload }) }),
      delete: async () => {},
    },
  });
  const guild = {
    id: G,
    roles: { cache: roles },
    members: {
      fetch: async () => {
        if (opts.memberListFails) throw new Error('Missing Access');
        return members;
      },
    },
    channels: {
      cache: guildChannels,
      fetch: async (id: string) => guildChannels.get(id) ?? null,
      create: async (o: { name: string }) => {
        const id = `voice${++voices}`;
        const voice = { id, name: o.name, isVoiceBased: () => true, delete: async () => void deleted.push(id) };
        guildChannels.set(id, voice);
        return voice;
      },
    },
  };
  const client = {
    user: null,
    users: {
      fetch: async (id: string) => ({
        send: async (payload: { components: { toJSON(): unknown }[] }) => {
          if (opts.closedDms?.includes(id)) throw new Error('Cannot send messages to this user');
          dms.push({ to: id, text: componentText(payload.components) });
        },
      }),
    },
    channels: { fetch: async (id: string) => channel(id) },
    guilds: { fetch: async () => guild },
  };
  const ctx = { config: { CLAN_NAME: 'The Rats Den 69', BOT_NAME: 'Cephalon Ordis', DISCORD_GUILD_ID: G }, client, store } as unknown as AppContext;
  return {
    ctx,
    store,
    dms,
    posts,
    edits,
    deleted,
    roles,
    guildChannels,
    /** A channel as `/lfg` hands it over: the one the command ran in. */
    asked: (id: string) => channel(id) as never,
    member: (id: string, roleIds: string[], bot = false) => void members.set(id, { id, user: { bot }, roles: { cache: new Set(roleIds) } }),
    specs: (userId: string) => store.listTrackers(G, userId).map((t) => JSON.parse(t.spec) as TrackerSpec),
    kinds: (userId: string) => store.listTrackers(G, userId).map((t) => (JSON.parse(t.spec) as TrackerSpec).kind).sort(),
  };
}

/** A tap on a button: the interaction, and what it was answered with. */
function tap(userId: string, customId = '') {
  const replies: { content: string; flags?: number }[] = [];
  const interaction = { customId, user: { id: userId }, reply: async (p: { content: string; flags?: number }) => void replies.push(p) };
  return { interaction: interaction as never, replies };
}

/** The custom IDs of a message's buttons, row by row. */
const buttonRows = (payload: Record<string, unknown>) =>
  (payload.components as { toJSON(): { components: { custom_id: string }[] } }[]).map((row) => row.toJSON().components.map((c) => c.custom_id));

describe('a notification is added once and removed by what it says', () => {
  it('adds it, knows it again whatever the order of its fields, and removes it', () => {
    const { ctx, specs } = world();
    assert.equal(subscribe(ctx, 'u1', { kind: 'arbitration', type: 'Defense', minTier: 'A' }), 'added');
    assert.equal(subscribe(ctx, 'u1', { minTier: 'A', kind: 'arbitration', type: 'Defense' }), 'had');
    assert.equal(subscribe(ctx, 'u1', { kind: 'arbitration', minTier: 'S' }), 'added', 'another tier is another notification');
    assert.equal(subscribe(ctx, 'u2', { kind: 'arbitration', type: 'Defense', minTier: 'A' }), 'added', 'each member has their own');
    assert.equal(specs('u1').length, 2);

    assert.equal(unsubscribe(ctx, 'u1', { type: 'Defense', minTier: 'A', kind: 'arbitration' }), true);
    assert.equal(unsubscribe(ctx, 'u1', { kind: 'arbitration', type: 'Defense', minTier: 'A' }), false, 'nothing left to remove');
    assert.deepEqual(specs('u1'), [{ kind: 'arbitration', minTier: 'S' }]);
    assert.equal(specs('u2').length, 1, "another member's is untouched");
  });

  it('stops at the limit per member, except when it moves something the member already had', () => {
    const { ctx, specs } = world();
    for (let i = 0; i < MAX_TRACKERS_PER_USER; i++) assert.equal(subscribe(ctx, 'u1', { kind: 'reward', keyword: `item ${i}` }), 'added');
    assert.equal(subscribe(ctx, 'u1', { kind: 'baro' }), 'full');
    assert.equal(subscribe(ctx, 'u1', { kind: 'reward', keyword: 'item 3' }), 'had', 'one they have is still recognised at the limit');
    assert.equal(subscribe(ctx, 'u1', { kind: 'baro' }, { force: true }), 'added');
    assert.equal(specs('u1').length, MAX_TRACKERS_PER_USER + 1);
  });

  it('lists each member once, however many of their notifications fit', () => {
    const { ctx, store } = world();
    subscribe(ctx, 'u1', { kind: 'squad' });
    subscribe(ctx, 'u1', { kind: 'squad', activity: 'Eidolon Hunt' });
    subscribe(ctx, 'u2', { kind: 'weekly' });
    store.createTracker(G, 'u3', 'not json');
    assert.deepEqual(subscribersOf(ctx, (s) => s.kind === 'squad'), ['u1']);
    assert.deepEqual(subscribersOf(ctx, (s) => s.kind === 'weekly'), ['u2']);
    assert.deepEqual(subscribersOf(ctx, () => true).sort(), ['u1', 'u2'], 'a tracker that cannot be read is nobody');
  });
});

describe('the on/off buttons', () => {
  for (const key of ['weekly', 'clanEvent', 'squad'] as const) {
    it(`notify:${key} switches that DM on, and off again with the next tap`, async () => {
      const { ctx, specs } = world();
      const { interaction, replies } = tap('u1');
      await handleNotifyButton(interaction, ctx, key);
      assert.deepEqual(specs('u1'), [{ kind: key }]);
      assert.match(replies[0]!.content, /^Done: .* Make sure Direct Messages from server members are on/);
      await handleNotifyButton(interaction, ctx, key);
      assert.deepEqual(specs('u1'), []);
      assert.match(replies[1]!.content, /^No more /);
      assert.deepEqual(replies.map((r) => r.flags), [MessageFlags.Ephemeral, MessageFlags.Ephemeral], 'only the member sees the answer');
    });
  }

  it('routes the buttons by their custom ID, the one from before the rename included', async () => {
    const { ctx, specs } = world();
    await handleButton(tap('u1', 'weekly:toggle').interaction, ctx);
    assert.deepEqual(specs('u1'), [{ kind: 'weekly' }]);
    await handleButton(tap('u1', 'notify:weekly').interaction, ctx);
    assert.deepEqual(specs('u1'), [], 'both IDs are the same switch');
    await handleButton(tap('u1', 'notify:squad').interaction, ctx);
    await handleButton(tap('u1', 'notify:clanEvent').interaction, ctx);
    assert.deepEqual(specs('u1'), [{ kind: 'squad' }, { kind: 'clanEvent' }]);
  });

  it('refuses a button it does not know', async () => {
    const { ctx, specs } = world();
    const unknown = (err: unknown) => err instanceof UserError && /no longer supported/.test(err.message);
    await assert.rejects(handleNotifyButton(tap('u1').interaction, ctx, 'baro'), unknown);
    await assert.rejects(handleNotifyButton(tap('u1').interaction, ctx, 'constructor'), unknown, 'a name every object has is not a notification');
    await assert.rejects(handleButton(tap('u1', 'notify:').interaction, ctx), unknown);
    assert.deepEqual(specs('u1'), []);
  });

  it('says so at the limit instead of adding one more, and still switches one off there', async () => {
    const { ctx, specs } = world();
    for (let i = 0; i < MAX_TRACKERS_PER_USER - 1; i++) subscribe(ctx, 'u1', { kind: 'reward', keyword: `item ${i}` });
    await handleNotifyButton(tap('u1').interaction, ctx, 'weekly');
    await assert.rejects(handleNotifyButton(tap('u1').interaction, ctx, 'squad'), (err) => err instanceof UserError && /already have 15 notifications/.test(err.message));
    assert.equal(specs('u1').length, MAX_TRACKERS_PER_USER);
    const off = tap('u1');
    await handleNotifyButton(off.interaction, ctx, 'weekly');
    assert.match(off.replies[0]!.content, /^No more weekly DMs/);
    assert.equal(specs('u1').length, MAX_TRACKERS_PER_USER - 1);
  });
});

describe('a new clan event', () => {
  it('is sent as a DM to everyone who asked, except whoever created it', async () => {
    const { ctx, store, dms } = world({ closedDms: ['u3'] });
    for (const id of ['host', 'u1', 'u2', 'u3']) subscribe(ctx, id, { kind: 'clanEvent' });
    subscribe(ctx, 'u4', { kind: 'squad' });
    const event = store.createEvent({ guildId: G, title: 'Eidolon night', description: 'Bring a Lanka', startsAt: Date.now() + 3_600_000, createdBy: 'host' });
    const sent = await notifyClanEvent(ctx, event, 'https://discord.com/channels/1/2/3');
    assert.equal(sent, 2, 'a member with closed DMs is not counted, and nothing throws');
    assert.deepEqual(dms.map((d) => d.to).sort(), ['u1', 'u2']);
    assert.match(dms[0]!.text, /New clan event: Eidolon night/);
    assert.match(dms[0]!.text, /Bring a Lanka/);
    assert.match(dms[0]!.text, /\[Open the event to RSVP\]/);
  });
});

describe('a new squad', () => {
  it('is sent as a DM to those who asked for every squad or for this activity, not to its host', async () => {
    const { ctx, store, dms } = world();
    subscribe(ctx, 'all', { kind: 'squad' });
    subscribe(ctx, 'same', { kind: 'squad', activity: 'eidolon hunt ' });
    subscribe(ctx, 'other', { kind: 'squad', activity: 'Netracells' });
    subscribe(ctx, 'both', { kind: 'squad' });
    subscribe(ctx, 'both', { kind: 'squad', activity: 'Eidolon Hunt' });
    subscribe(ctx, 'host', { kind: 'squad' });
    const post = store.createLfg({ guildId: G, channelId: 'c1', hostId: 'host', activity: 'Eidolon Hunt', details: '3x3, bring Volt', size: 4 });
    const sent = await notifySquad(ctx, post, 'https://discord.com/channels/1/2/3', 'Clem');
    assert.equal(sent, 3);
    assert.deepEqual(dms.map((d) => d.to).sort(), ['all', 'both', 'same'], 'each once; the host and the other activity not at all');
    assert.match(dms[0]!.text, /Clem is looking for a squad\n\*\*Eidolon Hunt\*\* · 4 players/);
    assert.doesNotMatch(dms[0]!.text, /voice channel/);
    assert.match(dms[0]!.text, /3x3, bring Volt/);
    assert.match(dms[0]!.text, /\[Open the squad to join\]/);
  });

  it("is posted in its activity's channel, else where it was asked for, else in the squads channel", async () => {
    const { ctx, store, posts, asked } = world();
    store.saveActivity({ name: 'Eidolon Hunt', imageUrl: null, channelId: 'c-eidolon' });
    store.updateSettings(G, { lfgChannelId: 'c-lfg' });
    const a = await createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'eidolon hunt', channel: asked('c-asked') });
    assert.equal(a.channelId, 'c-eidolon', "the activity's own channel wins");
    const b = await createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells', channel: asked('c-asked') });
    assert.equal(b.channelId, 'c-asked');
    const c = await createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells' });
    assert.equal(c.channelId, 'c-lfg', 'a squad started from a button has no channel it was asked in');
    assert.deepEqual(posts.map((p) => p.channel), ['c-eidolon', 'c-asked', 'c-lfg']);
    assert.deepEqual(posts.map((p) => p.payload.allowedMentions), [{ parse: [] }, { parse: [] }, { parse: [] }], 'nobody is pinged');
    assert.equal(c.url, `https://discord.com/channels/${G}/c-lfg/${store.getLfg(c.post.id)!.messageId}`);
    assert.equal(c.voiceChannelId, null, 'no voice channel while squad voice is not set up');
  });

  it('needs somewhere to post', async () => {
    const { ctx } = world();
    await assert.rejects(createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells' }), (err) => err instanceof UserError && /\/setup lfg/.test(err.message));
  });

  it('tells the subscribers, keeps the size between two and four and remembers when it ends', async () => {
    const { ctx, dms, asked } = world();
    subscribe(ctx, 'u1', { kind: 'squad' });
    subscribe(ctx, 'h1', { kind: 'squad' });
    const ends = Date.now() + 1_800_000;
    const big = await createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells', size: 9, details: 'Two runs', expiresAt: ends, channel: asked('c1') });
    assert.equal(big.post.size, 4);
    assert.equal(big.post.expiresAt, ends);
    const small = await createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells', size: 1, channel: asked('c1') });
    assert.equal(small.post.size, 2);
    assert.equal(small.post.expiresAt, null);
    assert.deepEqual(dms.map((d) => d.to), ['u1', 'u1'], 'the host hears nothing about their own squad');
    assert.match(dms[0]!.text, /Clem is looking for a squad\n\*\*Netracells\*\* · 4 players\nTwo runs/);
  });

  it('gets a voice channel when squad voice is set up, one open squad per host', async () => {
    const { ctx, store, dms, guildChannels } = world();
    guildChannels.set('cat', { type: ChannelType.GuildCategory });
    store.updateSettings(G, { lfgVoiceCategoryId: 'cat', lfgChannelId: 'c-lfg' });
    subscribe(ctx, 'u1', { kind: 'squad' });
    const squad = await createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells' });
    assert.equal(squad.voiceChannelId, 'voice1');
    assert.equal(squad.post.voiceChannelId, 'voice1');
    assert.ok(squad.post.hostAbsentSince, 'the host counts as absent from the start, so a squad whose host never joins still ends');
    assert.match(dms[0]!.text, /4 players · with a voice channel/);
    await assert.rejects(createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Sortie' }), (err) => err instanceof UserError && /already have an open squad/.test(err.message));
    assert.equal((await createSquad(ctx, { hostId: 'h2', hostName: 'Darvo', activity: 'Sortie' })).voiceChannelId, 'voice2', 'another host can');
  });

  it('leaves nothing behind when the post cannot be sent', async () => {
    const { ctx, store, dms, deleted, guildChannels } = world({ failSendIn: ['c-lfg'] });
    guildChannels.set('cat', { type: ChannelType.GuildCategory });
    store.updateSettings(G, { lfgVoiceCategoryId: 'cat', lfgChannelId: 'c-lfg' });
    subscribe(ctx, 'u1', { kind: 'squad' });
    await assert.rejects(createSquad(ctx, { hostId: 'h1', hostName: 'Clem', activity: 'Netracells' }), /Missing Access/);
    assert.deepEqual(deleted, ['voice1'], 'the voice channel is removed again');
    assert.equal(store.openVoiceLfgByHost(G, 'h1'), null, 'and the squad is closed, so the host can try again');
    assert.deepEqual(dms, [], 'nobody is told about a squad that was never posted');
  });
});

describe('the one-time move from ping roles to DMs', () => {
  /** A server as the migration left it: the role IDs on record, some still in the role menu, members holding them. */
  function before(opts?: Parameters<typeof world>[0]) {
    const w = world(opts);
    w.store.setMeta(LEGACY, JSON.stringify({ alerts: 'r-alerts', arbitrations: 'r-arby', baro: null, weekly: 'r-weekly', events: 'r-events', squads: 'r-squads' }));
    w.store.updateSettings(G, { statusChannelId: 'c-logs' });
    // r-squads was deleted by hand before: the summary falls back on what it was for.
    for (const [id, name] of [['r-alerts', 'Alerts'], ['r-arby', 'Arbitrations'], ['r-weekly', 'Weeklies'], ['r-events', 'Clan Events']] as const) w.roles.set(id, { name });
    w.store.upsertSelfRole(G, { roleId: 'r-pc', group: 'Platform', label: 'PC', emoji: null, description: null, position: 0 });
    w.store.upsertSelfRole(G, { roleId: 'r-alerts', group: 'Pings', label: 'Alerts', emoji: null, description: null, position: 1 });
    w.store.upsertSelfRole(G, { roleId: 'r-events', group: 'Pings', label: 'Clan Events', emoji: null, description: null, position: 2 });
    w.member('a', ['r-alerts', 'r-weekly', 'r-pc']);
    w.member('b', ['r-events']);
    w.member('c', ['r-pc']);
    w.member('bot', ['r-alerts'], true);
    return w;
  }

  it('maps each old role to the notification that says the same', () => {
    assert.deepEqual(ROLE_SUBSCRIPTIONS, {
      alerts: { kind: 'notable' },
      arbitrations: { kind: 'arbitration', minTier: 'A' },
      baro: { kind: 'baro' },
      weekly: { kind: 'weekly' },
      events: { kind: 'clanEvent' },
      squads: { kind: 'squad' },
    });
  });

  it('gives every holder their notification, takes the roles out of the menu and tells the members and the staff', async () => {
    const w = before();
    await postRolesPanel(w.ctx, 'c-roles');
    const result = await convertPingRoles(w.ctx);
    assert.ok(result);
    assert.deepEqual(w.kinds('a'), ['notable', 'weekly']);
    assert.deepEqual(w.specs('b'), [{ kind: 'clanEvent' }]);
    assert.deepEqual(w.specs('c'), [], 'a member with no ping role gets nothing');
    assert.deepEqual(w.specs('bot'), [], 'neither does a bot that holds one');
    assert.deepEqual(result.roles, [
      { id: 'r-alerts', name: 'Alerts' },
      { id: 'r-arby', name: 'Arbitrations' },
      { id: 'r-weekly', name: 'Weeklies' },
      { id: 'r-events', name: 'Clan Events' },
      { id: 'r-squads', name: 'squads' },
    ]);
    assert.equal(result.members, 2);
    assert.equal(result.subscriptions, 3);

    // The ping roles are no longer offered, and the panel that was posted is redrawn without them.
    assert.deepEqual(w.store.listSelfRoles(G).map((r) => r.roleId), ['r-pc']);
    assert.equal(w.edits.length, 1);
    assert.equal(w.edits[0]!.channel, 'c-roles');
    assert.deepEqual(buttonRows(w.edits[0]!.payload), [['roles:r-pc'], ['notify:clanEvent', 'notify:squad', 'notify:weekly', 'feeds:mine']]);

    // Each member moved is told what they have now.
    assert.deepEqual(w.dms.map((d) => d.to).sort(), ['a', 'b']);
    const toA = w.dms.find((d) => d.to === 'a')!.text;
    assert.match(toA, /Your notifications are DMs now/);
    assert.match(toA, /You had the \*\*Alerts\*\*, \*\*Weeklies\*\* roles, so Ordis keeps telling you about:/);
    assert.match(toA, /• Any alert or invasion with a reward worth running/);
    assert.match(toA, /• The weekly reset summary \(Mondays\)/);
    assert.match(w.dms.find((d) => d.to === 'b')!.text, /You had the \*\*Clan Events\*\* role, so/);

    // The staff get the summary, with the roles nothing uses any more.
    const notice = w.posts.find((p) => p.channel === 'c-logs')!;
    const embed = (notice.payload.embeds as { toJSON(): { description: string; fields: { name: string; value: string }[] } }[])[0]!.toJSON();
    assert.match(embed.description, /2 members held a ping role and now have the same notification as a DM \(3 added\)/);
    assert.equal(embed.fields[0]!.value, ['<@&r-alerts> (Alerts)', '<@&r-arby> (Arbitrations)', '<@&r-weekly> (Weeklies)', '<@&r-events> (Clan Events)', '<@&r-squads> (squads)'].join('\n'));
    assert.deepEqual(notice.payload.allowedMentions, { parse: [] }, 'listing the roles pings nobody');

    // Once only.
    assert.deepEqual(pingRoleConversion(w.ctx), result);
    assert.equal(await convertPingRoles(w.ctx), null);
    assert.equal(w.dms.length, 2, 'the next start tells nobody again');
  });

  it('does not double a notification the member already had, and goes past the limit rather than dropping one', async () => {
    const w = before();
    subscribe(w.ctx, 'b', { kind: 'clanEvent' });
    for (let i = 0; i < MAX_TRACKERS_PER_USER; i++) subscribe(w.ctx, 'a', { kind: 'reward', keyword: `item ${i}` });
    const result = await convertPingRoles(w.ctx);
    assert.equal(result!.members, 2, 'b held the role, so b is still told');
    assert.equal(result!.subscriptions, 2, 'only what was really added is counted');
    assert.equal(w.specs('b').length, 1);
    assert.equal(w.specs('a').length, MAX_TRACKERS_PER_USER + 2);
  });

  it('waits for the next start when the member list cannot be read', async () => {
    const w = before({ memberListFails: true });
    assert.equal(await convertPingRoles(w.ctx), null);
    assert.equal(pingRoleConversion(w.ctx), null);
    assert.ok(w.store.getMeta(LEGACY), 'the roles are still on record');
    assert.equal(w.store.listSelfRoles(G).length, 3, 'and nothing left the menu');
    assert.deepEqual(w.dms, []);
    assert.deepEqual(w.posts, []);
  });

  it('has nothing to do on a server that never had ping roles, or with a record it cannot read', async () => {
    const fresh = world();
    assert.equal(await convertPingRoles(fresh.ctx), null);
    const broken = world();
    broken.store.setMeta(LEGACY, '{not json');
    assert.equal(await convertPingRoles(broken.ctx), null);
    assert.equal(broken.store.getMeta(LEGACY) || '', '', 'the unreadable record is dropped');
    assert.deepEqual(broken.posts, []);
  });
});

describe('/track', () => {
  /** Runs a /track subcommand for a member; `replies` collects what they were told. */
  function command(w: ReturnType<typeof world>, userId = 'u1') {
    const replies: string[] = [];
    const run = (sub: string, strings: Record<string, string> = {}) =>
      track.execute(
        {
          user: { id: userId },
          options: { getSubcommand: () => sub, getString: (name: string) => strings[name] ?? null, getBoolean: () => null, getInteger: () => null },
          reply: async (p: { content: string }) => void replies.push(p.content),
        } as never,
        w.ctx,
      );
    return { run, replies };
  }

  it('adds the notifications that took the place of the roles, and refuses the same one twice', async () => {
    const w = world();
    const { run, replies } = command(w);
    await run('notable');
    assert.match(replies[0]!, /Tracker \*\*#\d+\*\* set: Any alert or invasion with a reward worth running\. Ordis will DM you when it appears/);
    await run('events');
    assert.match(replies[1]!, /New clan events\. Ordis will DM you when it happens/);
    await run('squads', { activity: ' Eidolon Hunt ' });
    await run('squads');
    assert.match(replies[2]!, /Squads for Eidolon Hunt \(\/lfg\)/);
    assert.match(replies[3]!, /Every squad someone posts with \/lfg/);
    await assert.rejects(run('notable'), (err) => err instanceof UserError && /already have that one: Any alert or invasion/.test(err.message));
    await assert.rejects(run('squads', { activity: 'Eidolon Hunt' }), UserError);
    assert.deepEqual(w.kinds('u1'), ['clanEvent', 'notable', 'squad', 'squad']);
  });

  it('knows a notification switched on with a button as the same one', async () => {
    const w = world();
    await handleNotifyButton(tap('u1').interaction, w.ctx, 'weekly');
    await assert.rejects(command(w).run('weekly'), /already have that one/);
    assert.deepEqual(w.specs('u1'), [{ kind: 'weekly' }]);
  });
});
