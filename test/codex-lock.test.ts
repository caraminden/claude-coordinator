// The person's Codex lock (src/codex-lock.ts): a short login check that refreshes early, then lets runs go side by side (#636).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { codexLock, LOCK_ENV, MARGIN_S, SERIAL_FILE, startTime, tokenLife } from '../src/codex-lock.ts';
import { holds } from './helpers.ts';
import { until } from './wait.ts';

const root = mkdtempSync(join(tmpdir(), 'codex-lock-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86400;

const jwt = (iat: number, exp: number) => `x.${Buffer.from(JSON.stringify({ iat, exp })).toString('base64url')}.x`;
/** A CODEX_HOME whose made-up login's access token lives `life` seconds and has `left` of them left. */
function home(left?: number, life = 10 * DAY): string {
  const dir = mkdtempSync(join(root, 'home-'));
  const now = Math.floor(Date.now() / 1000);
  if (left !== undefined) writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(now + left - life, now + left), refresh_token: 'rt-0' } }));
  return dir;
}

// Stands in for `codex app-server`: on account/read with refreshToken it takes FAKE_MS, then writes a login
// with a new 10-day token (unless FAKE=fail), logging each refresh's start and end.
const fake = join(root, 'fake-codex.mjs');
writeFileSync(
  fake,
  `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CODEX_HOME;
const jwt = (iat, exp) => 'x.' + Buffer.from(JSON.stringify({ iat, exp })).toString('base64url') + '.x';
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: {} }));
    if (m.method === 'account/read' && m.params.refreshToken) {
      appendFileSync(join(home, 'refreshes'), 'start\\n');
      setTimeout(() => {
        const now = Math.floor(Date.now() / 1000);
        if (process.env.FAKE !== 'fail') writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(now, now + 864000), refresh_token: 'rt-1' } }));
        appendFileSync(join(home, 'refreshes'), 'end\\n');
        console.log(JSON.stringify({ id: m.id, result: {} }));
      }, Number(process.env.FAKE_MS || 0));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`,
  { mode: 0o755 },
);
const refreshes = (dir: string) => (existsSync(join(dir, 'refreshes')) ? readFileSync(join(dir, 'refreshes'), 'utf8').trim().split('\n') : []);
const opts = (dir: string, extra: Record<string, string> = {}) => ({ bin: fake, env: { PATH: process.env.PATH, CODEX_HOME: dir, ...extra } });
const locked = (dir: string) => existsSync(join(dir, 'citadel-turn.lock'));

test('tokenLife reads only the two times, and says when there is no token or it cannot be read', () => {
  const life = tokenLife(home(3 * DAY)) as { left: number; life: number };
  assert.ok(Math.abs(life.left - 3 * DAY) < 5 && life.life === 10 * DAY);
  assert.equal(tokenLife(home()), 'none', 'not signed in');
  const key = home();
  writeFileSync(join(key, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'k', tokens: null }));
  assert.equal(tokenLife(key), 'none', 'an API key refreshes nothing');
  const odd = home();
  writeFileSync(join(odd, 'auth.json'), JSON.stringify({ tokens: { access_token: 'not-a-jwt' } }));
  assert.equal(tokenLife(odd), 'unknown');
  writeFileSync(join(odd, 'auth.json'), '{');
  assert.equal(tokenLife(odd), 'unknown');
});

test('with plenty of life in the token, runs go side by side and nothing refreshes', async () => {
  const dir = home(9 * DAY);
  const a = await codexLock(dir, () => {}, opts(dir));
  assert.deepEqual([a.serial, a.refreshed, locked(dir)], [false, false, false], 'the first run holds nothing while it runs');
  let reads = 0; // the lock reads its clock once to start and once at the end; each wait round reads it again
  const b = await codexLock(dir, () => assert.fail('the second run waited'), { ...opts(dir), now: () => (reads++, 0) });
  assert.equal(b.serial, false);
  assert.equal(reads, 2, 'the second run did not wait');
  assert.deepEqual(refreshes(dir), []);
  a.unlock(), b.unlock();
});

test('a token inside the margin is refreshed under the lock: three runs at once make one refresh', async () => {
  const dir = home(MARGIN_S - 60);
  const runs = await Promise.all([1, 2, 3].map(() => codexLock(dir, () => {}, opts(dir, { FAKE_MS: '300' }))));
  assert.deepEqual(refreshes(dir), ['start', 'end'], 'one refresh, the others saw the new token');
  assert.equal(runs.filter((r) => r.refreshed).length, 1);
  assert.ok(runs.every((r) => !r.serial));
  assert.equal(locked(dir), false);
  assert.ok((tokenLife(dir) as { left: number }).left > 9 * DAY);
});

test('a refresh is over before the lock is let go', async () => {
  const dir = home(600);
  const first = codexLock(dir, () => {}, opts(dir, { FAKE_MS: '500' }));
  await until('a token refresh', async () => refreshes(dir).length);
  assert.deepEqual(refreshes(dir), ['start']);
  assert.ok(locked(dir), 'held while it refreshes');
  await first;
  assert.deepEqual(refreshes(dir), ['start', 'end']);
});

