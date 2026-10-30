import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { agentFits, agentPromptTokens } from '../src/agent/answer.js';
import { resetBrainState, updateBrain } from '../src/agent/brain.js';
import { TOOL_NAMES } from '../src/agent/tools.js';
import { resetAiToggles } from '../src/ai/settings.js';
import { groundAnswer } from '../src/answers/check.js';
import { availability, circuitAnswer, circuitTopic, namedIn, nextReset, parseRotations, resetRotations, weekOf } from '../src/answers/circuit.js';
import { resetLocalAi } from '../src/answers/compose.js';
import { forget, memoryKey, recall, recallSubject, remember } from '../src/answers/memory.js';
import { dropFact, elementsFact, factAnswer, factsUserPrompt, mathAnswer, relevantDrops } from '../src/answers/pipeline.js';
import { smartAnswer, withoutName } from '../src/answers/smart.js';
import { classifyAsk, mathExpression, noContent, questionLike, wantsResearch } from '../src/answers/understand.js';
import { Store } from '../src/db.js';
import { api } from '../src/warframe/fetch.js';
import { MIN_READY_PAGES, WikiIndex, setWikiIndex } from '../src/wiki/index.js';

const config = {
  BOT_NAME: 'Cephalon Ordis',
  CLAN_NAME: 'The Rats Den 69',
  DISCORD_GUILD_ID: 'g',
  OPERATOR_IDS: ['1'],
  PANEL_OWNER_IDS: ['9'],
  LOCAL_AI_URL: 'http://h:11434/v1',
  LOCAL_AI_MODEL: 'gemma',
  LOCAL_AI_TIMEOUT_SECONDS: 5,
  FREE_AI_KEY: undefined as string | undefined,
  FREE_AI_URL: 'https://cloud.example/v1',
  FREE_AI_MODEL: 'cloud',
  FREE_AI_DAILY_LIMIT: 100,
  WARFRAME_PLATFORM: 'pc',
  SEARXNG_URL: undefined as string | undefined,
};
const ctxOf = (store = new Store(':memory:')) => ({ config, store }) as never;

const realFetch = globalThis.fetch;
beforeEach(() => {
  api.reset();
  resetLocalAi();
  resetAiToggles();
  resetBrainState();
  resetRotations();
  forget();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setWikiIndex(null);
});

describe('understanding a question', () => {
  it('tells apart what kind of answer is wanted, on real phrasings from the clan', () => {
    const cases: [string, string][] = [
      ['Whats the best kuva farm?', 'farm'],
      ['what is the best farm for Tellurium?', 'farm'],
      ['Where do I farm Feral Kubrows the best?', 'farm'],
      ['where do I get the mod bite from?', 'acquire'],
      ['How do I get mastery points?', 'acquire'],
      ['how can I access ice bind', 'acquire'],
      ['how to unlock Steel path', 'acquire'],
      ['When can I get Torid incarnon next?', 'when'],
      ['how do archon shards work', 'explain'],
      ['what is the helminth', 'explain'],
      ['what does arcane energize do', 'explain'],
      ['how to I forma a weapon', 'howto'],
      ['How do I change my nickname?', 'howto'],
      ['kuva bramma vs kuva ogris', 'compare'],
      ['Give me all damage variations combinations', 'general'],
    ];
    for (const [q, ask] of cases) assert.equal(classifyAsk(q), ask, q);
  });

  it('finds plain arithmetic and nothing else', () => {
    assert.equal(mathExpression('what is 9 x 2'), '9 x 2');
    assert.equal(mathExpression('What is 2+2?'), '2+2');
    assert.equal(mathExpression('1,000 * 3'), '1000 * 3');
    for (const q of ['what is 9', 'what is the best kuva farm', 'mr 14 weapons', '2026']) assert.equal(mathExpression(q), null, q);
    assert.equal(mathAnswer('9 x 2'), '9 × 2 = **18**');
    assert.equal(mathAnswer('1 / 0'), null);
  });

  it('knows chatter, links and reactions from questions and requests', () => {
    for (const q of ['https://klipy.com/gifs/clanker-kylo-ren', '<@220147375786688512>', 'lol', '😂😂', '...']) assert.equal(noContent(q), true, q);
    for (const q of ['cbt', 'this clanka dumb af', 'wisp prime']) assert.equal(noContent(q), false, q);
    for (const q of ['how do i get wisp', 'Give me all damage variations combinations', 'is baro here', 'wisp?']) assert.equal(questionLike(q), true, q);
    for (const q of ['this clanka dumb af', 'cbt', 'wisp prime']) assert.equal(questionLike(q), false, q);
  });

  it('notices when the member asks for a web search', () => {
    for (const q of ['Ordis, check reddit to what the best standard kuva is?', 'research online what the best kuva farm is', 'search the web for the new update']) assert.equal(wantsResearch(q), true, q);
    for (const q of ['how do i get wisp', 'what is reddit']) assert.equal(wantsResearch(q), false, q);
  });
});

