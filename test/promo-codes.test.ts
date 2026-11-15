import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { datePromoCodes, datesLine, dayToMs, expiryText, parseActiveCodes, parseDates, promoPanel, promoTextFromSource, summarizeRewards } from '../src/discord/promo-codes.js';
import { Store } from '../src/db.js';

const NOW = Date.UTC(2026, 10, 3);
/** The codes without their items list, which has its own checks. */
const noItems = <T extends { items: string[] }>(codes: T[]) => codes.map(({ items: _, ...c }) => c);
/** The wiki page as the local index gives it (real rows, shortened). */
const PAGE = `== Introduction ==
Promo Codes for WARFRAME can be entered in the in-game Market.

== Active Codes ==
List of active global codes.
Code · Type · Context · Dates Active · Reward(s) · References
SPECIALEFFECT · Glyph · Special Effect Glyph
Parvos · Decoration · Adds Golden Hand decoration
MISTLETOE2025 · Glyph · 2025-12-25 · Marie Leroux Mistletoe Community Glyph Lyon Allard Mistletoe Community Glyph
Pride2026 · Glyph; Displays · Pride Year 2026 · 2026-07-01 to 2027-05-31 · Pride Lotus Symbol Glyph, Pride Frame Display
CARRYTHEFIRE · Glyph · Conquera 2026 · 2026-10-01 to Indefinite · Carry The Fire with Sprite! Glyph
MOVEMBER2026 · Displays · Movember 2026 · 2026-11-02 to ? · Movember Sirius And Orion Community Display · Movember Shopkeep Moustache Display Frame

== Inactive Codes ==
If you try to redeem any of the expired codes, a message pops up.
Code · Type · Context · Dates Active · Reward(s) · References
Conquer · Cosmetics · Quest to Conquer Cancer 2020 · 2020-11-02 to 2021-01-11 · Conquera Glyph and Sigil`;

