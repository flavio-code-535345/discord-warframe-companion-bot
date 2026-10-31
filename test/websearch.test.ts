import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedUrl, webSearch, withWarframe } from '../src/warframe/websearch.js';

const reply = (results: object[], status = 200) => async () => new Response(JSON.stringify({ results }), { status });

describe('web search', () => {
  it('keeps only Warframe sources, drops duplicates and empty snippets', async () => {
    const out = await webSearch(
      'http://searx:8080/',
      'hotfix 40',
      5,
      reply([
        { title: 'Hotfix 40.0.5', url: 'https://forums.warframe.com/topic/1', content: 'Fixed a crash.', publishedDate: '2026-10-20T10:00:00' },
        { title: 'Spam', url: 'https://evil.example/warframe', content: 'buy now' },
        { title: 'Dup', url: 'https://forums.warframe.com/topic/1', content: 'again' },
        { title: 'Other sub', url: 'https://www.reddit.com/r/cooking/x', content: 'pasta' },
        { title: 'WF sub', url: 'https://www.reddit.com/r/Warframe/comments/x', content: 'Discussion of the patch.' },
        { title: 'Empty', url: 'https://wiki.warframe.com/w/Empty', content: '   ' },
      ]),
    );
    assert.deepEqual(out.map((r) => r.title), ['Hotfix 40.0.5', 'WF sub']);
  });

  it('sends a json search for warframe and never throws', async () => {
    let url = '';
    await webSearch('http://searx:8080', 'steel path', 3, async (u) => {
      url = String(u);
      return new Response('{}');
    });
    const q = new URL(url);
    assert.equal(q.pathname, '/search');
    assert.equal(q.searchParams.get('format'), 'json');
    assert.equal(q.searchParams.get('q'), 'warframe steel path');
    assert.deepEqual(await webSearch('http://searx:8080', 'q', 3, reply([], 403)), []);
    assert.deepEqual(await webSearch('http://searx:8080', 'q', 3, async () => { throw new Error('down'); }), []);
    assert.deepEqual(await webSearch(undefined, 'q'), []);
  });

  it('checks hosts exactly', () => {
    assert.ok(allowedUrl('https://wiki.warframe.com/w/Steel_Path'));
    assert.ok(allowedUrl('https://www.warframe.com/news'));
    assert.ok(!allowedUrl('https://warframe.com.evil.example/'));
    assert.ok(!allowedUrl('javascript:alert(1)'));
    assert.equal(withWarframe('warframe news'), 'warframe news');
  });
});
