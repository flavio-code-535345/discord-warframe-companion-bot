import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText, chunkWikitext, cleanWikitext } from '../src/wiki/clean.js';
import { WikiCrawler } from '../src/wiki/crawler.js';
import { MIN_READY_PAGES, WikiIndex } from '../src/wiki/index.js';
import { queryTerms, titleCandidates } from '../src/wiki/terms.js';
import { setWikiIndex } from '../src/wiki/index.js';
import { searchWiki } from '../src/warframe/wiki.js';

test('cleanWikitext keeps prose and drops markup', () => {
  const text = cleanWikitext(
    [
      "{{Spoiler}}{{Infobox\n| Box title = Eidolon\n}}",
      "'''Eidolons''' are {{Faction|Sentient|Sentients}} of the [[Plains of Eidolon|Plains]]; see [[Sortie#Rules]]<ref>a note</ref>.",
      '[[File:Pic.png|thumb|A picture]] [[Category:Enemies]] [[de:Eidolon]]',
      'Read [https://example.com the guide] or [https://example.com/x].<!-- hidden -->',
      '* first<br />item',
      '** second &amp; third',
      '__TOC__',
    ].join('\n'),
  );
  assert.match(text, /^Eidolons are Sentients of the Plains; see Sortie\./m);
  assert.match(text, /Read the guide or \./);
  assert.match(text, /• first item/);
  assert.match(text, /• second & third/);
  for (const gone of ['{{', 'Infobox', 'thumb', 'Category', 'de:', 'hidden', 'TOC', "'''", 'a note']) assert.ok(!text.includes(gone), `still contains ${gone}`);
});

test('cleanWikitext removes nested templates and flattens tables', () => {
  const text = cleanWikitext('Before {{Outer|{{Inner|x}}|y}} after.\n{|class="wikitable"\n|+ Rewards\n|-\n! Item !! Chance\n|-\n| style="x" | Forma || 5%\n|-\n| Potato || 1%\n|}\nEnd.');
  assert.match(text, /Before\s+after\./);
  assert.match(text, /Rewards/);
  assert.match(text, /Item · Chance/);
  assert.match(text, /Forma · 5%/);
  assert.match(text, /Potato · 1%/);
  assert.match(text, /End\./);
  assert.ok(!text.includes('wikitable'));
});

