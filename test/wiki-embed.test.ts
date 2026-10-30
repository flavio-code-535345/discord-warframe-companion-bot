import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { bindEmbedder, cosine, embedStatus, embedderEnabled, rerankPassages } from '../src/wiki/embed.js';
import { WikiIndex, type WikiPassage } from '../src/wiki/index.js';

const passage = (title: string, extract: string): WikiPassage => ({ title, url: `https://wiki.warframe.com/w/${title}`, extract });

/** An embedder with three meanings: a text is a vector of how often it mentions alpha, beta and gamma. */
function fakeOllama(opts: { fail?: boolean } = {}) {
  const calls: string[][] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
    calls.push(input);
    if (opts.fail) return new Response('nope', { status: 500 });
    const vec = (t: string) => ['alpha', 'beta', 'gamma'].map((w) => t.toLowerCase().split(w).length - 1 + 0.01);
    return new Response(JSON.stringify({ embeddings: input.map(vec) }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls };
}

const chunk = (section: string, body: string) => ({ section, body });

describe('wiki reranking by meaning', () => {
  beforeEach(() => bindEmbedder({ LOCAL_AI_URL: 'http://ollama:11434/v1', EMBED_MODEL: 'tiny-embed' }));

  it('is off without an Ollama URL or an embedding model, and then changes nothing', async () => {
    const index = new WikiIndex(':memory:');
    bindEmbedder({ LOCAL_AI_URL: undefined, EMBED_MODEL: 'tiny-embed' });
    assert.equal(embedderEnabled(), false);
    assert.equal(await rerankPassages(index, 'alpha', [passage('A', 'alpha'), passage('B', 'beta')], 2), null);
    bindEmbedder({ LOCAL_AI_URL: 'http://x', EMBED_MODEL: '' });
    assert.equal(embedderEnabled(), false);
  });

  it('puts the passage closest in meaning first, and caches the vectors', async () => {
    const index = new WikiIndex(':memory:');
    const { fetcher, calls } = fakeOllama();
    const results = [passage('Alpha page', 'alpha alpha alpha'), passage('Beta page', 'beta beta beta')];
    const out = await rerankPassages(index, 'tell me about beta', results, 2, fetcher);
    assert.deepEqual(out?.map((p) => p.title), ['Beta page', 'Alpha page']);
    assert.equal(calls[0]!.length, 3, 'the question and both passages');

    await rerankPassages(index, 'tell me about beta', results, 2, fetcher);
    assert.equal(calls[1]!.length, 1, 'only the question: the passages were remembered');
  });

  it('lets an extra page in only when it is clearly close in meaning', async () => {
    const index = new WikiIndex(':memory:');
    index.putPage('Gamma page', 1, [chunk('Introduction', 'gamma gamma means the thing about beta')]);
    index.putPage('Alpha extra', 2, [chunk('Introduction', 'alpha alpha mentions beta in passing')]);
    const { fetcher } = fakeOllama();
    const out = await rerankPassages(index, 'what about beta', [passage('Beta page', 'beta beta')], 3, fetcher);
    const titles = out!.map((p) => p.title);
    assert.ok(titles.includes('Beta page'));
    assert.ok(!titles.includes('Alpha extra'), 'mentions the word but is about something else');
  });

  it('returns null and pauses itself when the embedding model fails, so questions are not slowed', async () => {
    const index = new WikiIndex(':memory:');
    const broken = fakeOllama({ fail: true });
    const results = [passage('A', 'alpha'), passage('B', 'beta')];
    assert.equal(await rerankPassages(index, 'beta', results, 2, broken.fetcher), null);
    assert.equal(embedStatus().pausedForMs > 0, true);
    assert.equal(await rerankPassages(index, 'beta', results, 2, broken.fetcher), null);
    assert.equal(broken.calls.length, 1, 'not asked again while paused');
  });

  it('has a cosine similarity that ignores length', () => {
    assert.ok(Math.abs(cosine([1, 0], [5, 0]) - 1) < 1e-9);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([0, 0], [1, 1]), 0);
  });
});

describe('which results the full-text order still protects', () => {
  it('knows when a page title is named in the question', async () => {
    const { named } = await import('../src/wiki/embed.js');
    assert.equal(named('Endo', 'where do I get more endo'), true);
    assert.equal(named('Archon Shard', 'how do archon shards work'), true);
    assert.equal(named('Komorex', 'how do i level up my weapons'), false);
    assert.equal(named('Mods 1.0', 'which mods are best'), true, 'digits are ignored');
  });

  it('lets a clearly closer passage beat a loose full-text match, but not a page named in the question', async () => {
    const index = new WikiIndex(':memory:');
    bindEmbedder({ LOCAL_AI_URL: 'http://ollama:11434/v1', EMBED_MODEL: 'tiny-embed' });
    const { fetcher } = fakeOllama();
    // "alpha" is what the question is about: the first full-text result is about gamma only.
    const loose = await rerankPassages(index, 'tell me about alpha', [passage('Gamma page', 'gamma gamma'), passage('Alpha page', 'alpha alpha alpha')], 2, fetcher);
    assert.deepEqual(loose?.map((p) => p.title), ['Alpha page', 'Gamma page']);
    const keepsNamed = await rerankPassages(index, 'tell me about gamma', [passage('Gamma', 'gamma gamma'), passage('Alpha page', 'alpha alpha alpha')], 2, fetcher);
    assert.equal(keepsNamed?.[0]?.title, 'Gamma');
  });
});
