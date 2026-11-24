// The desktop app's saved sign-in (desktop/saved-login.cjs, #1754): kept encrypted by Windows (safeStorage) in the
// Windows account's own %APPDATA%, handed only to Citadel's own top page, dropped only when asked.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const { savedLogin, fromCitadel } = createRequire(import.meta.url)('../desktop/saved-login.cjs');

/** A stand-in for Electron's safeStorage: reversible, and plainly not the clear text. */
const box = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a),
  decryptString: (b: Buffer) => Buffer.from(b).map((x) => x ^ 0x5a).toString('utf8'),
});
const made: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'saved-login-')); made.push(d); return d; };
// timing-ok: own temp dir
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test('a saved sign-in comes back, and the file on disk holds no clear password', () => {
  const d = dir();
  const s = savedLogin(d, box());
  assert.equal(s.get(), null);
  assert.equal(s.save('cara', 'hunter2-long-password'), true);
  assert.deepEqual(savedLogin(d, box()).get(), { login: 'cara', password: 'hunter2-long-password' });
  assert.ok(!readFileSync(join(d, 'saved-login.bin')).toString('utf8').includes('hunter2'));
});

test('forget deletes it; signing in again without saving leaves nothing to fill', () => {
  const d = dir();
  const s = savedLogin(d, box());
  s.save('cara', 'pw-1234567890');
  s.forget();
  assert.equal(existsSync(join(d, 'saved-login.bin')), false);
  assert.equal(s.get(), null);
  s.forget(); // forgetting twice is fine
});

test('no Windows encryption: nothing is saved, never in the clear', () => {
  const d = dir();
  const s = savedLogin(d, box(false));
  assert.equal(s.available(), false);
  assert.equal(s.save('cara', 'pw-1234567890'), false);
  assert.equal(existsSync(join(d, 'saved-login.bin')), false);
});

test('a file another account wrote, or a damaged one, reads as nothing saved', () => {
  const d = dir();
  savedLogin(d, box()).save('cara', 'pw-1234567890');
  const other = { ...box(), decryptString: () => { throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.'); } };
  assert.equal(savedLogin(d, other).get(), null);
});

test('bad input is refused rather than saved', () => {
  const s = savedLogin(dir(), box());
  assert.equal(s.save('', 'pw-1234567890'), false);
  assert.equal(s.save('cara', ''), false);
  assert.equal(s.save('cara', 42), false);
  assert.equal(s.save('cara', 'x'.repeat(1001)), false);
});

test('only Citadel\'s own top page may ask, never an app\'s frame or another site', () => {
  const start = new URL('https://citadel.zip/c/');
  const main = { url: 'https://citadel.zip/c/#/', parent: null };
  assert.equal(fromCitadel(main, start), true);
  assert.equal(fromCitadel({ url: 'https://citadel.zip/c/', parent: main }, start), false); // a frame inside the page
  assert.equal(fromCitadel({ url: 'https://citadel.zip/apps/mandate/', parent: null }, start), false);
  assert.equal(fromCitadel({ url: 'https://mandate.citadel.zip/apps/mandate/', parent: null }, start), false);
  assert.equal(fromCitadel({ url: 'https://evil.example/c/', parent: null }, start), false);
  assert.equal(fromCitadel(null, start), false);
});
