import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCookies } from '../src/web/admin/auth.js';

test('parseCookies decodes values and survives a malformed escape', () => {
  assert.deepEqual(parseCookies('a=1; b=x%20y'), { a: '1', b: 'x y' });
  assert.deepEqual(parseCookies('bad=%E0%A4%A; ok=fine'), { bad: '%E0%A4%A', ok: 'fine' });
  assert.deepEqual(parseCookies(undefined), {});
});
