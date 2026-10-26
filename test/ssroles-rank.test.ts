import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, after } from 'node:test';
import { Store } from '../src/db.js';
import { ocr } from '../src/ssroles/ocr.js';
import { type OcrLine, parseCard, parseRankRow } from '../src/ssroles/parse.js';
import { type RoleInfo, masteryOfRoleName, planClanRank } from '../src/ssroles/roles.js';
import { ownsName } from '../src/ssroles/service.js';
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