describe('reading the active promo codes', () => {
  it('takes every code under Active Codes with its rewards, and nothing from Inactive Codes', () => {
    assert.deepEqual(noItems(parseActiveCodes(PAGE, NOW)), [
      { code: 'SPECIALEFFECT', reward: 'Special Effect Glyph' },
      { code: 'Parvos', reward: 'Golden Hand decoration' },
      { code: 'MISTLETOE2025', reward: 'Marie Leroux Mistletoe Community Glyph Lyon Allard Mistletoe Community Glyph', start: '2025-12-25' },
      { code: 'Pride2026', reward: 'Pride Lotus Symbol Glyph, Pride Frame Display', start: '2026-07-01', end: '2027-05-31' },
      { code: 'CARRYTHEFIRE', reward: 'Carry The Fire with Sprite! Glyph', start: '2026-10-01', end: 'none' },
      { code: 'MOVEMBER2026', reward: 'Movember Sirius And Orion Community Display, Movember Shopkeep Moustache Display Frame', start: '2026-11-02' },
    ]);
  });

  it('leaves out a code past its own end date, even while the wiki still lists it as active', () => {
    const codes = parseActiveCodes(PAGE, Date.UTC(2027, 5, 1)).map((c) => c.code);
    assert.ok(!codes.includes('Pride2026'));
    assert.ok(codes.includes('MOVEMBER2026'), 'an open end stays');
  });

  it('splits a row with two codes and skips a row without one', () => {
    const page = '== Active Codes ==\nOLDPEACE-QQKXJ OLDPEACE-UAH6A · The Old Peace promo · 2026-10-07 to 2027-02-04 · Nikana\nGlyph · Year 8 Anniversary Glyph';
    assert.deepEqual(noItems(parseActiveCodes(page, NOW)), [
      { code: 'OLDPEACE-QQKXJ', reward: 'Nikana', start: '2026-10-07', end: '2027-02-04' },
      { code: 'OLDPEACE-UAH6A', reward: 'Nikana', start: '2026-10-07', end: '2027-02-04' },
    ]);
  });

  it('keeps the rewards of one cell apart when reading the raw wiki source (real rows)', () => {
    const source = `==Active Codes==
List of active global codes.<ref>{{Ref|title=Free Promocodes|url=https://forums.warframe.com/}}</ref>

{| class="wikitable sortable"
|-
!style="min-width:15%"|Code!!Type!! Context!! Dates Active!!Reward(s)!!References
|-
|[https://warframe.com/promocode?code=MISTLETOE2025 MISTLETOE2025]
|Glyph
|
|2025-12-25
|
Marie Leroux Mistletoe Community Glyph<br>Lyon Allard Mistletoe Community Glyph<br>Roathe Mistletoe Community Glyph
|
|-
|[https://warframe.com/promocode?code=Parvos Parvos]
|Decoration
|
|
|Adds Golden Hand decoration
|
|-
|[https://www.warframe.com/en/promocode?code=MOVEMBER2026 MOVEMBER2026]
|Displays
|[[Movember]] 2026
|2026-11-02 to ?
|
[[Moframe#Promo_Code|Movember Sirius And Orion Community Display]]<br>
[[Moframe#Promo_Code|Movember Shopkeep Moustache Display Frame]]
|
|-
|OLDPEACE-QQKXJ<br>OLDPEACE-UAH6A
|
|[[The Old Peace]] promo
|2026-10-07 to 2027-02-04
|[[Nikana]], [[Nikana Dax Skin]], Dax Portait
|
|-
|LONGONE
|Glyph
|
|
|${'Long Glyph<br>'.repeat(30)}End
|
|}

== Inactive Codes ==
|-
|Conquer||Cosmetics||Quest to Conquer Cancer 2020||2020-11-02 to 2021-01-11||Conquera Glyph and Sigil||`;
    const codes = parseActiveCodes(promoTextFromSource(source), NOW);
    assert.deepEqual(codes[0]!.items, [
      'Marie Leroux Mistletoe Community Glyph',
      'Lyon Allard Mistletoe Community Glyph',
      'Roathe Mistletoe Community Glyph',
    ]);
    assert.deepEqual(codes[1]!.items, ['Golden Hand decoration'], '"Adds" is dropped');
    assert.deepEqual(noItems(codes.slice(0, 5)), [
      {
        code: 'MISTLETOE2025',
        reward: 'Marie Leroux Mistletoe Community Glyph, Lyon Allard Mistletoe Community Glyph, Roathe Mistletoe Community Glyph',
        start: '2025-12-25',
      },
      { code: 'Parvos', reward: 'Golden Hand decoration' },
      { code: 'MOVEMBER2026', reward: 'Movember Sirius And Orion Community Display, Movember Shopkeep Moustache Display Frame', start: '2026-11-02' },
      { code: 'OLDPEACE-QQKXJ', reward: 'Nikana, Nikana Dax Skin, Dax Portait', start: '2026-10-07', end: '2027-02-04' },
      { code: 'OLDPEACE-UAH6A', reward: 'Nikana, Nikana Dax Skin, Dax Portait', start: '2026-10-07', end: '2027-02-04' },
    ]);
    assert.equal(codes[5]!.code, 'LONGONE');
    assert.equal(codes[5]!.reward.length, 200, 'the 200-character cut stays');
    assert.equal(codes.length, 6, 'nothing from Inactive Codes');
  });

  it('finds nothing on a page without the section', () => {
    assert.deepEqual(parseActiveCodes('== Introduction ==\nSomething else.', NOW), []);
  });
});

