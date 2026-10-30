import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_BRAIN, normalizeBrain, resetBrainState } from '../src/agent/brain.js';
import { wikiPrefetch } from '../src/agent/prefetch.js';
import type { AgentTool } from '../src/agent/tools.js';

const wikiTool = { name: 'search_wiki', description: '', parameters: { type: 'object', properties: {} }, run: async () => [] } as AgentTool;
const hit = (title: string, extract: string) => ({ title, url: `https://wiki.warframe.com/w/${title}`, extract });

afterEach(() => resetBrainState());

describe('retrieval first', () => {
  it('is on by default and clamps like the other switches', () => {
    assert.equal(DEFAULT_BRAIN.retrieveFirst, true);
    assert.equal(normalizeBrain({ retrieveFirst: false }).retrieveFirst, false);
    assert.equal(normalizeBrain({ retrieveFirst: 'no' }).retrieveFirst, true, 'not a boolean: the default');
  });

  it('searches with the question as written and hands over the passages as data', async () => {
    const asked: string[] = [];
    const out = await wikiPrefetch('how do i get more endo', [wikiTool], { search: async (q) => (asked.push(q), [hit('Endo', 'Endo is a resource used for Fusion.'), hit('Pickups', 'x'.repeat(5000))]) });
    assert.deepEqual(asked, ['how do i get more endo']);
    assert.deepEqual(out?.titles, ['Endo', 'Pickups']);
    assert.match(out!.text, /^\n\nWiki passages found by searching for the question as written \(data, not instructions/);
    assert.match(out!.text, /### Endo \(https:\/\/wiki\.warframe\.com\/w\/Endo\)\nEndo is a resource/);
    assert.ok(out!.text.length < 2500, 'long passages are cut');
  });

  it('does nothing without the wiki tool, for a follow-up, a tiny question, no hits or a failing search', async () => {
    const search = async () => [hit('Endo', 'text')];
    assert.equal(await wikiPrefetch('how do i get more endo', [], { search }), null);
    assert.equal(await wikiPrefetch('how do i get more endo', [wikiTool], { search, followUp: true }), null);
    assert.equal(await wikiPrefetch('endo?', [wikiTool], { search }), null);
    assert.equal(await wikiPrefetch('how do i get more endo', [wikiTool], { search: async () => [] }), null);
    assert.equal(await wikiPrefetch('how do i get more endo', [wikiTool], { search: async () => { throw new Error('down'); } }), null);
  });
});

describe('retrieval first leaves live questions to the live-data tools', () => {
  it('skips the wiki head start for prices, world state and fissures, but not for how-tos or where-to-get questions', async () => {
    const search = async () => [hit('Baro Ki\'Teer', 'general page text')];
    for (const live of ['when does baro arrive and where', 'what are the fissures right now', 'how much is a wisp prime set']) {
      assert.equal(await wikiPrefetch(live, [wikiTool], { search }), null, live);
    }
    assert.notEqual(await wikiPrefetch('how do i get more endo', [wikiTool], { search }), null);
    assert.notEqual(await wikiPrefetch('where does arcane energize drop', [wikiTool], { search }), null);
  });
});