test('a run stays serial when the refresh fails, the token is short-lived or it cannot be read', async () => {
  const failed = home(600);
  const a = await codexLock(failed, () => {}, opts(failed, { FAKE: 'fail' }));
  assert.deepEqual([a.serial, a.refreshed, locked(failed)], [true, false, true], 'a stale token nobody could refresh');
  let waited = false;
  let t = 0; // its clock moves by hand: the note is due once noteMs have passed on it
  const b = codexLock(failed, () => (waited = true), { ...opts(failed, { FAKE: 'fail' }), noteMs: 100, now: () => t });
  assert.equal(waited, false, 'not before noteMs');
  t = 100;
  await until('the next run to say it waits', async () => waited);
  assert.ok(waited, 'the next run waits for it, and says so');
  a.unlock();
  (await b).unlock();
  assert.equal(locked(failed), false);

  const short = home(3000, 3600); // an hour's token, fresh: no refresh, but a long run would meet Codex's own
  const c = await codexLock(short, () => {}, opts(short));
  assert.deepEqual([c.serial, refreshes(short).length], [true, 0]);
  c.unlock();

  const odd = home();
  writeFileSync(join(odd, 'auth.json'), JSON.stringify({ tokens: { access_token: 'not-a-jwt' } }));
  const d = await codexLock(odd, () => {}, opts(odd));
  assert.deepEqual([d.serial, refreshes(odd).length], [true, 0]);
  d.unlock();
});

test('the switch brings back one at a time: the file in CODEX_HOME or CITADEL_CODEX_SERIAL=1', async () => {
  const dir = home(9 * DAY);
  writeFileSync(join(dir, SERIAL_FILE), '');
  const a = await codexLock(dir, () => {}, opts(dir));
  assert.deepEqual([a.serial, locked(dir)], [true, true]);
  // A review from that turn's own shell goes ahead and leaves the lock to the turn (#468 S04-6); a turn never does.
  const own = { [LOCK_ENV]: `${process.pid} ${startTime(process.pid)}` };
  const review = await codexLock(dir, () => assert.fail('waited on its own turn'), { ...opts(dir, own), inTurn: true });
  review.unlock();
  assert.ok(locked(dir), "its turn's lock stays");
  let turn: unknown = null;
  const second = codexLock(dir, () => {}, opts(dir, own)).then((l) => (turn = l));
  await holds('a turn with the same name in its environment still waits', () => turn === null, { ms: 500 });
  assert.equal(turn, null, 'a turn with the same name in its environment still waits');
  a.unlock();
  (await second).unlock();
  a.unlock();
  assert.equal(locked(dir), false);
  rmSync(join(dir, SERIAL_FILE));
  const b = await codexLock(dir, () => {}, opts(dir, { CITADEL_CODEX_SERIAL: '1' }));
  assert.equal(b.serial, true);
  b.unlock();
});

test('a short wait says nothing; a wait past noteMs says so once', async () => {
  const dir = home(9 * DAY);
  mkdirSync(join(dir, 'citadel-turn.lock'));
  writeFileSync(join(dir, 'citadel-turn.lock', 'pid'), `${process.pid} ${startTime(process.pid)}`);
  setTimeout(() => rmSync(join(dir, 'citadel-turn.lock'), { recursive: true }), 300);
  const quick = await codexLock(dir, () => assert.fail('said it waits'), { ...opts(dir), noteMs: 5000 });
  assert.ok(quick.waitedMs >= 250, `waited ${quick.waitedMs} ms`);
  mkdirSync(join(dir, 'citadel-turn.lock'));
  writeFileSync(join(dir, 'citadel-turn.lock', 'pid'), `${process.pid} ${startTime(process.pid)}`);
  setTimeout(() => rmSync(join(dir, 'citadel-turn.lock'), { recursive: true }), 1500);
  let said = 0;
  await codexLock(dir, () => said++, { ...opts(dir), noteMs: 200 });
  assert.equal(said, 1);
});

test("a holder that died while refreshing keeps its lock until its codex is done: the next run doesn't refresh beside it", async () => {
  const dir = home(600);
  const lock = join(dir, 'citadel-turn.lock');
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), '999999999 1'); // nobody: a stopped turn
  writeFileSync(join(lock, 'refreshing'), '');
  let next: unknown = null;
  const run = codexLock(dir, () => {}, opts(dir)).then((l) => (next = l));
  await holds('it waits, and starts no refresh of its own', () => next === null && refreshes(dir).length === 0, { ms: 700 });
  assert.equal(next, null, 'it waits');
  assert.deepEqual(refreshes(dir), [], 'and starts no refresh of its own');
  // Without the mark (a holder that died doing anything else) the lock is taken over at once.
  rmSync(join(lock, 'refreshing'));
  await run;
  assert.deepEqual(refreshes(dir), ['start', 'end']);
  assert.equal(locked(dir), false);
});
