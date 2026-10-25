import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS } from '../src/discord/bot.js';

// discord.js validates names and descriptions while the builders run, so importing COMMANDS already fails on
// an over-long description. This also walks the JSON, so limits the builders don't check can't slip through.
type Option = { name: string; description?: string; options?: Option[]; choices?: { name: string; value: unknown }[] };

function check(path: string, o: Option): void {
  assert.ok(o.name.length >= 1 && o.name.length <= 32, `${path}: name length`);
  if (o.description !== undefined) assert.ok(o.description.length >= 1 && o.description.length <= 100, `${path}: description is ${o.description.length} characters`);
  for (const c of o.choices ?? []) assert.ok(c.name.length <= 100, `${path}: choice "${c.name}" is too long`);
  for (const sub of o.options ?? []) check(`${path} ${sub.name}`, sub);
}

test('every slash command fits Discord limits', () => {
  assert.ok(COMMANDS.length > 20);
  const names = COMMANDS.map((c) => c.data.name);
  assert.equal(new Set(names).size, names.length, 'command names are unique');
  assert.ok(COMMANDS.length <= 100, 'at most 100 guild commands');
  for (const c of COMMANDS) check(`/${c.data.name}`, c.data as unknown as Option);
});
