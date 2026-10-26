import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, after } from 'node:test';
import { Store } from '../src/db.js';
import { ocr } from '../src/ssroles/ocr.js';
import { type OcrLine, parseCard, parseRankRow, parseRankRows, rankFromTitle } from '../src/ssroles/parse.js';
import { type RoleInfo, masteryOfRoleName, planClanRank } from '../src/ssroles/roles.js';
import { FINGERPRINT_BYTES, bestSimilarity, splitFingerprints } from '../src/ssroles/emblem.js';
import { learnReferences, ownsName, syncNickname } from '../src/ssroles/service.js';
import { renderStickyEmbeds, stickyImages } from '../src/sticky/service.js';

const line = (text: string): OcrLine => ({ text, x0: 0, y0: 0, x1: 100, y1: 20, confidence: 90 });

describe('roster row parsing', () => {
  it('reads the name and the clan rank', () => {
    assert.deepEqual(parseRankRow([line('#5, TheRareGamer Rat King')]), { rank: 'king', name: 'TheRareGamer' });
    assert.deepEqual(parseRankRow([line('Ws :'), line('Gamer_One Rat Squire'), line('eT 3')]), { rank: 'squire', name: 'Gamer_One' });
  });

  it('forgives one wrong letter in the longer titles, not in the short ones', () => {
    assert.equal(parseRankRow([line('Name1 Rat Sqvire')])?.rank, 'squire');
    assert.equal(parseRankRow([line('Name1 Rat Knlght')])?.rank, 'knight');
    assert.equal(parseRankRow([line('Name1 Rat Kang')]), null);
  });

  it('ignores lines that are not a roster row', () => {
    assert.equal(parseRankRow([line('The Rats Den 69#043'), line('GHOST CLAN RANK 10')]), null);
    assert.deepEqual(parseRankRow([line('Rat King')]), { rank: 'king', name: null });
  });

  it('reads the real example screenshot with OCR', async () => {
    const lines = await ocr.recognize(new Uint8Array(readFileSync(new URL('../assets/ss-roles-example-rank.png', import.meta.url))));
    assert.equal(parseCard(lines).complete, false);
    assert.deepEqual(parseRankRow(lines), { rank: 'king', name: 'TheRareGamer' });
  });
  after(() => ocr.release());
});