describe('promo code dates', () => {
  it('reads a day as noon UTC and refuses what is not a calendar day', () => {
    assert.equal(dayToMs('2026-11-02'), Date.UTC(2026, 10, 2, 12));
    assert.equal(dayToMs('2026-02-30'), null);
    assert.equal(dayToMs('2026-13-01'), null);
    assert.equal(dayToMs('soon'), null);
    assert.equal(dayToMs(undefined), null);
  });

  it('reads every shape of the Dates Active cell', () => {
    assert.deepEqual(parseDates('2026-07-01 to 2027-05-31'), { start: '2026-07-01', end: '2027-05-31' });
    assert.deepEqual(parseDates('2026-10-01 to Indefinite'), { start: '2026-10-01', end: 'none' });
    assert.deepEqual(parseDates('2026-11-02 to ?'), { start: '2026-11-02' });
    assert.deepEqual(parseDates('2025-12-25'), { start: '2025-12-25' });
    assert.deepEqual(parseDates('2026-02-31 to 2026-99-01'), {}, 'impossible days count as unknown');
  });

  it('sorts newest added first, uses the first-seen time without a wiki start, and puts unknown dates last in wiki order', () => {
    const seen = new Map<string, number | null>([['NEWONE', Date.UTC(2026, 10, 10)], ['Parvos', null]]);
    const dated = datePromoCodes(
      [
        { code: 'SPECIALEFFECT', reward: 'a', items: ['a'] },
        { code: 'OLD', reward: 'b', items: ['b'], start: '2025-12-25' },
        { code: 'Parvos', reward: 'c', items: ['c'] },
        { code: 'NEWONE', reward: 'd', items: ['d'] },
        { code: 'MID', reward: 'e', items: ['e'], start: '2026-10-01', end: 'none' },
      ],
      seen,
    );
    assert.deepEqual(dated.map((c) => c.code), ['NEWONE', 'MID', 'OLD', 'SPECIALEFFECT', 'Parvos']);
    assert.equal(dated[0]!.added, Date.UTC(2026, 10, 10));
    assert.equal(dated[1]!.expires, 'none');
    assert.equal(dated[3]!.added, null);
  });

  it('records first sight once; the very first read leaves the dates unknown', () => {
    const store = new Store(':memory:');
    assert.deepEqual([...store.promoFirstSeen(['A', 'B'], 1000)], [['A', null], ['B', null]]);
    assert.deepEqual([...store.promoFirstSeen(['A', 'C'], 2000)], [['A', null], ['C', 2000]]);
    assert.deepEqual([...store.promoFirstSeen(['c'], 3000)], [['c', 2000]], 'a code is the same code in any case');
    store.close();
  });

  it('writes the dates line with Discord timestamps, in each of the three expiry forms', () => {
    const exp = Date.UTC(2027, 4, 31, 12) / 1000;
    const add = Date.UTC(2026, 6, 1, 12) / 1000;
    const code = { code: 'X', reward: '', items: [] };
    assert.equal(datesLine({ ...code, added: add * 1000, expires: exp * 1000 }), `📅 <t:${add}:D> · ends <t:${exp}:D> (<t:${exp}:R>)`);
    assert.equal(datesLine({ ...code, added: add * 1000, expires: null }), `📅 <t:${add}:D> · expiry unknown`);
    assert.equal(datesLine({ ...code, added: add * 1000, expires: 'none' }), `📅 <t:${add}:D> · no end date`);
    assert.equal(expiryText({ ...code, added: null, expires: 'none' }), 'no end date');
  });
});

describe('the reward summary', () => {
  it('counts the live codes by kind, with their shared theme', () => {
    assert.equal(
      summarizeRewards([
        'Movember Sirius And Orion Community Display',
        'Movember Shopkeep Moustache Display Frame',
        'Movember Mustachioed Fusion Display',
        'Movember Twin Community Display',
      ]),
      '4 Movember displays',
    );
    assert.equal(summarizeRewards(['Pride Lotus Symbol Glyph', 'Pride Frame Display', 'Pride Flag Display']), 'Pride glyph and 2 displays');
    assert.equal(
      summarizeRewards(['Marie Leroux Mistletoe Community Glyph', 'Lyon Allard Mistletoe Community Glyph', 'Roathe Mistletoe Community Glyph']),
      '3 Mistletoe Community glyphs',
    );
    assert.equal(summarizeRewards(['Carry The Fire with Sprite! Glyph']), 'Carry The Fire with Sprite! Glyph');
  });

  it('shows a single item as it is, and nothing for no items', () => {
    assert.equal(summarizeRewards(['Golden Hand decoration']), 'Golden Hand decoration');
    assert.equal(summarizeRewards([]), '');
  });

  it('falls back to all the names when one is of a kind it does not know', () => {
    assert.equal(summarizeRewards(['Nikana', 'Nikana Dax Skin', 'Dax Portait']), 'Nikana, Nikana Dax Skin, Dax Portait');
  });

  it('counts without a theme when the names share no word, joining three kinds with commas and "and"', () => {
    assert.equal(summarizeRewards(['Lotus Glyph', 'Stalker Sigil', 'Tenno Glyph', 'Affinity Booster']), '2 glyphs, sigil and booster');
  });

  it('keeps the 200-character cut', () => {
    assert.equal(summarizeRewards(Array.from({ length: 30 }, (_, i) => `Thing${i}`)).length, 200);
  });
});

