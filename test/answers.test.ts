import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { availability, circuitAnswer, circuitTopic, namedIn, nextReset, parseRotations, resetRotations, weekOf } from '../src/answers/circuit.js';
import { masteryAnswer } from '../src/answers/mastery.js';
import { elementsAnswer, mathAnswer, relevantDrops, smartAnswer, wikiAnswer, withoutName } from '../src/answers/smart.js';
import { mathExpression, noContent, questionLike, thanks } from '../src/answers/understand.js';
import { Store } from '../src/db.js';
import { api } from '../src/warframe/fetch.js';
import { MIN_READY_PAGES, WikiIndex, setWikiIndex } from '../src/wiki/index.js';

const config = { BOT_NAME: 'Cephalon Ordis', CLAN_NAME: 'The Rats Den 69', DISCORD_GUILD_ID: 'g', OPERATOR_IDS: ['1'], PANEL_OWNER_IDS: ['9'], WARFRAME_PLATFORM: 'pc' };
const ctxOf = (store = new Store(':memory:')) => ({ config, store }) as never;

const realFetch = globalThis.fetch;
beforeEach(() => {
  api.reset();
  resetRotations();
  // Nothing in these tests may reach the network: drop tables come from fakeDrops, anything else is a 404.
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setWikiIndex(null);
});

/** A wiki index that counts as ready (it needs MIN_READY_PAGES pages) with the given pages in it. */
function readyIndex(pages: Record<string, string>): WikiIndex {
  const index = new WikiIndex(':memory:');
  for (const [title, body] of Object.entries(pages)) index.putPage(title, 1, [{ section: 'Introduction', body }]);
  for (let i = 0; i < MIN_READY_PAGES; i++) index.putPage(`Filler ${i}`, 1, [{ section: 'Introduction', body: `Filler page number ${i} with enough text to count as indexed.` }]);
  setWikiIndex(index);
  return index;
}