describe('clan rank roles', () => {
  const role = (id: string, name: string, position = 10, extra: Partial<RoleInfo> = {}): RoleInfo => ({ id, name, position, managed: false, dangerous: false, ...extra });
  const roles = [role('sq', 'Rat Squire'), role('kn', 'Rat Knight'), role('ba', 'Rat Baron'), role('k', 'Rat King', 11, { dangerous: true }), role('mr20', 'MR 20'), role('mr10', 'MR 10')];

  it('gives Rat Squire to anyone and replaces nothing', () => {
    const p = planClanRank(roles, 'squire', new Set(), 50);
    assert.equal(p.add?.id, 'sq');
    assert.deepEqual(p.problems, []);
  });

  it('gives Rat Knight only with MR 16+, replacing Rat Squire', () => {
    assert.match(planClanRank(roles, 'knight', new Set(['mr10', 'sq']), 50).problems[0]!, /Mastery Rank 16/);
    const ok = planClanRank(roles, 'knight', new Set(['mr20', 'sq']), 50);
    assert.equal(ok.add?.id, 'kn');
    assert.deepEqual(ok.remove.map((r) => r.id), ['sq']);
  });

  it('never gives Baron or higher from a screenshot', () => {
    for (const rank of ['baron', 'count', 'lord', 'king', 'emperor'] as const) {
      const p = planClanRank(roles, rank, new Set(['mr20']), 50);
      assert.equal(p.add, null, rank);
      assert.match(p.problems[0]!, /leadership/);
    }
  });

  it('refuses roles above the bot and roles that do not exist', () => {
    assert.match(planClanRank(roles, 'squire', new Set(), 5).problems[0]!, /can't hand out/);
    assert.match(planClanRank([role('x', 'Other')], 'squire', new Set(), 50).problems[0]!, /no "Rat Squire" role/);
  });

  it('reads mastery from role names', () => {
    assert.equal(masteryOfRoleName('MR 20'), 20);
    assert.equal(masteryOfRoleName('LR 3'), 33);
    assert.equal(masteryOfRoleName('Rat Knight'), null);
  });
});

describe('roster name ownership', () => {
  it('matches the roster name to a verified "name#tag"', () => {
    assert.equal(ownsName(['theraregamer1234'], 'TheRaireGamer'), false);
    assert.equal(ownsName(['theraregamer1234'], 'TheRareGamer'), true);
    assert.equal(ownsName(['theraregamer'], 'TheRareGamer'), true);
    assert.equal(ownsName(['ratking1234'], 'Rat'), false);
    assert.equal(ownsName(['theraregamer1234'], 'Other'), false);
  });

  it('lists the names a member verified', () => {
    const s = new Store(':memory:');
    s.claimSs('g', 'ign', 'theraregamer1234', 'u1');
    s.claimSs('g', 'ign', 'someoneelse5678', 'u2');
    s.claimSs('g', 'points', '123456', 'u1');
    assert.deepEqual(s.ssNamesOf('g', 'u1'), ['theraregamer1234']);
  });
});

describe('sticky with two pictures', () => {
  it('shows a second picture in its own embed', () => {
    const e = renderStickyEmbeds({ title: 'T', content: 'c', imageUrl: 'https://a.example/1.png https://a.example/2.png' });
    assert.equal(e.length, 2);
    assert.equal(e[0]!.data.image?.url, 'https://a.example/1.png');
    assert.equal(e[1]!.data.image?.url, 'https://a.example/2.png');
    assert.equal(renderStickyEmbeds({ title: null, content: 'c' }).length, 1);
    assert.deepEqual(stickyImages(null), []);
  });
});

describe('nickname', () => {
  const fake = (nickname: string | null, fail = false) => {
    const m = { nickname, calls: [] as string[], setNickname: async (n: string) => (fail ? Promise.reject(new Error('Missing Permissions')) : (m.calls.push(n), m)) };
    return m;
  };

  it('sets the in-game name as the nickname', async () => {
    const m = fake(null);
    assert.deepEqual(await syncNickname(m as never, 'TheRareGamer'), { name: 'TheRareGamer', status: 'set' });
    assert.deepEqual(m.calls, ['TheRareGamer']);
  });

  it('leaves it alone when it already matches or the name is unusable', async () => {
    const m = fake('TheRareGamer');
    assert.equal((await syncNickname(m as never, 'TheRareGamer'))?.status, 'same');
    assert.equal(await syncNickname(m as never, 'x'), null);
    assert.equal(await syncNickname(m as never, null), null);
    assert.deepEqual(m.calls, []);
  });

  it('reports a failure instead of throwing (server owner, members above Ordis)', async () => {
    assert.equal((await syncNickname(fake(null, true) as never, 'TheRareGamer'))?.status, 'failed');
  });
});

describe('two reference pictures', () => {
  const asset = (name: string) => ({ mime: 'image/png', data: new Uint8Array(readFileSync(new URL(`../assets/${name}`, import.meta.url))) });
  const ctx = () => ({ config: { CLAN_NAME: 'The Rats Den 69', DISCORD_GUILD_ID: 'g' }, store: new Store(':memory:') }) as never;

  it('learns the emblem from the profile card and recognizes the roster row', async () => {
    const c = ctx() as { store: Store };
    const r = await learnReferences(c as never, [asset('ss-roles-example.png'), asset('ss-roles-example-rank.png')]);
    assert.equal(r.clanText, 'The Rats Den 69#043');
    assert.equal(r.cards, 1);
    assert.deepEqual(r.rows, [{ rank: 'king', name: 'TheRareGamer' }]);
    assert.equal(c.store.getSsReference('g')?.fingerprint.length, FINGERPRINT_BYTES);
  });

  it('keeps two card fingerprints and matches the better one', async () => {
    const c = ctx() as { store: Store };
    const r = await learnReferences(c as never, [asset('ss-roles-example.png'), asset('ss-roles-example.png')]);
    assert.equal(r.cards, 2);
    assert.equal(c.store.getSsReference('g')?.fingerprint.length, 2 * FINGERPRINT_BYTES);
  });

  it('refuses a picture that is neither', async () => {
    await assert.rejects(learnReferences(ctx(), [asset('clan-logo.png')]), /neither|couldn't read/);
  });

  it('splits stored fingerprints and takes the best similarity', () => {
    const a = Uint8Array.from({ length: FINGERPRINT_BYTES }, (_, i) => i % 256);
    const b = Uint8Array.from({ length: FINGERPRINT_BYTES }, (_, i) => (i * 7) % 256);
    const blob = new Uint8Array(2 * FINGERPRINT_BYTES);
    blob.set(a, 0);
    blob.set(b, FINGERPRINT_BYTES);
    assert.equal(splitFingerprints(blob).length, 2);
    assert.ok(bestSimilarity(b, blob) > 0.99);
    assert.ok(bestSimilarity(a, blob) > 0.99);
  });
  after(() => ocr.release());
});

describe('roster rows on a whole member list or split columns', () => {
  const at = (text: string, x0: number, y0: number): OcrLine => ({ text, x0, y0, x1: x0 + 100, y1: y0 + 20, confidence: 90 });

  it('finds the rank anywhere in the line, not only at its end', () => {
    assert.deepEqual(parseRankRow([line('TheRareGamer Rat Knight  2 days ago')]), { rank: 'knight', name: 'TheRareGamer' });
  });

  it('joins a name and a rank that OCR returned as separate boxes on the same row', () => {
    assert.deepEqual(parseRankRow([at('TheRareGamer', 100, 10), at('Rat Squire', 500, 12)]), { rank: 'squire', name: 'TheRareGamer' });
  });

  it('returns every row of a whole member list', () => {
    const rows = parseRankRows([at('Alpha Rat Squire', 0, 0), at('Bravo Rat Knight', 0, 40), at('TheRareGamer Rat King', 0, 80)]);
    assert.deepEqual(rows.map((r) => `${r.name}:${r.rank}`), ['Alpha:squire', 'Bravo:knight', 'TheRareGamer:king']);
  });

  it('turns a title into a rank', () => {
    assert.equal(rankFromTitle('Rat Squire'), 'squire');
    assert.equal(rankFromTitle('KNIGHT'), 'knight');
    assert.equal(rankFromTitle('Warlord'), null);
  });
});
