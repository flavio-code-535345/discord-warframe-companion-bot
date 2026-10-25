import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { PermissionFlagsBits, type GuildMember, type Role } from 'discord.js';
import { assertSafeVerifyRole } from '../src/discord/verification.js';
import { CHALLENGE_TTL_MS, COOLDOWN_MS, MAX_ATTEMPTS, VerificationAttempts } from '../src/verification/attempts.js';
import { CAPTCHA_CHARS, CODE_LENGTH, GLYPHS, HEIGHT, WIDTH, randomCode, renderCaptcha } from '../src/verification/captcha.js';

test('every captcha character has a 5x7 glyph and codes only use those characters', () => {
  for (const ch of CAPTCHA_CHARS) {
    assert.equal(GLYPHS[ch]?.length, 7, ch);
    assert.ok(GLYPHS[ch]!.every((row) => row.length === 5), ch);
  }
  for (let i = 0; i < 50; i++) {
    const code = randomCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.ok([...code].every((c) => CAPTCHA_CHARS.includes(c)));
  }
});

test('renderCaptcha produces a valid RGB PNG of the expected size', () => {
  const png = renderCaptcha('ACK47X');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), WIDTH);
  assert.equal(png.readUInt32BE(20), HEIGHT);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, (WIDTH * 3 + 1) * HEIGHT);
});

test('attempts: right code passes, wrong codes count across new pictures, then a cooldown', () => {
  let n = 0;
  const attempts = new VerificationAttempts(() => (n++ % 7) / 7);
  const t = 1_000_000;
  const first = attempts.start('u', t);
  assert.ok(first.ok);
  assert.equal(first.attemptsLeft, MAX_ATTEMPTS);
  assert.deepEqual(attempts.check('u', first.code.toLowerCase().split('').join(' '), t), { result: 'ok' });

  const a = attempts.start('u', t);
  assert.ok(a.ok);
  assert.deepEqual(attempts.check('u', 'WRONG1', t), { result: 'wrong', attemptsLeft: 2 });
  const b = attempts.start('u', t); // a new picture keeps the count
  assert.ok(b.ok && b.attemptsLeft === 2);
  assert.deepEqual(attempts.check('u', 'WRONG2', t), { result: 'wrong', attemptsLeft: 1 });
  attempts.start('u', t);
  assert.deepEqual(attempts.check('u', 'WRONG3', t), { result: 'locked', cooldownMs: COOLDOWN_MS });
  const locked = attempts.start('u', t + 1000);
  assert.ok(!locked.ok && locked.cooldownMs === COOLDOWN_MS - 1000);

  const after = attempts.start('u', t + COOLDOWN_MS + 1);
  assert.ok(after.ok && after.attemptsLeft === MAX_ATTEMPTS);
  assert.deepEqual(attempts.check('u', after.code, t + COOLDOWN_MS + 2 + CHALLENGE_TTL_MS), { result: 'expired' });
  assert.deepEqual(attempts.check('nobody', 'X', t), { result: 'expired' });
});

test('verification refuses roles that would hand strangers power', () => {
  const me = { roles: { highest: { position: 10 } } } as unknown as GuildMember;
  const role = (opts: { id?: string; position?: number; managed?: boolean; perms?: bigint[] }) =>
    ({
      id: opts.id ?? 'r',
      guild: { id: 'g' },
      name: 'Role',
      position: opts.position ?? 1,
      managed: opts.managed ?? false,
      permissions: { any: (list: bigint[]) => list.some((p) => (opts.perms ?? []).includes(p)) },
    }) as unknown as Role;
  assert.doesNotThrow(() => assertSafeVerifyRole(role({}), me));
  assert.throws(() => assertSafeVerifyRole(role({ id: 'g' }), me), /@everyone/);
  assert.throws(() => assertSafeVerifyRole(role({ managed: true }), me), /integration/);
  assert.throws(() => assertSafeVerifyRole(role({ position: 10 }), me), /above Ordis/);
  assert.throws(() => assertSafeVerifyRole(role({ perms: [PermissionFlagsBits.BanMembers] }), me), /moderator or admin/);
});
