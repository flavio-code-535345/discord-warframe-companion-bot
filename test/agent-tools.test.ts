import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculate, clockInfo } from '../src/agent/calc.js';
import { AGENT_TOOLS } from '../src/agent/tools.js';
import { assertPublicUrl, htmlToText, isPrivateAddress, readWebPage } from '../src/warframe/webpage.js';
import { webSearch } from '../src/warframe/websearch.js';

const publicDns = async () => ['93.184.216.34'];

describe('calculate', () => {
  it('does arithmetic with the usual precedence', () => {
    assert.equal(calculate('2 + 3 * 4'), 14);
    assert.equal(calculate('(2 + 3) * 4'), 20);
    assert.equal(calculate('2 ^ 3 ^ 2'), 512);
    assert.equal(calculate('-3 + 5'), 2);
    assert.equal(calculate('10 % 3'), 1);
    assert.equal(calculate('50%'), 0.5);
    assert.equal(calculate('20 x 3'), 60);
    assert.equal(calculate('max(2, 9, 4) + sqrt(16)'), 13);
    assert.ok(Math.abs(calculate('(1 - 0.9^10) * 100') - 65.13215599) < 1e-6);
  });

  it('rejects anything that is not plain maths', () => {
    for (const bad of ['', '2 +', '1 / 0', 'process.exit()', 'require("fs")', 'foo(1)', 'x', '(((', '1'.repeat(300)]) assert.throws(() => calculate(bad), /./, bad);
  });
});

describe('get_time', () => {
  it('knows the resets in UTC', () => {
    const t = clockInfo(new Date('2026-10-28T22:30:00Z')); // a Wednesday
    assert.equal(t.weekdayUtc, 'Wednesday');
    assert.equal(t.nextDailyReset, '2026-10-29T00:00:00.000Z');
    assert.equal(t.inUntilDailyReset, '1h 30m');
    assert.equal(t.nextWeeklyReset, '2026-11-02T00:00:00.000Z');
    assert.equal(clockInfo(new Date('2026-11-01T12:00:00Z')).nextWeeklyReset, '2026-11-02T00:00:00.000Z'); // a Sunday
  });
});

describe('open web search', () => {
  const reply = (results: object[]) => async () => new Response(JSON.stringify({ results }));
  const hits = [
    { title: 'Guide', url: 'https://www.youtube.com/watch?v=1', content: 'A video guide.' },
    { title: 'Script', url: 'javascript:alert(1)', content: 'x' },
    { title: 'Blog', url: 'https://someblog.example/post', content: 'Opinion.' },
  ];

  it('keeps any http(s) site when open, but only Warframe hosts otherwise', async () => {
    assert.deepEqual((await webSearch('http://s', 'q', 5, reply(hits), { open: true })).map((r) => r.title), ['Guide', 'Blog']);
    assert.deepEqual(await webSearch('http://s', 'q', 5, reply(hits)), []);
  });

  it('adds "warframe" to the query only in the Warframe-only mode', async () => {
    const asked: string[] = [];
    const spy = async (u: string | URL | Request) => (asked.push(new URL(String(u)).searchParams.get('q') ?? ''), new Response('{}'));
    await webSearch('http://s', 'cats', 3, spy, { open: true });
    await webSearch('http://s', 'cats', 3, spy);
    assert.deepEqual(asked, ['cats', 'warframe cats']);
  });
});

describe('reading web pages', () => {
  it('refuses addresses on the private network', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.178.45', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
    for (const bad of ['http://localhost/', 'http://192.168.178.45:11434/api/tags', 'http://[::1]/', 'http://printer/', 'http://nas.local/', 'ftp://example.com/', 'file:///etc/passwd', 'https://user:pw@example.com/', 'not a url'])
      await assert.rejects(assertPublicUrl(bad, publicDns), /./, bad);
    await assert.rejects(assertPublicUrl('https://sneaky.example/', async () => ['93.184.216.34', '10.0.0.5']), /public internet/);
    assert.equal((await assertPublicUrl('https://example.com/a', publicDns)).hostname, 'example.com');
  });

  it('turns HTML into text', () => {
    const { title, text } = htmlToText('<html><head><title>Hello &amp; welcome</title><style>p{}</style></head><body><nav>menu</nav><script>evil()</script><h1>Endo</h1><p>Drops from <b>enemies</b> &lt;15&gt;.</p></body></html>');
    assert.equal(title, 'Hello & welcome');
    assert.equal(text, 'Endo\nDrops from enemies <15>.');
  });

  it('follows a redirect only to a public address, and stops on a private one', async () => {
    const page = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
    const ok = await readWebPage('https://a.example/start', {
      resolve: publicDns,
      fetcher: (async (u: URL) => (u.pathname === '/start' ? new Response(null, { status: 302, headers: { location: '/end' } }) : page('<p>Arrived</p>'))) as typeof fetch,
    });
    assert.equal(ok.url, 'https://a.example/end');
    assert.equal(ok.text, 'Arrived');
    await assert.rejects(
      readWebPage('https://a.example/start', { resolve: publicDns, fetcher: (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })) as typeof fetch }),
      /public internet/,
    );
  });

  it('refuses binary pages and cuts long ones', async () => {
    await assert.rejects(readWebPage('https://a.example/x', { resolve: publicDns, fetcher: (async () => new Response('PK', { headers: { 'content-type': 'application/zip' } })) as typeof fetch }), /not a text page/);
    const long = await readWebPage('https://a.example/x', { resolve: publicDns, chars: 50, fetcher: (async () => new Response('word '.repeat(100), { headers: { 'content-type': 'text/plain' } })) as typeof fetch });
    assert.equal(long.text.length, 50);
    assert.ok(long.cut);
  });
});

describe('agent tool registry', () => {
  it('has the new tools with unique names and object schemas', () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const n of ['read_web_page', 'calculate', 'get_time', 'grade_riven', 'riven_top_rolls']) assert.ok(names.includes(n), n);
    for (const t of AGENT_TOOLS) assert.equal(t.parameters.type, 'object', t.name);
  });

  it('calculate and get_time run through the registry', async () => {
    const run = (name: string, args: Record<string, unknown>) => AGENT_TOOLS.find((t) => t.name === name)!.run(args, {} as never);
    assert.deepEqual(await run('calculate', { expression: '3 * 7' }), { expression: '3 * 7', result: 21 });
    assert.ok('nextDailyReset' in ((await run('get_time', {})) as object));
  });
});
