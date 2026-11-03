import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.js';
import { parseActiveCodes, promoPanel } from '../src/discord/promo-codes.js';

const NOW = Date.UTC(2026, 10, 3);
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
    assert.deepEqual(parseActiveCodes(PAGE, NOW), [
      { code: 'SPECIALEFFECT', reward: 'Special Effect Glyph' },
      { code: 'Parvos', reward: 'Golden Hand decoration' },
      { code: 'MISTLETOE2025', reward: 'Marie Leroux Mistletoe Community Glyph Lyon Allard Mistletoe Community Glyph' },
      { code: 'Pride2026', reward: 'Pride Lotus Symbol Glyph, Pride Frame Display' },
      { code: 'CARRYTHEFIRE', reward: 'Carry The Fire with Sprite! Glyph' },
      { code: 'MOVEMBER2026', reward: 'Movember Sirius And Orion Community Display, Movember Shopkeep Moustache Display Frame' },
    ]);
  });

  it('leaves out a code past its own end date, even while the wiki still lists it as active', () => {
    const codes = parseActiveCodes(PAGE, Date.UTC(2027, 5, 1)).map((c) => c.code);
    assert.ok(!codes.includes('Pride2026'));
    assert.ok(codes.includes('MOVEMBER2026'), 'an open end stays');
  });

  it('splits a row with two codes and skips a row without one', () => {
    const page = '== Active Codes ==\nOLDPEACE-QQKXJ OLDPEACE-UAH6A · The Old Peace promo · 2026-10-07 to 2027-02-04 · Nikana\nGlyph · Year 8 Anniversary Glyph';
    assert.deepEqual(parseActiveCodes(page, NOW), [
      { code: 'OLDPEACE-QQKXJ', reward: 'Nikana' },
      { code: 'OLDPEACE-UAH6A', reward: 'Nikana' },
    ]);
  });

  it('finds nothing on a page without the section', () => {
    assert.deepEqual(parseActiveCodes('== Introduction ==\nSomething else.', NOW), []);
  });
});

describe('the promo codes message', () => {
  it('lists each code with a link that fills it in', () => {
    const ctx = { config: { CLAN_NAME: 'The Rats Den 69' }, client: { user: null } } as unknown as AppContext;
    const panel = promoPanel(ctx, [{ code: 'MOVEMBER2026', reward: 'Moustache Display' }], NOW);
    const embed = (panel.embeds![0] as unknown as { toJSON(): { title: string; description: string } }).toJSON();
    assert.equal(embed.title, '🎟️ Promo codes');
    assert.match(embed.description, /\*\*MOVEMBER2026\*\* · \[Redeem\]\(https:\/\/warframe\.com\/promocode\?code=MOVEMBER2026\)\n-# Moustache Display/);
  });
});
