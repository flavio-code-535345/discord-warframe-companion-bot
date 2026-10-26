import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ollamaBase, registerOllamaTools } from '../src/mcp/ollama.js';

const json = (data: unknown) => new Response(JSON.stringify(data));

/** Calls a registered tool's handler directly. */
function setup(url: string | undefined, fetcher: typeof fetch) {
  const server = new McpServer({ name: 't', version: '1' });
  registerOllamaTools(server, { config: { LOCAL_AI_URL: url, LOCAL_AI_MODEL: 'gemma', LOCAL_AI_TIMEOUT_SECONDS: 5 } } as never, fetcher);
  const tools = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools;
  return tools;
}

test('derives the native API base from the OpenAI-style URL', () => {
  assert.equal(ollamaBase('http://100.64.0.1:11434/v1/'), 'http://100.64.0.1:11434');
  assert.equal(ollamaBase('http://ollama:11434'), 'http://ollama:11434');
});

test('registers nothing without LOCAL_AI_URL', () => {
  assert.deepEqual(Object.keys(setup(undefined, fetch)), []);
});

test('ollama_status reports models, what is loaded and whether the bot model is installed', async () => {
  const tools = setup('http://h:11434/v1', async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/version') return json({ version: '0.9.0' });
    if (path === '/api/tags') return json({ models: [{ name: 'gemma:latest', size: 16e9, details: { parameter_size: '26B', quantization_level: 'Q4_K_M' } }] });
    return json({ models: [{ name: 'gemma:latest', size: 18e9 }] });
  });
  const out = JSON.parse((await tools.ollama_status!.handler({})).content[0]!.text);
  assert.equal(out.version, '0.9.0');
  assert.equal(out.botModelInstalled, true);
  assert.equal(out.installed[0].parameters, '26B');
  assert.equal(out.loaded[0].memory, '18.0 GB');
});

test('an unreachable Ollama is explained, not thrown', async () => {
  const tools = setup('http://h:11434/v1', async () => {
    throw new Error('ECONNREFUSED');
  });
  const out = await tools.ollama_status!.handler({});
  assert.equal(out.isError, true);
  assert.match(out.content[0]!.text, /not reachable.*ECONNREFUSED/);
});

test('ollama_test times one answer', async () => {
  const tools = setup('http://h:11434/v1', async (url) => {
    assert.equal(String(url), 'http://h:11434/v1/chat/completions');
    return json({ choices: [{ message: { content: ' Hello. ' } }], usage: { completion_tokens: 4 } });
  });
  const out = JSON.parse((await tools.ollama_test!.handler({ prompt: 'hi' })).content[0]!.text);
  assert.equal(out.answer, 'Hello.');
  assert.equal(out.model, 'gemma');
});