test('chunkText splits by heading, skips reference-like sections and caps chunk size', () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} about something useful here.`).join('\n');
  const chunks = chunkText(`Intro paragraph that is long enough to keep.\n== Mechanics ==\n${long}\n== References ==\nDo not index this reference line at all.\n== Rewards ==\nA reward list that stays in the index for players.`, 400);
  assert.equal(chunks[0]!.section, 'Introduction');
  assert.ok(chunks.filter((c) => c.section === 'Mechanics').length > 1, 'long sections are split');
  assert.ok(chunks.every((c) => c.body.length <= 450));
  assert.ok(!chunks.some((c) => /reference line/.test(c.body)));
  assert.equal(chunks.at(-1)!.section, 'Rewards');
  assert.deepEqual(chunkWikitext('tiny'), [], 'pages with no real text produce no chunks');
});

test('queryTerms keeps meaningful words only', () => {
  assert.deepEqual(queryTerms("How do I get the Archon Shards for Rhino's build?"), ['archon', 'shards', 'rhino', 'build']);
  assert.deepEqual(queryTerms('what is the'), []);
  assert.ok(titleCandidates('how do archon shards work')[0]!.split(' ').length > 1);
});

function sampleIndex() {
  const index = new WikiIndex(':memory:');
  const put = (title: string, revid: number, ...sections: [string, string][]) =>
    index.putPage(title, revid, sections.map(([section, body]) => ({ section, body })));
  put('Archon Shard', 1, ['Introduction', 'Archon Shards are crystals dropped by Archon Hunt bosses that can be slotted into a Warframe for permanent bonuses.'], ['Fusing', 'Fuse five Archon Shards of one colour to make a Tauforged shard with a stronger bonus.']);
  put('Eidolon', 1, ['Introduction', 'Eidolons are heavily fragmented Sentients that roam the Plains of Eidolon at night.']);
  put('Kuva Lich', 1, ['Introduction', 'See subpages.']);
  put('Kuva Lich/Main', 1, ['Introduction', 'A Kuva Lich is a Grineer adversary that steals your Requiem mods and must be defeated by finding their murmurs.']);
  put('Update 36', 1, ['Changes', 'Changed Archon Shards and Eidolons and the Kuva Lich and Rhino and everything else in one huge patch note entry.']);
  put('Rhino', 1, ['Introduction', 'Rhino is a tanky Warframe whose Iron Skin ability grants invulnerability and he can stomp enemies.']);
  put('Rhino Prime', 1, ['Introduction', 'Rhino Prime is the Prime variant of Rhino with higher stats and a different polarity.']);
  return index;
}

test('search: a page named in the question comes first, with the passage that matches', () => {
  const index = sampleIndex();
  const [top] = index.search('how do I fuse archon shards?');
  assert.equal(top!.title, 'Archon Shard');
  assert.match(top!.extract, /Fuse five Archon Shards/);
  assert.match(top!.extract, /\*\*Fusing\*\*/);
  assert.equal(top!.url, 'https://wiki.warframe.com/w/Archon_Shard');
});

test('search: shell pages fall through to their subpage and patch notes stay out unless asked', () => {
  const index = sampleIndex();
  assert.match(index.search('what is a kuva lich')[0]!.extract, /Grineer adversary/);
  assert.ok(!index.search('archon shards eidolons kuva lich rhino').some((r) => r.title === 'Update 36'));
  assert.ok(index.search('what changed in update 36 for archon shards').some((r) => r.title === 'Update 36'));
});

test('search: finds pages by their content and returns nothing for unrelated questions', () => {
  const index = sampleIndex();
  assert.equal(index.search('which warframe has iron skin')[0]!.title, 'Rhino');
  assert.deepEqual(index.search('how do I bake a chocolate cake'), []);
  assert.deepEqual(index.search('what is the'), []);
});

test('search: redirects count as naming their page', () => {
  const index = sampleIndex();
  index.replaceAliases(new Map([['Iron Hide', 'Rhino']]));
  assert.equal(index.search('tell me about iron hide')[0]!.title, 'Rhino');
  index.replaceAliases(new Map());
  assert.notEqual(index.search('tell me about iron hide')[0]?.title, 'Rhino');
});

test('search: a disambiguation page never beats the real page, but is offered after it', () => {
  const index = sampleIndex();
  index.putPage('Riven', 1, [{ section: 'Introduction', body: 'Riven may refer to the following: Riven Mods, unique mods that feature randomized stats.' }]);
  index.putPage('Riven Mods', 1, [{ section: 'Introduction', body: 'Riven Mods are special mods whose stats are randomized and unique to each copy.' }]);
  const titles = index.search('how do I get a riven').map((r) => r.title);
  assert.deepEqual(titles, ['Riven Mods', 'Riven']);
  assert.equal(index.search('riven')[0]!.title, 'Riven Mods');
});

test('search: a title matching more of the question wins, and empty stub pages do not swallow the match', () => {
  const index = sampleIndex();
  index.putPage('Arcane', 1, [{ section: 'Introduction', body: 'Arcane can refer to: Arcane Boiler, Arcane Codices and the Arcane Enhancement system for gear.' }]);
  index.putPage('Arcane Enhancement', 1, [{ section: 'Introduction', body: 'Arcane Enhancements are upgrades that equip to a Warframe and trigger on certain events.' }]);
  assert.equal(index.search('how do I get arcanes')[0]!.title, 'Arcane Enhancement');

  index.putPage('Riven Sliver', 1, [{ section: 'Introduction', body: 'A Riven Sliver is a fragment of a Riven Mod traded to Palladino for rewards.' }]);
  index.putPage('Riven Mods', 1, [{ section: 'Introduction', body: 'Riven Mods are special mods whose stats are randomized and unique to each copy.' }]);
  assert.equal(index.search('riven')[0]!.title, 'Riven Mods');

  index.putPage('Types', 1, [{ section: 'Introduction', body: 'Hm' }]);
  assert.equal(index.search('what are the types of eidolons')[0]!.title, 'Eidolon');
});

test('search: a section named after the page itself does not outrank the introduction', () => {
  const index = new WikiIndex(':memory:');
  index.putPage('Helminth', 1, [
    { section: 'Introduction', body: 'The Helminth is a living Infested organ aboard the Orbiter that feeds on Warframe abilities.' },
    { section: 'Helminth Cyst', body: 'A Helminth Cyst is needed before the Infirmary becomes available to the Tenno.' },
    { section: 'Subsuming', body: 'Subsuming a Warframe lets the Helminth replace one ability with another warframe ability.' },
  ]);
  const [top] = index.search('what is a helminth');
  assert.match(top!.extract, /living Infested organ/);
  assert.ok(!top!.extract.includes('**Helminth Cyst**'));
});

test('putPage replaces a page and deletePage removes its text from search', () => {
  const index = sampleIndex();
  index.putPage('Rhino', 2, [{ section: 'Introduction', body: 'Rhino was reworked into a rolling wrecking ball of pure momentum.' }]);
  assert.equal(index.search('wrecking ball')[0]!.title, 'Rhino');
  assert.deepEqual(index.search('iron skin invulnerability'), []);
  assert.equal(index.revisions().get('Rhino'), 2);
  index.deletePage('Rhino');
  assert.ok(!index.revisions().has('Rhino'));
  assert.deepEqual(index.search('wrecking ball'), []);
  assert.match(index.readPage('Eidolon')!.extract, /heavily fragmented/);
  assert.equal(index.readPage('Nope'), null);
});

test('searchWiki answers from the index once it is big enough', async () => {
  const index = sampleIndex();
  setWikiIndex(index);
  try {
    assert.equal(index.ready(), false, 'a handful of pages is not a usable index yet');
    for (let i = 0; i < MIN_READY_PAGES; i++) index.putPage(`Filler ${i}`, 1, [{ section: 'Introduction', body: `Filler page number ${i} with enough text to count as indexed.` }]);
    assert.equal(index.ready(), true);
    const hits = await searchWiki('how do archon shards fuse');
    assert.equal(hits[0]!.title, 'Archon Shard');
  } finally {
    setWikiIndex(null);
  }
});

// --- crawler against a fake MediaWiki ---

function fakeWiki(pages: Record<string, { revid: number; text: string; redirects?: string[] }>) {
  const log: string[] = [];
  const fetcher = async (url: string): Promise<Response> => {
    const q = new URL(url).searchParams;
    if (q.get('generator') === 'allpages') {
      log.push('list');
      return Response.json({
        query: { pages: Object.entries(pages).map(([title, p]) => ({ title, lastrevid: p.revid, redirects: (p.redirects ?? []).map((r) => ({ title: r })) })) },
      });
    }
    const titles = (q.get('titles') ?? '').split('|');
    log.push(`fetch ${titles.join(',')}`);
    return Response.json({
      query: { pages: titles.map((t) => (pages[t] ? { title: t, revisions: [{ revid: pages[t]!.revid, slots: { main: { content: pages[t]!.text } } }] } : { title: t, missing: true })) },
    });
  };
  return { log, fetcher };
}

const BODY = (s: string) => `'''${s}''' is a thing in the game that has more than enough text to be indexed properly.`;

test('crawler indexes new pages, skips unchanged ones, refreshes changed ones and removes deleted ones', async () => {
  const wiki = fakeWiki({ Alpha: { revid: 1, text: BODY('Alpha') }, Beta: { revid: 1, text: BODY('Beta') } });
  const index = new WikiIndex(':memory:');
  const crawler = new WikiCrawler(index, wiki.fetcher, 0);

  assert.deepEqual(await crawler.refresh(), { total: 2, changed: 2, removed: 0 });
  assert.ok(index.search('alpha')[0]);

  wiki.log.length = 0;
  assert.deepEqual(await crawler.refresh(), { total: 2, changed: 0, removed: 0 });
  assert.deepEqual(wiki.log, ['list'], 'an unchanged wiki costs one listing and no page downloads');

  const changed = fakeWiki({ Alpha: { revid: 2, text: BODY('Alpha') + ' Now with a brand new zebra section.' }, Gamma: { revid: 1, text: BODY('Gamma') } });
  const second = new WikiCrawler(index, changed.fetcher, 0);
  assert.deepEqual(await second.refresh(), { total: 2, changed: 2, removed: 1 });
  assert.equal(index.search('zebra')[0]!.title, 'Alpha');
  assert.ok(!index.revisions().has('Beta'));
  assert.ok(index.getMeta('refreshed_at'));
});

test('crawler stores redirects as aliases of their article', async () => {
  const index = new WikiIndex(':memory:');
  const wiki = fakeWiki({ 'Zariman (Tileset)': { revid: 1, text: BODY('Zariman'), redirects: ['Zariman', 'Lohk Surges'] } });
  await new WikiCrawler(index, wiki.fetcher, 0).refresh();
  assert.equal(index.search('how does the zariman work')[0]!.title, 'Zariman (Tileset)');
  assert.equal(index.search('what are lohk surges')[0]!.title, 'Zariman (Tileset)');
});

test('crawler refuses a truncated listing instead of wiping the index', async () => {
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`Page ${i}`, { revid: 1, text: BODY(`Page ${i}`) }]));
  const index = new WikiIndex(':memory:');
  await new WikiCrawler(index, fakeWiki(many).fetcher, 0).refresh();
  assert.equal(index.stats().pages, 60);

  const tiny = fakeWiki({ 'Page 0': many['Page 0']! });
  await assert.rejects(new WikiCrawler(index, tiny.fetcher, 0).refresh(), /incomplete/);
  assert.equal(index.stats().pages, 60);
});

test('a "what is X" question always gets the introduction of the named page, even when other sections match better', () => {
  const index = new WikiIndex(':memory:');
  index.putPage('Helminth', 1, [
    { section: 'Introduction', body: 'The Helminth is a sentient Infested system in the Orbiter that lets you subsume abilities from other Warframes.' },
    { section: 'Helminth Cyst', body: 'Nidus can sit on the chair, which starts a cyst that grows for days; start the process by feeding it.' },
    { section: 'Secretions', body: 'Feed the Helminth resources to start the process of converting them into secretions.' },
  ]);
  const hit = index.search('what is the helminth and how do I start it', 3)[0]!;
  assert.equal(hit.title, 'Helminth');
  assert.match(hit.extract, /^The Helminth is a sentient Infested system/, 'the introduction comes first');
  const plain = index.search('how do I start the helminth', 3)[0]!;
  assert.doesNotMatch(plain.extract, /^The Helminth is a sentient/, 'only definition questions add it');
});

test('amount templates keep their number and unit instead of vanishing', () => {
  const text = cleanWikitext("It will cost your account {{pc|200}}. Kuva Siphon awards {{kc|550-700}}, a bounty {{cc|50,000}} and {{Ec|15}}; changed in {{ver|32.2.4}}.");
  assert.equal(text, 'It will cost your account 200 Platinum. Kuva Siphon awards 550-700 Kuva, a bounty 50,000 Credits and 15 Endo; changed in Update 32.2.4.');
});

test('crawler cleans every stored page again once after the cleaning changed, then only edited pages', async () => {
  const wiki = fakeWiki({ Alpha: { revid: 1, text: BODY('Alpha') }, Beta: { revid: 1, text: BODY('Beta') } });
  const index = new WikiIndex(':memory:');
  const crawler = new WikiCrawler(index, wiki.fetcher, 0);
  await crawler.refresh();
  index.setMeta('clean_version', '1'); // as an index built by an older version would be
  assert.deepEqual(await crawler.refresh(), { total: 2, changed: 2, removed: 0 }, 'same revisions, cleaned again');
  assert.deepEqual(await crawler.refresh(), { total: 2, changed: 0, removed: 0 });
});

test('a page named the way members type it, or misspelt, is still the subject', () => {
  const index = new WikiIndex(':memory:');
  const put = (title: string, body: string) => index.putPage(title, 1, [{ section: 'Introduction', body }]);
  put('The Icebind', 'The Icebind is a weekly endgame activity reached by speaking to Cephalon Melica on Yuvan Peak.');
  put('Incarnon', 'Incarnon is a weapon mechanic that transforms weapons into Incarnon Form after enough headshots.');
  put('Clan', 'A Clan is a group of players who share a Dojo, research and trading facilities.');
  assert.equal(index.subjectOf('how can I access ice bind'), 'The Icebind');
  assert.equal(index.subjectOf('when is the next incronon'), 'Incarnon');
  assert.equal(index.search('how can I access ice bind')[0]?.title, 'The Icebind', 'search uses the same match');
  assert.equal(index.subjectOf('this clanka dumb af'), null, 'short words are never guessed');
  assert.equal(index.subjectOf('what is the best way'), null);
});

test('a long question still reaches its single words, punctuation aside, and redirects that are ordinary words are not guessed', () => {
  const long = 'Whens the next time I can farm Strun incarnon? since its a weekly rotation?';
  const candidates = titleCandidates(long);
  assert.ok(candidates.includes('Strun Incarnon'), 'the question mark is not part of the name');
  assert.ok(candidates.includes('Strun'), 'single words are not cut off by the longer runs');
  const index = new WikiIndex(':memory:');
  index.putPage('Strun', 1, [{ section: 'Introduction', body: 'The Strun is a Tenno shotgun with a large magazine and wide spread.' }]);
  index.putPage('Upcoming Features', 1, [{ section: 'Introduction', body: 'This page is a record of future content teased by Digital Extremes.' }]);
  for (const t of ['Alpha', 'Beta', 'Gamma']) index.putPage(t, 1, [{ section: 'Introduction', body: `${t} comes next in the list of things the next update brings.` }]);
  index.replaceAliases(new Map([['Next', 'Upcoming Features']]));
  assert.equal(index.subjectOf(long), 'Strun');
});

test('a word members use finds the page that uses the wiki word for it', () => {
  const index = new WikiIndex(':memory:');
  index.putPage('FAQ', 1, [{ section: 'General FAQ', body: 'Q: Can I change my in-game username? A: Yes, through the official Warframe website, for 200 Platinum.' }]);
  index.putPage('Ostron', 1, [
    { section: 'Introduction', body: 'The Ostrons are the inhabitants of the Cetus settlement near the Plains of Eidolon on Earth.' },
    { section: 'Ranks', body: 'Rank titles of the Ostron syndicate from Neutral to Kin, each with its own wares.' },
    { section: 'Standing Gain', body: 'Standing with Ostron is earned by completing Bounties for Konzu and trading fish to Fisher Hai-Luk.' },
  ]);
  assert.equal(index.search('how do I change my nickname')[0]?.title, 'FAQ');
  const ostron = index.search('how do i gather ostron syndicate reputation', 1, { pageChunks: 2 })[0]!.extract;
  assert.match(ostron, /^The Ostrons are/, 'the answer pipeline always gets the introduction');
  assert.match(ostron, /Standing Gain/, 'and the section about reputation, which the wiki calls standing');
  assert.doesNotMatch(ostron, /Rank titles/);
  index.putPage('Syndicate', 1, [{ section: 'Introduction', body: 'Syndicates are factions that reward standing with offerings, ranks and augments.' }]);
  index.replaceAliases(new Map([['Syndicate Reputation', 'Syndicate']]));
  assert.equal(index.subjectOf('how do i gather ostron syndicate reputation'), 'Ostron', 'a name of category words gives way to a specific one');
});
