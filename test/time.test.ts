import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discordTime, formatDuration, parseWhen, relative } from '../src/time.js';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

test('parseWhen reads relative offsets', () => {
  assert.equal(parseWhen('2h', NOW), NOW + 2 * 3_600_000);
  assert.equal(parseWhen('in 1d 4h30m', NOW), NOW + 86_400_000 + 4 * 3_600_000 + 30 * 60_000);
  assert.equal(parseWhen('1w', NOW), NOW + 604_800_000);
});

test('parseWhen treats zone-less date/times as UTC', () => {
  assert.equal(parseWhen('2026-11-02 20:00', NOW), Date.UTC(2026, 10, 2, 20, 0));
  assert.equal(parseWhen('2026-11-02T8:05', NOW), Date.UTC(2026, 10, 2, 8, 5));
});

test('parseWhen accepts ISO with zone and unix seconds', () => {
  assert.equal(parseWhen('2026-11-02T20:00:00+02:00', NOW), Date.UTC(2026, 10, 2, 18, 0));
  assert.equal(parseWhen('1793000000', NOW), 1_793_000_000_000);
});

test('parseWhen rejects garbage', () => {
  assert.equal(parseWhen('', NOW), null);
  assert.equal(parseWhen('tomorrowish', NOW), null);
  assert.equal(parseWhen('0m', NOW), null);
});

test('formatDuration and relative', () => {
  assert.equal(formatDuration(3 * 86_400_000 + 4 * 3_600_000 + 59_000), '3d 4h');
  assert.equal(formatDuration(2 * 3_600_000 + 5 * 60_000), '2h 5m');
  assert.equal(formatDuration(10_000), '1m');
  assert.equal(relative(NOW + 45 * 60_000, NOW), 'in 45m');
  assert.equal(relative(NOW - 3_600_000, NOW), '1h ago');
  assert.equal(relative(undefined, NOW), 'unknown');
});

test('discordTime renders timestamp markup and tolerates missing dates', () => {
  assert.equal(discordTime(NOW, 'F'), `<t:${NOW / 1000}:F>`);
  assert.equal(discordTime(undefined), 'unknown');
});
