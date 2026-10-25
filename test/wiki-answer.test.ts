import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFrom } from '../src/wiki/answer.js';

const page = (title: string, extract: string) => ({ title, url: `https://wiki.warframe.com/w/${title}`, extract });

test('answers a "how many" question with the sentence that has the number', () => {
  const a = answerFrom('how many shard slots does a warframe have', [
    page('Archon Shard', 'Archon Shards are crystals dropped by Archon bosses. Each Warframe has 5 available Shard slots. They can be fused for stronger effects.'),
  ]);
  assert.match(a!.text, /5 available Shard slots/);
  assert.doesNotMatch(a!.text, /crystals dropped/);
});

test('answers "what is" with the opening definition', () => {
  const a = answerFrom('what is a kuva lich', [
    page('Kuva Lich', 'Kuva Liches are Grineer Adversaries infused with Kuva. Weapons can be obtained from them in various ways over time.'),
  ]);
  assert.match(a!.text, /^Kuva Liches are Grineer Adversaries/);
});

test('gives no direct answer when nothing in the passages matches', () => {
  assert.equal(answerFrom('how tall is the moon', [page('Lotus', 'The Lotus guides the Tenno through the origin system.')]), null);
});
