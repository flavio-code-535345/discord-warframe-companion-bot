import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reportStatus, toolStatus, withStatus } from '../src/answers/status.js';
import { type Notice, renderNotice, startProgress } from '../src/discord/progress.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeNotice(failEdit = false) {
  const log: string[] = [];
  const notice: Notice = {
    edit: async (p) => {
      if (failEdit && !String(p.content).startsWith('🧠')) throw new Error('gone');
      log.push(`edit:${p.content}`);
    },
    delete: async () => void log.push('delete'),
  };
  return { log, notice, post: async (t: string) => (log.push(`post:${t}`), notice) };
}

describe('thinking notice', () => {
  it('shows a bar that fills over about a minute, the time spent and the current step', () => {
    assert.match(renderNotice(0, ''), /thinking…\*\* this can take up to a minute\.\n`▱{10}` 0 s\n-# Please don't send the question again\./);
    assert.match(renderNotice(30_000, '🔎 Searching the wiki'), /`▰{5}▱{5}` 30 s · 🔎 Searching the wiki/);
    assert.match(renderNotice(95_000, ''), /`▰{10}` 95 s/);
  });

  it('never appears for a quick answer', async () => {
    const f = fakeNotice();
    const p = startProgress(f.post, { delayMs: 60, everyMs: 20 });
    await sleep(10);
    await p.discard();
    await sleep(80);
    assert.deepEqual(f.log, []);
  });

  it('appears for a slow one, keeps updating with the status, and is removed when the answer is ready', async () => {
    const f = fakeNotice();
    const p = startProgress(f.post, { delayMs: 20, everyMs: 25 });
    p.set('🔧 Using something');
    await sleep(90);
    p.set('✍️ Writing the answer');
    await sleep(60);
    await p.discard();
    const after = f.log.length;
    await sleep(60);
    assert.equal(f.log.length, after, 'no more updates once discarded');
    assert.match(f.log[0]!, /^post:🧠 \*\*Ordis is thinking/);
    assert.match(f.log[0]!, /Using something/);
    assert.ok(f.log.filter((l) => l.startsWith('edit:')).length >= 2);
    assert.match(f.log.filter((l) => l.startsWith('edit:')).at(-1)!, /Writing the answer/);
    assert.equal(f.log.at(-1), 'delete');
  });

  it('can turn the notice into the answer (slash commands), or report that there was none', async () => {
    const f = fakeNotice();
    const p = startProgress(f.post, { delayMs: 10, everyMs: 1000 });
    await sleep(40);
    assert.equal(await p.finish({ content: 'The answer.' }), true);
    assert.equal(f.log.at(-1), 'edit:The answer.');

    const quick = startProgress(fakeNotice().post, { delayMs: 500 });
    assert.equal(await quick.finish({ content: 'x' }), false, 'nothing to edit: the caller sends it');

    const broken = fakeNotice(true);
    const b = startProgress(broken.post, { delayMs: 10, everyMs: 1000 });
    await sleep(40);
    assert.equal(await b.finish({ content: 'The answer.' }), false);
    assert.equal(broken.log.at(-1), 'delete', 'a notice that cannot be edited is removed');
  });

  it('a failing Discord call never stops the answer', async () => {
    const p = startProgress(async () => {
      throw new Error('missing permissions');
    }, { delayMs: 10 });
    await sleep(40);
    await p.discard();
  });
});

describe('answer status', () => {
  it('reaches only the listener of the answer that is running', async () => {
    const seen: string[] = [];
    reportStatus('outside: ignored');
    await withStatus((s) => seen.push(s), async () => {
      reportStatus('a');
      await sleep(5);
      reportStatus('b');
    });
    await withStatus(undefined, async () => reportStatus('no listener'));
    await Promise.all([
      withStatus((s) => seen.push(`1${s}`), async () => (await sleep(10), reportStatus('x'))),
      withStatus((s) => seen.push(`2${s}`), async () => (await sleep(5), reportStatus('y'))),
    ]);
    assert.deepEqual(seen, ['a', 'b', '2y', '1x']);
    await withStatus(() => {
      throw new Error('broken listener');
    }, async () => reportStatus('fine'));
  });

  it('describes tools in plain words', () => {
    assert.equal(toolStatus('search_wiki'), '🔎 Searching the wiki');
    assert.equal(toolStatus('search_web'), '🌐 Searching the web');
    assert.match(toolStatus('mystery'), /Using mystery/);
  });
});