describe('the grounding check', () => {
  const facts = 'Bite is a Mod for Beast Claws that increases Critical Chance. Drop tables: Bite: Earth/Cervantes (Caches) 3.67%; Kubrow 0.01%.';

  it('keeps an answer the facts support', () => {
    const a = 'You get **Bite** from **Kubrow** enemies (0.01%) and from caches on **Earth/Cervantes** (3.67%).';
    assert.deepEqual(groundAnswer(a, facts), { text: a, removed: [] });
  });

  it('removes a sentence with a number or two names the facts do not have', () => {
    const a = 'Bite drops from Kubrow enemies and caches on Earth.\nIt also costs 200 Platinum in the Market.\nSome say Teshin sells it in the Relays.';
    const g = groundAnswer(a, facts, 0.7)!;
    assert.equal(g.text, 'Bite drops from Kubrow enemies and caches on Earth.');
    assert.deepEqual(g.removed.map((r) => r.why), ['number 200', 'names Teshin, Relays']);
  });

  it('gives up when most of the answer is unsupported', () => {
    assert.equal(groundAnswer('Viral comes from the Viral mod. Equip Toxic Lash and Hellfire for 90% status.', facts), null);
  });

  it('drops a list intro whose items all went, and keeps list items that are fine', () => {
    const a = 'Bite comes from caches.\nAlso sold by:\n- Teshin in the Relays for 50 Steel Essence\n\nDrops:\n- **Kubrow**: 0.01%\n- **Earth/Cervantes**: 3.67%';
    const g = groundAnswer(a, facts, 0.6)!;
    assert.equal(g.text, 'Bite comes from caches.\nDrops:\n- **Kubrow**: 0.01%\n- **Earth/Cervantes**: 3.67%');
  });
});

// The rotation tables as the local wiki index stores "The Circuit" (shortened to the parts the parser reads).
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

  it('says so instead of guessing when it cannot see this week, and leaves other questions alone', async () => {
    const blind = { ...deps(), world: async () => Promise.reject(new Error('off')) };
    const a = (await circuitAnswer('When can I get Torid incarnon next?', blind))!;
    assert.match(a, /week 5 \(E\) of the 9-week Steel Path Circuit rotation/);
    assert.match(a, /can't see this week's offerings/);
    assert.equal(await circuitAnswer('how do I get the Laetum incarnon', deps()), null, 'not a Circuit weapon: the wiki answers it');
    assert.equal(await circuitAnswer('how do I get torid', deps()), null);
  });
});

describe('conversation memory', () => {
  it('remembers what the conversation is about until another subject comes up or it goes quiet', () => {
    const key = memoryKey('c', '5');
    remember(key, 'how do i get wisp', 'From the Ropalolyst.', 1_000, 'Wisp');
    assert.equal(recallSubject(key, 2_000), 'Wisp');
    remember(key, 'thanks', 'You are welcome.', 3_000);
    assert.equal(recallSubject(key, 4_000), 'Wisp', 'an answer without a subject keeps the old one');
    remember(key, 'what is helminth', 'An infested room.', 5_000, 'Helminth');
    assert.equal(recallSubject(key, 6_000), 'Helminth');
    assert.equal(recallSubject(key, 5_000 + 31 * 60_000), null);
    assert.equal(recall(key, 10, 6_000).length, 6);
  });
});

/** A wiki index that counts as ready (it needs MIN_READY_PAGES pages) with the given pages in it. */
function readyIndex(pages: Record<string, string>): WikiIndex {
  const index = new WikiIndex(':memory:');
  for (const [title, body] of Object.entries(pages)) index.putPage(title, 1, [{ section: 'Introduction', body }]);
  for (let i = 0; i < MIN_READY_PAGES; i++) index.putPage(`Filler ${i}`, 1, [{ section: 'Introduction', body: `Filler page number ${i} with enough text to count as indexed.` }]);
  setWikiIndex(index);
  return index;
}

