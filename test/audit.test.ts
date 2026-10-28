import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db.js';
import { auditEntryEmbed, bulkDeleteEmbed, clip, describeChange, humanAction, memberLeaveEmbed, messageDeleteEmbed, messageEditEmbed, targetLabel, voiceEmbed } from '../src/logging/format.js';
import { auditChannelId, skipMessage } from '../src/logging/service.js';
import { startEmbed, startKind, stopEmbed } from '../src/lifecycle.js';

const fields = (e: { data: { fields?: { name: string; value: string }[] } }) => Object.fromEntries((e.data.fields ?? []).map((f) => [f.name, f.value]));

describe('audit embeds', () => {
  it('shows who wrote a deleted message, where, and what it said', () => {
    const e = messageDeleteEmbed({ authorId: '1', authorName: 'rat', channelId: '2', content: 'hello', attachments: ['a.png'], createdAt: 1_700_000_000_000 });
    assert.equal(e.data.title, '🗑️ Message deleted');
    assert.equal(e.data.description, 'hello');
    assert.match(fields(e).Author!, /<@1> · rat/);
    assert.equal(fields(e).Channel, '<#2>');
    assert.equal(fields(e).Attachments, 'a.png');
  });

  it('says so when a deleted message was not cached', () => {
    const e = messageDeleteEmbed({ authorId: null, authorName: null, channelId: '2', content: null, attachments: [], createdAt: null });
    assert.match(fields(e).Author!, /not cached/);
    assert.match(e.data.description!, /not cached/);
  });

  it('shows an edit before and after, clipped', () => {
    const e = messageEditEmbed({ authorId: '1', authorName: 'rat', channelId: '2', messageUrl: 'https://discord.com/channels/1/2/3', before: 'a'.repeat(2000), after: 'new' });
    assert.ok(fields(e).Before!.length <= 1000);
    assert.equal(fields(e).After, 'new');
  });

  it('summarizes a bulk delete', () => {
    const e = bulkDeleteEmbed('2', 40, Array.from({ length: 40 }, (_, i) => `line ${i}`));
    assert.match(e.data.title!, /40 messages/);
    assert.match(e.data.description!, /and 25 more/);
  });

  it('describes role changes by who, whom and what', () => {
    const e = auditEntryEmbed({
      actionName: 'MemberRoleUpdate',
      executorId: '9',
      targetId: '1',
      reason: 'promoted',
      changes: [{ key: '$add', new: [{ id: '5', name: 'Rat Squire' }] }, { key: '$remove', new: [{ id: '6', name: 'Rat Peasant' }] }],
      extra: null,
    });
    assert.match(e.data.title!, /Member role update/);
    assert.equal(fields(e).By, '<@9>');
    assert.equal(fields(e).Target, '<@1>');
    assert.match(e.data.description!, /➕ Added: <@&5>/);
    assert.match(e.data.description!, /➖ Removed: <@&6>/);
    assert.equal(fields(e).Reason, 'promoted');
  });

  it('formats names, targets and plain changes', () => {
    assert.equal(humanAction('ChannelOverwriteUpdate'), 'Channel overwrite update');
    assert.equal(targetLabel('RoleCreate', '7'), '<@&7>');
    assert.equal(targetLabel('ChannelDelete', '8'), '<#8>');
    assert.equal(targetLabel('InviteCreate', 'abc'), '`abc`');
    assert.equal(describeChange({ key: 'name', old: 'general', new: 'chat' }), '**name**: general → chat');
    assert.equal(describeChange({ key: 'topic', old: null, new: 'hi' }), '**topic**: — → hi');
  });

  it('colors a ban like a removal (not green) and an unban like a plain change', () => {
    const color = (actionName: string) => auditEntryEmbed({ actionName, executorId: '9', targetId: '1', reason: null, changes: [], extra: null }).data.color;
    assert.equal(color('MemberBanAdd'), color('MemberKick'), 'a ban is as severe as a kick');
    assert.equal(color('MemberBanAdd'), color('ChannelDelete'));
    assert.notEqual(color('MemberBanAdd'), color('RoleCreate'), 'the action is called "Add", which used to make it green');
    assert.equal(color('MemberBanRemove'), color('MemberUpdate'), 'an unban is only a change');
  });

  it('describes voice moves and leaves, and ignores no-ops', () => {
    assert.match(voiceEmbed('1', null, '2')!.data.description!, /joined <#2>/);
    assert.match(voiceEmbed('1', '2', '3')!.data.description!, /moved from <#2> to <#3>/);
    assert.match(voiceEmbed('1', '2', null)!.data.description!, /left <#2>/);
    assert.equal(voiceEmbed('1', '2', '2'), null);
  });

  it('lists the roles of a member who left', () => {
    assert.match(fields(memberLeaveEmbed('1', 'rat', ['5', '6'])).Roles!, /<@&5> <@&6>/);
    assert.equal(clip('abcdef', 4), 'abc…');
  });
});

describe('what is logged', () => {
  const ctx = (store: Store) => ({ store, config: { DISCORD_GUILD_ID: 'g' }, client: { user: { id: 'bot' } } }) as never;

  it('uses the audit log channel, else the moderation log channel', () => {
    const s = new Store(':memory:');
    assert.equal(auditChannelId(ctx(s)), null);
    s.updateSettings('g', { modLogChannelId: 'mod' });
    assert.equal(auditChannelId(ctx(s)), 'mod');
    s.updateSettings('g', { auditLogChannelId: 'audit' });
    assert.equal(auditChannelId(ctx(s)), 'audit');
  });

  it('skips other servers, Ordis itself, the screenshot channel, the log channels and clean channels', () => {
    const s = new Store(':memory:');
    s.updateSettings('g', { ssRolesChannelId: 'ss', auditLogChannelId: 'audit', modLogChannelId: 'mod' });
    s.setSticky({ channelId: 'clean', guildId: 'g', title: null, content: 'x', deleteOthers: true, imageUrl: null, createdBy: 'u' });
    const c = ctx(s);
    const m = (over: object) => skipMessage(c, { guildId: 'g', channelId: 'chat', authorId: 'u', ...over });
    assert.equal(m({}), false);
    assert.equal(m({ guildId: 'other' }), true);
    assert.equal(m({ authorId: 'bot' }), true);
    assert.equal(m({ channelId: 'ss' }), true);
    assert.equal(m({ channelId: 'audit' }), true);
    assert.equal(m({ channelId: 'mod' }), true);
    assert.equal(m({ channelId: 'clean' }), true);
  });
});

describe('status reports', () => {
  it('tells a restart from a crash from a first start', () => {
    assert.equal(startKind('stopped'), 'restart');
    assert.equal(startKind('running'), 'unclean');
    assert.equal(startKind(null), 'first');
    assert.match(String(startEmbed('unclean', null).data.description), /did not shut down cleanly/);
    assert.match(String(stopEmbed('SIGTERM', 90 * 60_000).data.description), /SIGTERM.*1h 30m/);
  });
});