describe('the promo codes message', () => {
  const ctx = { config: { CLAN_NAME: 'The Rats Den 69' }, client: { user: null } } as unknown as AppContext;
  const describeOf = (panel: ReturnType<typeof promoPanel>) =>
    (panel.embeds![0] as unknown as { toJSON(): { title: string; description: string } }).toJSON();

  const link = (c: string) => `**[${c}](https://warframe.com/promocode?code=${c})**`;
  const code = (c: string, items: string[], dates: { start?: string; end?: string } = {}) => ({ code: c, reward: items.join(', '), items, ...dates });

  it('shows the dated codes newest first, then the undated ones under Older codes', () => {
    const codes = datePromoCodes(parseActiveCodes(PAGE, NOW));
    const { description } = describeOf(promoPanel(ctx, codes, NOW));
    const order = ['MOVEMBER2026', 'CARRYTHEFIRE', 'Pride2026', 'MISTLETOE2025', 'Older codes', 'SPECIALEFFECT', 'Parvos'].map((c) => description.indexOf(c));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!)), description);
    assert.ok(description.startsWith('Free items: tap a code to redeem it on warframe.com, or enter it in-game under **Market › Redeem Code**.\n\n'));
    assert.match(description, /\*\*\[MOVEMBER2026\]\([^)]+\)\*\* · 2 Movember displays\n-# 📅 <t:\d+:D> · expiry unknown\n\n\*\*\[CARRYTHEFIRE\]/);
    assert.match(description, /\n\n\*\*Older codes\*\*\n\*\*\[SPECIALEFFECT\]\([^)]+\)\*\* · Special Effect Glyph\n\*\*\[Parvos\]\([^)]+\)\*\* · Golden Hand decoration$/);
    assert.ok(!description.includes('[Redeem]'), 'no separate Redeem link');
  });

  it('writes a dated entry as a link, the summary and the dates line', () => {
    const panel = promoPanel(ctx, datePromoCodes([code('Pride2026', ['Pride Lotus Symbol Glyph', 'Pride Frame Display'], { start: '2026-07-01', end: '2027-05-31' })]), NOW);
    const embed = (panel.embeds![0] as unknown as { toJSON(): { title: string; description: string } }).toJSON();
    assert.equal(embed.title, '🎟️ Promo codes');
    const add = Date.UTC(2026, 6, 1, 12) / 1000;
    const end = Date.UTC(2027, 4, 31, 12) / 1000;
    assert.ok(embed.description.endsWith(`\n\n${link('Pride2026')} · Pride glyph and display\n-# 📅 <t:${add}:D> · ends <t:${end}:D> (<t:${end}:R>)`), embed.description);
    assert.ok(!embed.description.includes('Older codes'), 'no heading without undated codes');
  });

  it('adds the end to an older code only when it is known', () => {
    const seen = new Map<string, number | null>([['A', null], ['B', null], ['C', null]]);
    const codes = datePromoCodes([code('A', ['A Glyph'], { end: '2027-01-01' }), code('B', ['B Glyph'], { end: 'none' }), code('C', ['C Glyph'])], seen);
    const { description } = describeOf(promoPanel(ctx, codes, NOW));
    const end = Date.UTC(2027, 0, 1, 12) / 1000;
    assert.ok(description.endsWith(`\n\n**Older codes**\n${link('A')} · A Glyph · ends <t:${end}:D>\n${link('B')} · B Glyph\n${link('C')} · C Glyph`), description);
  });

  it('cuts whole entries when the list is too long, and never leaves the heading alone', () => {
    const item = (i: number) => [`${'x'.repeat(150)}${i}`];
    const many = datePromoCodes(Array.from({ length: 40 }, (_, i) => code(`CODE${i}`, item(i), { start: '2026-01-01', end: '2027-01-01' })));
    const { description } = describeOf(promoPanel(ctx, [...many, ...datePromoCodes([code('OLDONE', ['Old Glyph'])], new Map([['OLDONE', null]]))], NOW));
    assert.ok(description.length <= 4000);
    assert.match(description, /\(<t:\d+:R>\)$/);
    assert.ok(!description.includes('Older codes'), 'a full list leaves the older codes out, heading and all');

    // Room for the heading but not for its first line: neither is written.
    const fill = datePromoCodes(Array.from({ length: 19 }, (_, i) => code(`F${i}`, item(i), { start: '2026-01-01', end: '2027-01-01' })));
    const base = describeOf(promoPanel(ctx, fill, NOW)).description.length;
    const old = datePromoCodes([code('OLDONE', ['y'.repeat(4000 - base - 20)])], new Map([['OLDONE', null]]));
    const cut = describeOf(promoPanel(ctx, [...fill, ...old], NOW)).description;
    assert.equal(cut.length, base);
    assert.ok(!cut.includes('Older codes'));
  });
});