/** Drop-table searches answered from `drops`. */
function fakeDrops(drops: Record<string, { item: string; place: string; chance: number }[]>) {
  globalThis.fetch = (async (url: string | URL) => {
    const m = /\/drops\/search\/([^?]+)/.exec(String(url));
    if (m) return Response.json((drops[decodeURIComponent(m[1]!).toLowerCase()] ?? []).map((d) => ({ ...d, rarity: 'Common' })));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

describe('understanding a message', () => {
  it('finds plain arithmetic and nothing else', () => {
    assert.equal(mathExpression('what is 9 x 2'), '9 x 2');
    assert.equal(mathExpression('What is 2+2?'), '2+2');
    assert.equal(mathExpression('1,000 * 3'), '1000 * 3');
    for (const q of ['what is 9', 'what is the best kuva farm', 'mr 14 weapons', '2026']) assert.equal(mathExpression(q), null, q);
    assert.equal(mathAnswer('9 x 2'), '9 × 2 = **18**');
    assert.equal(mathAnswer('1 / 0'), null);
  });

  it('knows chatter, links, reactions and thanks from questions and requests', () => {
    const sticker = '[Garfield Piss](https://media.discordapp.net/stickers/1280967546039963729.gif?size=160&name=Garfield+Piss&lossless=true)';
    for (const q of ['https://klipy.com/gifs/clanker-kylo-ren', '<@220147375786688512>', 'lol', '😂😂', '...', sticker]) assert.equal(noContent(q), true, q);
    assert.equal(questionLike('look https://x.example/a.gif?size=160'), false, "a link's ? is not a question");
    for (const q of ['cbt', 'this clanka dumb af', 'wisp prime']) assert.equal(noContent(q), false, q);
    for (const q of ['how do i get wisp', 'Give me all damage variations combinations', 'is baro here', 'wisp?']) assert.equal(questionLike(q), true, q);
    for (const q of ['this clanka dumb af', 'cbt', 'wisp prime']) assert.equal(questionLike(q), false, q);
    for (const q of ['thanks!', 'ty ordis', 'Thank you']) assert.equal(thanks(q), true, q);
    assert.equal(thanks('thanks, and where does wisp drop from the ropalolyst boss fight'), false);
  });

  it('takes the name off a request to Ordis, but not off a remark about him', () => {
    assert.equal(withoutName('Ordis, how do I get wisp'), 'how do I get wisp');
    assert.equal(withoutName('ordis how do I get wisp'), 'how do I get wisp');
    assert.equal(withoutName('Ordis is dumb'), 'Ordis is dumb');
    assert.equal(withoutName('Ordis'), 'Ordis');
    assert.equal(withoutName('Ordisphere'), 'Ordisphere');
  });
});

const CIRCUIT_PAGE = [
  '== Normal Circuit ==',
  'Normal Circuit Warframe Rotation',
  'Week',
  'Warframe Choices',
  ...['Excalibur|Trinity|Ember', 'Loki|Mag|Rhino', 'Ash|Frost|Nyx', 'Saryn|Vauban|Nova', 'Nekros|Valkyr|Oberon', 'Hydroid|Mirage|Limbo', 'Mesa|Chroma|Atlas', 'Ivara|Inaros|Titania', 'Nidus|Octavia|Harrow', 'Gara|Khora|Revenant', 'Garuda|Baruuk|Hildryn'].flatMap((w, i) => [`Week ${i + 1}`, ...w.split('|').map((f) => `${f} (Augment)`)]),
  'Week 12 ⟲ 1',
  '== The Steel Path Circuit ==',
  'The Steel Path Incarnon Genesis Reward Rotation',
  'Week # (Rotation) · Possible Incarnon Genesis',
  ...[
    'Braton|Lato|Skana|Paris|Kunai',
    'Boar|Gammacor|Angstrum|Gorgon|Anku',
    'Bo|Latron|Furis|Furax|Strun',
    'Lex|Magistar|Boltor|Bronco|Ceramic Dagger',
    'Torid|Dual Toxocyst|Dual Ichor|Miter|Atomos',
    'Ack & Brunt|Soma|Vasto|Nami Solo|Burston',
    'Zylok|Sibear|Dread|Despair|Hate',
    'Dera|Sybaris|Cestra|Sicarus|Okina',
    'Vectis|Stug|Ballistica|Destreza|Obex',
  ].map((w, i) => `|Week ${i + 1} (${String.fromCharCode(65 + i)}) · | · ${w.split('|').map((n) => `*${n} Incarnon Genesis (${n}/Prime)`).join(' · ')}`),
  'Week 10+ · Schedule repeats, cycling rewards from Week 1 to Week 9 (ABCDEFGHIABCDEFGHI...)',
].join('\n');

const NOW = Date.parse('2026-10-30T17:20:00Z'); // a Friday, in week 9 (I)
const deps = (hard: string[] = ['Vectis', 'Stug', 'Ballistica', 'Destreza', 'Obex'], normal = ['Mesa', 'Chroma', 'Atlas']) => ({
  now: NOW,
  read: async () => ({ title: 'The Circuit', url: 'u', extract: CIRCUIT_PAGE }),
  world: async () => ({ duviriCycle: { choices: [{ category: 'normal', choices: normal }, { category: 'hard', choices: hard }] } }) as never,
});

describe('the Circuit rotation', () => {
  it('reads both rotation tables from the wiki page', () => {
    const r = parseRotations(CIRCUIT_PAGE);
    assert.equal(r.incarnon.length, 9);
    assert.deepEqual(r.incarnon[4], ['Torid', 'Dual Toxocyst', 'Dual Ichor', 'Miter', 'Atomos']);
    assert.deepEqual(r.incarnon[5]![0], 'Ack & Brunt');
    assert.equal(r.warframes.length, 11);
    assert.deepEqual(r.warframes[6], ['Mesa', 'Chroma', 'Atlas']);
    assert.deepEqual(parseRotations('|Week 1 (A) · | · *Braton Incarnon Genesis\n|Week 3 (C) · | · *Bo Incarnon Genesis').incarnon, [], 'a table with a gap is not used');
  });

  it('finds the week on offer, the next reset and the weeks until a weapon returns', () => {
    const { incarnon } = parseRotations(CIRCUIT_PAGE);
    assert.equal(weekOf(incarnon, ['Vectis', 'Stug', 'Ballistica', 'Destreza', 'Obex']), 8);
    assert.equal(weekOf(incarnon, ['Vectis']), -1, 'one name is not enough to be sure');
    assert.equal(new Date(nextReset(NOW)).toISOString(), '2026-11-02T00:00:00.000Z');
    assert.equal(new Date(nextReset(Date.parse('2026-11-02T00:00:00Z'))).toISOString(), '2026-11-09T00:00:00.000Z', 'at the reset itself, the next one');
    const torid = availability('Torid', incarnon, 8, NOW)!;
    assert.equal(torid.weeksAhead, 5);
    assert.equal(new Date(torid.from).toISOString(), '2026-11-30T00:00:00.000Z');
    assert.equal(availability('Strun', incarnon, 8, NOW)!.weeksAhead, 3);
    assert.equal(availability('Obex', incarnon, 8, NOW)!.weeksAhead, 0);
  });

  it('recognises the topic and the weapon, misspelt too', () => {
    const { incarnon } = parseRotations(CIRCUIT_PAGE);
    assert.equal(circuitTopic('When can I get Torid incarnon next?'), 'incarnon');
    assert.equal(circuitTopic('when is the torid incronon back'), 'incarnon');
    assert.equal(circuitTopic('what warframes are in the circuit'), 'warframe');
    assert.equal(circuitTopic('how do I get the torid'), null);
    assert.equal(namedIn('when is the next torid incarnon', incarnon), 'Torid');
    assert.equal(namedIn('ack and brunt incarnon', incarnon), null);
    assert.equal(namedIn('Ack & Brunt incarnon', incarnon), 'Ack & Brunt');
    assert.equal(namedIn('when is the toird incarnon', incarnon), null, 'five letters: no typo allowed');
    assert.equal(namedIn('when is the ballistca incarnon', incarnon), 'Ballistica');
  });

  it('answers when a weapon is next on offer, exactly', async () => {
    const a = (await circuitAnswer('When can I get Torid incarnon next?', deps()))!;
    assert.match(a, /\*\*Torid Incarnon Genesis\*\* is next in the Steel Path Circuit in \*\*5 weeks\*\*/);
    assert.match(a, /<t:1795996800:F>/, 'from Monday 30 November 00:00 UTC');
    assert.match(a, /This week \(until <t:1793577600:f>\): Vectis, Stug, Ballistica, Destreza and Obex\./);
    assert.match(a, /week 9 \(I\)/);
    assert.match((await circuitAnswer('is the obex incarnon available', deps()))!, /\*\*this week\*\*/);
  });

  it('lists this week and next week, and the normal Circuit Warframes', async () => {
    const a = (await circuitAnswer('what incarnons are in the steel path circuit this week?', deps()))!;
    assert.match(a, /This week .*Vectis, Stug, Ballistica, Destreza and Obex/);
    assert.match(a, /Next week: Braton, Lato, Skana, Paris and Kunai/);
    assert.match((await circuitAnswer('when is rhino in the circuit', deps()))!, /\*\*Rhino\*\* is next in the Circuit in \*\*6 weeks\*\*/);
  });

  it('gives the full schedule from this week on, every week with its start date', async () => {
    const a = (await circuitAnswer('What is the full schedule for all incarnons', deps()))!;
    const weeks = [...a.matchAll(/\*\*Week (\d) \(([A-I])\)\*\*/g)].map((m) => Number(m[1]));
    assert.deepEqual(weeks, [9, 1, 2, 3, 4, 5, 6, 7, 8], 'all nine, starting with this week');
    assert.match(a, /\*\*Week 9 \(I\)\*\* · \*\*this week\*\*: Vectis/);
    assert.match(a, /\*\*Week 1 \(A\)\*\* · from <t:1793577600:D>: Braton/);
    assert.match(a, /\*\*Week 5 \(E\)\*\* · from <t:1795996800:D>: Torid/);
    const blind = (await circuitAnswer('full incarnon rotation', { ...deps(), world: async () => Promise.reject(new Error('off')) }))!;
    assert.match(blind, /listed without dates/);
    assert.match(blind, /\*\*Week 1 \(A\)\*\*: Braton/);
    assert.equal(await circuitAnswer('what does the full incarnon form do', deps()), null, 'not a schedule question');
  });

  it('says so instead of guessing when it cannot see this week, and leaves other questions alone', async () => {
    const blind = { ...deps(), world: async () => Promise.reject(new Error('off')) };
    const a = (await circuitAnswer('When can I get Torid incarnon next?', blind))!;
    assert.match(a, /week 5 \(E\) of the 9-week Steel Path Circuit rotation/);
    assert.match(a, /can't see this week's offerings/);
    assert.equal(await circuitAnswer('how do I get the Laetum incarnon', deps()), null, 'not a Circuit weapon: the wiki answers it');
    assert.equal(await circuitAnswer('how do I get torid', deps()), null);
  });
});

describe('mastery rank thresholds', () => {
  it('gives the whole MR and LR table, or one rank, from the formula', () => {
    const table = masteryAnswer('Show me the full MR and LR bracket')!;
    assert.match(table, /MR 1 2,500 · MR 2 10,000 · MR 3 22,500/);
    assert.match(table, /MR 28 1,960,000 · MR 29 2,102,500 · MR 30 2,250,000/);
    assert.match(table, /\*\*Legendary:\*\* LR 1 2,397,500 · LR 2 2,545,000/);
    assert.match(masteryAnswer('how many points for MR 25')!, /\*\*MR 25\*\* needs \*\*1,562,500\*\*.*\(122,500 more than MR 24\)/);
    assert.match(masteryAnswer('what is LR3')!, /\*\*LR 3\*\* needs \*\*2,692,500\*\*/);
    for (const q of ['how do i get mastery points', 'What is the fastest way to gain mastery rank points?', 'list all mastery rank tests', 'mastery rank 14 weapons'])
      assert.equal(masteryAnswer(q), null, q);
  });
});


describe('answers from the wiki', () => {
  it('quotes the sentence of the named page that fits, and links the pages', async () => {
    readyIndex({
      'Archon Shard': 'Archon Shards are permanent upgrade items taken from Archons. The Helminth imbues Archon Shards into a Warframe for permanent stat bonuses. Shards come in five colors.',
      Helminth: 'The Helminth is a being in the Orbiter that can subsume Warframe abilities.',
    });
    const a = await wikiAnswer('how do archon shards work');
    assert.equal(a.found, true);
    assert.equal(a.source, 'excerpt');
    assert.match(a.content, /^> [^\n]*Archon Shard/);
    assert.equal(a.content.split('\n').length, 2, 'one quote line and one line of links');
    assert.match(a.content, /\n📖 \[Archon Shard\]\(<https:\/\/wiki\.warframe\.com\/w\/Archon_Shard>\)/);
  });

  it('only links a page that merely shares a word with the question, and says when nothing matches', async () => {
    readyIndex({ 'Kinemantik Instant Messenger': 'Aoi says she cannot make it anymore in that itchy wool sweater, so she stays home tonight.' });
    const a = await wikiAnswer('how can I make my sweater not itchy anymore');
    assert.doesNotMatch(a.content, /^>/m, 'nothing quoted out of context');
    assert.match(a.content, /^📖 \[Kinemantik Instant Messenger\]/);
    assert.equal(a.source, 'lookup');
    assert.match(a.review!, /links only/);
    const none = await wikiAnswer('zxqv plorb');
    assert.equal(none.found, false);
    assert.match(none.content, /found nothing on the wiki.*index\.php\?search=zxqv%20plorb/);
  });

  it('keeps only the drop tables of the item and its blueprints', () => {
    const g = (item: string) => ({ item, locations: [{ place: 'X', item, rarity: 'Common', chance: 10 }] });
    const groups = [g('Wisp Blueprint'), g('Wisp Chassis Blueprint'), g('Wisp Prime Chassis Blueprint'), g('3X Cetus Wisp'), g('Fused Reservoir (Wisp)')];
    assert.deepEqual(relevantDrops(groups, 'Wisp').map((x) => x.item), ['Wisp Blueprint', 'Wisp Chassis Blueprint']);
    assert.deepEqual(relevantDrops([g('Bite'), g('Frostbite'), g('Primary Frostbite')], 'bite').map((x) => x.item), ['Bite']);
  });

  it('gives the recipe of the secondary elements from their wiki pages, for combination questions only', async () => {
    const recipes: Record<string, string> = { Blast: 'Heat and Cold', Corrosive: 'Toxin and Electricity', Gas: 'Heat and Toxin', Magnetic: 'Cold and Electricity', Radiation: 'Heat and Electricity', Viral: 'Cold and Toxin' };
    const read = async (title: string) => {
      const e = /^Damage\/(\w+) Damage$/.exec(title)?.[1];
      return e && recipes[e] ? { title, url: 'u', extract: `${e} Damage is one of the six secondary elemental damage types, composed of ${recipes[e]} elements.` } : null;
    };
    const all = (await elementsAnswer('Give me all damage variations combinations', read))!;
    assert.match(all, /^\*\*Blast\*\* = Heat \+ Cold\n\*\*Corrosive\*\* = Toxin \+ Electricity/);
    assert.match(all, /\*\*Viral\*\* = Cold \+ Toxin\n📖 \[Damage\]/);
    assert.equal(await elementsAnswer('How do I gain the viral status effect on my guns', read), '**Viral** = Cold + Toxin\n📖 [Damage](<https://wiki.warframe.com/w/Damage>)');
    assert.equal(await elementsAnswer('what does viral do to infested', read), null, 'naming an element is not asking how to make it');
    assert.equal(await elementsAnswer('how do I get wisp', read), null);
  });
});

describe('smartAnswer', () => {
  it('does sums, thanks you, and stays quiet on chatter and links', async () => {
    readyIndex({ Bite: 'Bite is a Mod for Beast Claws that increases Critical Chance and Critical Damage.' });
    const sum = await smartAnswer('what is 9 x 2', ctxOf());
    assert.equal(sum.intent, 'math');
    assert.match(sum.content, /= \*\*18\*\*/);
    assert.equal((await smartAnswer('thanks!', ctxOf())).found, true);
    for (const q of ['https://klipy.com/gifs/clanker-kylo-ren', 'this clanka dumb af', 'lol']) {
      const a = await smartAnswer(q, ctxOf());
      assert.equal(a.silent, true, q);
      assert.equal(a.intent, 'smalltalk', q);
    }
  });

  it('shows the drop tables with the wiki page for a drop question, and the wiki for anything else', async () => {
    readyIndex({ Bite: 'Bite is a Mod for Beast Claws that increases Critical Chance and Critical Damage. It drops from Kubrows.' });
    fakeDrops({ bite: [{ item: 'Bite', place: 'Earth/Cervantes (Caches), Rot C', chance: 3.67 }] });
    const drops = await smartAnswer('where does bite drop?', ctxOf());
    assert.equal(drops.intent, 'drops');
    assert.equal(drops.embeds.length, 1);
    assert.match(drops.content, /📖 \[Bite\]\(<https:\/\/wiki\.warframe\.com\/w\/Bite>\)/);
    const wiki = await smartAnswer('what does bite do?', ctxOf());
    assert.equal(wiki.source, 'excerpt');
    assert.match(wiki.content, /^> Bite is a Mod/);
    assert.equal(wiki.model, null, 'no model anywhere');
  });

  it('lists answers worth a look', () => {
    const store = new Store(':memory:');
    const log = (question: string, review: string | null) => store.addAiLog('g', { at: Date.now(), userId: '5', userName: 'Rat', channelId: 'c', via: 'chat', question, intent: 'wiki', source: 'lookup', model: null, found: true, ms: 1, answer: 'a', review });
    log('fine', null);
    log('thin', 'links only: x');
    store.rateAiLog('g', log('rated', null), 'wrong', '7');
    assert.deepEqual(store.aiLogToReview('g', 0, 10).map((e) => e.question).sort(), ['rated', 'thin']);
  });
});