/** A fake network: drop-table searches from `drops`, and the model's replies in order. Records what the model was sent. */
function fakeNet(drops: Record<string, { item: string; place: string; chance: number }[]>, replies: string[]) {
  const sent: { system: string; user: string }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const m = /\/drops\/search\/([^?]+)/.exec(u);
    if (m) return Response.json((drops[decodeURIComponent(m[1]!).toLowerCase()] ?? []).map((d) => ({ ...d, rarity: 'Common' })));
    if (u.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      sent.push({ system: body.messages[0]!.content, user: body.messages[1]!.content });
      return Response.json({ choices: [{ message: { content: replies.shift() ?? 'NOT_COVERED' } }] });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return sent;
}

describe('the facts pipeline', () => {
  it('keeps only the drop tables of the item and its blueprints', () => {
    const g = (item: string) => ({ item, locations: [{ place: 'X', item, rarity: 'Common', chance: 10 }] });
    const groups = [g('Wisp Blueprint'), g('Wisp Chassis Blueprint'), g('Wisp Prime Chassis Blueprint'), g('3X Cetus Wisp'), g('Fused Reservoir (Wisp)')];
    assert.deepEqual(relevantDrops(groups, 'Wisp').map((x) => x.item), ['Wisp Blueprint', 'Wisp Chassis Blueprint']);
    assert.deepEqual(relevantDrops([g('Bite'), g('Frostbite'), g('Primary Frostbite')], 'bite').map((x) => x.item), ['Bite']);
    assert.match(dropFact([g('Bite')])!.text, /^Bite: X 10%$/);
  });

  it('gives the recipe of every secondary element from the wiki pages, for combination questions only', async () => {
    const recipes: Record<string, string> = { Blast: 'Heat and Cold', Corrosive: 'Toxin and Electricity', Gas: 'Heat and Toxin', Magnetic: 'Cold and Electricity', Radiation: 'Heat and Electricity', Viral: 'Cold and Toxin' };
    const read = async (title: string) => {
      const e = /^Damage\/(\w+) Damage$/.exec(title)?.[1];
      return e && recipes[e] ? { title, url: 'u', extract: `${e} Damage is one of the six secondary elemental damage types, composed of ${recipes[e]} elements.` } : null;
    };
    const f = (await elementsFact('Give me all damage variations combinations', read))!;
    assert.match(f.text, /^Blast = Heat \+ Cold\nCorrosive = Toxin \+ Electricity/);
    assert.match(f.text, /Viral = Cold \+ Toxin$/);
    assert.ok(await elementsFact('How do I gain the viral status effect on my guns', read));
    assert.equal(await elementsFact('what does viral do to infested', read), null, 'naming an element is not asking how to make it');
    assert.equal(await elementsFact('how do I get wisp', read), null);
  });

  it('tells the model about a follow-up and its subject', () => {
    const user = factsUserPrompt('and how do I get it?', [{ label: 'Wiki: Wisp', text: 'Wisp drops from the Ropalolyst.' }], { previous: 'what is wisp', subject: 'Wisp' });
    assert.match(user, /QUESTION: and how do I get it\?\n\(This follows the member's previous question: "what is wisp", which was about Wisp\.\)/);
    assert.match(user, /FACTS:\n\[1\] Wiki: Wisp\nWisp drops from the Ropalolyst\./);
  });

  it('answers from the wiki page the question names plus its drop table, and checks the wording', async () => {
    readyIndex({ Bite: 'Bite is a Mod for Beast Claws that increases Critical Chance and Critical Damage.' });
    const sent = fakeNet({ bite: [{ item: 'Bite', place: 'Earth/Cervantes (Caches), Rot C', chance: 3.67 }, { item: 'Bite', place: 'Kubrow', chance: 0.01 }] }, [
      'You get **Bite** from caches on **Earth/Cervantes** (3.67%) and, rarely, from **Kubrow** enemies.\nIt also costs 50 Platinum in the Market.',
    ]);
    const a = await factAnswer(ctxOf(), 'where do I get the mod bite from?', { ask: 'acquire', item: 'mod bite' });
    assert.equal(a.found, true);
    assert.equal(a.source, 'local');
    assert.equal(a.subject, 'Bite');
    assert.equal(a.content, 'You get **Bite** from caches on **Earth/Cervantes** (3.67%) and, rarely, from **Kubrow** enemies.', 'the invented price is removed');
    assert.match(sent[0]!.user, /\[1\] Wiki: Bite\nBite is a Mod/);
    assert.match(sent[0]!.user, /\[2\] Drop tables[^\n]*\nBite: Earth\/Cervantes \(Caches, rotation C\) 3\.67%; Kubrow 0\.01%/);
    assert.match(sent[0]!.system, /using only the FACTS/);
    assert.match(sent[0]!.system, /Say exactly how to get it: where it drops/);
    assert.equal(a.embeds.length, 2, 'the wiki source and the drop table');
  });

  it('quotes the wiki when the model has no answer, and admits when there is nothing', async () => {
    readyIndex({ Helminth: 'The Helminth is an infested room in the Orbiter that lets you subsume Warframe abilities.' });
    fakeNet({}, ['NOT_COVERED']);
    const a = await factAnswer(ctxOf(), 'what is the helminth', { ask: 'explain' });
    assert.equal(a.source, 'excerpt');
    assert.match(a.content, /^From the archives, Operator:\nThe Helminth is an infested room/);
    fakeNet({}, []);
    const none = await factAnswer(ctxOf(), 'zxqv plorb', { ask: 'general' });
    assert.equal(none.found, false);
  });

  it('never quotes a page the question did not name, when the model finds no answer in it', async () => {
    readyIndex({ 'Kinemantik Instant Messenger': 'Aoi says she cannot make it anymore in that itchy wool sweater, so she stays home tonight.' });
    fakeNet({}, ['NOT_COVERED']);
    const a = await factAnswer(ctxOf(), 'how can I make my ass not itchy anymore', { ask: 'howto' });
    assert.equal(a.found, false);
    assert.match(a.content, /could not find that/);
    assert.doesNotMatch(a.content, /sweater/);
  });
});

describe('the agent fallback', () => {
  it('stays out when its prompt and tools would not fit the local model', () => {
    const store = new Store(':memory:');
    updateBrain(store, { prompt: 'x'.repeat(8000) });
    assert.equal(agentFits(ctxOf(store)), false, 'the live 8,000-character prompt');
    updateBrain(store, { prompt: 'Short prompt. {{persona}}', disabledTools: TOOL_NAMES.filter((t) => !['search_wiki', 'lookup_item', 'search_drops'].includes(t)) });
    assert.equal(agentFits(ctxOf(store)), true);
    assert.ok(agentPromptTokens(ctxOf(store)) < 1000);
    updateBrain(store, { prompt: 'x'.repeat(8000) });
    assert.equal(agentFits({ config: { ...config, LOCAL_AI_URL: undefined }, store } as never), true, 'a cloud model has room');
  });
});

describe('smartAnswer routing', () => {
  it('takes the name off a request to Ordis, but not off a remark about him', () => {
    assert.equal(withoutName('Ordis, how do I get wisp'), 'how do I get wisp');
    assert.equal(withoutName('ordis how do I get wisp'), 'how do I get wisp');
    assert.equal(withoutName('Ordis check reddit what the best kuva farm is'), 'check reddit what the best kuva farm is');
    assert.equal(withoutName('Ordis is dumb'), 'Ordis is dumb');
    assert.equal(withoutName('Ordis'), 'Ordis');
    assert.equal(withoutName('Ordisphere'), 'Ordisphere');
  });

  it('does sums without a model and chatter without the wiki', async () => {
    readyIndex({ Bite: 'Bite is a Mod for Beast Claws that increases Critical Chance and Critical Damage.' });
    const sent = fakeNet({}, ['Ordis is unbothered, Operator.']);
    const sum = await smartAnswer('what is 9 x 2', ctxOf(), { id: '5', name: 'Rat' });
    assert.equal(sum.intent, 'math');
    assert.match(sum.content, /= \*\*18\*\*/);
    const gif = await smartAnswer('https://klipy.com/gifs/clanker-kylo-ren', ctxOf(), { id: '5', name: 'Rat' });
    assert.equal(gif.intent, 'smalltalk');
    assert.equal(gif.source, 'lookup');
    assert.equal(sent.length, 0, 'no model for a link');
    const insult = await smartAnswer('this clanka dumb af', ctxOf(), { id: '5', name: 'Rat' });
    assert.equal(insult.intent, 'smalltalk');
    assert.equal(insult.content, 'Ordis is unbothered, Operator.');
    assert.doesNotMatch(sent[0]!.system, /FACTS/);
  });

  it('carries the subject into a follow-up, and remembers it', async () => {
    readyIndex({ Wisp: 'Wisp is a Warframe. Her blueprints drop from the Ropalolyst on Jupiter.' });
    const sent = fakeNet({}, ['**Wisp** is a Warframe whose blueprints drop from the **Ropalolyst** on **Jupiter**.', 'Her blueprints drop from the **Ropalolyst** on **Jupiter**.']);
    const key = memoryKey('c', '5');
    const first = await smartAnswer('what is wisp', ctxOf(), { id: '5', name: 'Rat', key });
    assert.equal(first.subject, 'Wisp');
    assert.equal(recallSubject(key), 'Wisp');
    const second = await smartAnswer('and how do I get it?', ctxOf(), { id: '5', name: 'Rat', key });
    assert.equal(second.content, 'Her blueprints drop from the **Ropalolyst** on **Jupiter**.');
    assert.match(sent[1]!.user, /previous question: "what is wisp", which was about Wisp/);
    assert.match(sent[1]!.user, /\[1\] Wiki: Wisp/);
  });
});
