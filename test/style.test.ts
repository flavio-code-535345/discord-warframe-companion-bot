import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fissuresEmbed } from '../src/discord/embeds.js';
import { COLORS, ICON, footer, heading, setBrand } from '../src/discord/style.js';
import { badge, head, statCard } from '../src/web/admin/pages.js';
import { ADMIN_CSS, STATUS_CSS } from '../src/web/theme.js';
import type { Fissure } from '../src/warframe/worldstate.js';

test('a title is its icon and its text, and every public embed ends with the source and the bot', () => {
  assert.equal(heading('fissures', 'Void fissures (3)'), `${ICON.fissures} Void fissures (3)`);
  setBrand({ name: 'Cephalon Ordis' });
  assert.deepEqual(footer(), { text: 'Cephalon Ordis' });
  assert.deepEqual(footer('warframe.market'), { text: 'warframe.market · Cephalon Ordis' });
  setBrand({ name: 'Ordis', icon: 'https://cdn.example/a.png' });
  assert.deepEqual(footer('wiki'), { text: 'wiki · Ordis', iconURL: 'https://cdn.example/a.png' });
  setBrand({ name: 'Cephalon Ordis' });
});

test('fissures are grouped by relic tier, soonest to end first, and stay under what Discord allows', () => {
  const tiers = ['Lith', 'Meso', 'Neo', 'Axi', 'Requiem', 'Omnia'];
  const fissures = Array.from({ length: 60 }, (_, i) => ({
    tier: tiers[i % tiers.length]!,
    missionType: 'Survival',
    node: `A fairly long node name number ${i} (Void)`,
    enemy: 'Corrupted',
    isHard: i % 4 === 0,
    isStorm: i % 9 === 0,
    expiry: new Date(Date.now() + (60 - i) * 60_000),
  })) as unknown as Fissure[];
  const json = fissuresEmbed(fissures).toJSON();
  assert.deepEqual((json.fields ?? []).map((f) => f.name), ['Lith (10)', 'Meso (10)', 'Neo (10)', 'Axi (10)', 'Requiem (10)', 'Omnia (10)']);
  for (const f of json.fields ?? []) assert.ok(f.value.length <= 1024);
  assert.ok(JSON.stringify(json).length < 6000);
  // Soonest first: within Lith, the fissure that expires first (i = 54) comes before the later ones.
  const lith = json.fields![0]!.value.split('\n');
  assert.match(lith[0]!, /number 54 /);
  assert.equal(json.title, `${ICON.fissures} Void fissures (60)`);
  assert.equal(json.color, COLORS.void);
  assert.equal(fissuresEmbed([]).toJSON().description, 'No fissures match those filters right now.');
});

test('the admin helpers escape what they are given, and statCard takes ready HTML for the value', () => {
  assert.equal(head('<b>x</b>', 'a & b'), '<h1>&lt;b&gt;x&lt;/b&gt;</h1><p class="lede">a &amp; b</p>');
  assert.equal(badge('<on>', 'ok'), '<span class="badge ok">&lt;on&gt;</span>');
  assert.match(statCard('Members', '57', 'in the den', { tone: 'ok' }), /<div class="statlabel">Members<\/div><div class="stat ok">57<\/div><div class="statnote">in the den<\/div>/);
});

test('the web pages stay inside their Content-Security-Policy: no inline style attributes, no url() or data: images in the CSS', () => {
  for (const css of [ADMIN_CSS, STATUS_CSS]) assert.doesNotMatch(css, /url\(|data:/);
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []));
  for (const file of walk(join(import.meta.dirname, '..', 'src', 'web'))) assert.doesNotMatch(readFileSync(file, 'utf8'), /\sstyle="/, `${file} has an inline style attribute, which the CSP blocks`);
});
