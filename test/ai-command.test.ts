import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeAnswer, resetLocalAi } from '../src/answers/compose.js';
import { currentPull, listInstalled, localModelOf, pullProgress, resetPull, setChosenModel, startPull, validModelTag } from '../src/ai/ollama.js';

const ndjson = (...lines: object[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const l of lines) c.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
        c.close();
      },
    }),
  );

describe('model tags', () => {
  it('accepts library and Hugging Face tags, refuses anything odd', () => {
    assert.ok(validModelTag('gemma3:27b'));
    assert.ok(validModelTag('hf.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M'));
    assert.ok(!validModelTag('a'));
    assert.ok(!validModelTag('bad tag; rm -rf'));
    assert.ok(!validModelTag('../../etc/passwd'));
    assert.ok(!validModelTag('x'.repeat(200)));
  });
});

describe('chosen model', () => {
  it('wins over LOCAL_AI_MODEL, and an empty choice means the default again', () => {
    setChosenModel(null);
    assert.equal(localModelOf({ LOCAL_AI_MODEL: 'big' }), 'big');
    setChosenModel('small');
    assert.equal(localModelOf({ LOCAL_AI_MODEL: 'big' }), 'small');
    assert.equal(localModelOf({}), 'small');
    setChosenModel('');
    assert.equal(localModelOf({ LOCAL_AI_MODEL: 'big' }), 'big');
  });

  it('is what the answer path asks Ollama for', async () => {
    resetLocalAi();
    setChosenModel('small');
    const models: string[] = [];
    const out = await composeAnswer(
      { FREE_AI_URL: 'https://x/v1', FREE_AI_MODEL: 'm', FREE_AI_DAILY_LIMIT: 10, LOCAL_AI_URL: 'http://h:11434/v1', LOCAL_AI_MODEL: 'big' },
      'q',
      [{ title: 'T', url: 'u', extract: 'e' }],
      async (_url, init) => {
        models.push(JSON.parse(String(init.body)).model);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      },
    );
    assert.equal(out, 'ok');
    assert.deepEqual(models, ['small']);
    setChosenModel(null);
    resetLocalAi();
  });
});

describe('download and listing', () => {
  it('tracks the progress of a pull and reports when it is done', async () => {
    resetPull();
    let done = '';
    const state = await startPull(
      'http://h:11434',
      'tag:1',
      async () => ndjson({ status: 'pulling manifest' }, { status: 'pulling abc', total: 1000, completed: 250 }, { status: 'pulling abc', total: 1000, completed: 1000 }, { status: 'success' }),
      (s) => {
        done = s.status;
      },
    );
    assert.equal(state.status, 'success');
    assert.equal(done, 'success');
    assert.equal(pullProgress(currentPull()!), '100% (0.0 GB of 0.0 GB)');
  });

  it('records a failed pull', async () => {
    resetPull();
    const state = await startPull('http://h:11434', 'nope', async () => ndjson({ error: 'pull model manifest: file does not exist' }));
    assert.equal(state.status, 'failed');
    assert.match(state.error!, /file does not exist/);
  });

  it('lists installed models with their details', async () => {
    const out = await listInstalled('http://h:11434', async () => new Response(JSON.stringify({ models: [{ name: 'a:1', size: 5e9, details: { parameter_size: '4B', quantization_level: 'Q4_K_M' } }] })));
    assert.deepEqual(out, [{ name: 'a:1', size: 5e9, parameters: '4B', quantization: 'Q4_K_M' }]);
  });
});
