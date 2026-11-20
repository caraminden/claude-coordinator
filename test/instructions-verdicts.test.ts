import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, type Booted } from './helpers.ts';

// #1211 (Josh, 2026-11-20: "Matcher, then a Grunt"): when the matcher finds repeats in a person's Settings save, a
// one-shot Sonnet call on their own Claude login says whether each really repeats or conflicts. "Hold the save until
// linked": no login, no check, and the page says so. "Keep the matcher list": a failed check leaves the list as it is.
const root = mkdtempSync(join(tmpdir(), 'instr-verdicts-'));
const prompts = join(root, 'prompts.log');
const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(prompts)}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
  if (fs.existsSync(${JSON.stringify(join(root, 'fail'))})) { console.error('usage limit reached'); process.exit(1); }
  const result = JSON.stringify({ verdicts: [{ n: 1, verdict: 'repeats', why: 'Same card rule, said again.' }, { n: 7, verdict: 'fine', why: 'not a place' }] });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result }));
});
`);
chmodSync(fakeClaude, 0o755);

let srv: Booted;
let project: any;
let joshCookie = '';
before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  project = (await srv.call('/api/projects', { name: 'P' })).data;
  const made = (await srv.call('/api/people', { name: 'Josh' })).data;
  const inv = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Josh-password-1' }) });
  joshCookie = inv.headers.get('set-cookie')!.split(';')[0];
  await srv.call(`/api/projects/${project.id}/members`, { person: made.person.id });
  // Cara's turns run on the server's (stand-in) login; Josh has none linked.
  const store = new Store(join(srv.data, 'coordinator.db'));
  store.updateUser(store.listUsers().find((u) => u.name === 'Cara')!.id, { server_login: 1 });
});
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true });
});

const REPEAT = 'Hello.\n\nOne card, one choice: ask early and together, with your pick marked.';
const verdicts = async (text: string, cookie = srv.cookie) => {
  const r = await fetch(`${srv.base}/api/projects/${project.id}/instructions/overlaps/verdicts`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'scheme', text }) });
  return { status: r.status, data: await r.json() };
};
const calls = () => { try { return readFileSync(prompts, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test("Sonnet reads the matcher's hits on the saver's own login and gives a verdict for each", async () => {
  const r = await verdicts(REPEAT);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.verdicts, [{ verdict: 'repeats', why: 'Same card rule, said again.' }]);
  const [call] = calls();
  assert.ok(call.args.includes('sonnet') && call.args.includes('--tools'), call.args.join(' '));
  assert.match(call.input, /One card, one choice/);
  assert.match(call.input, /Registered rule: When to use a card/);
});

test('nothing found: no Sonnet call at all', async () => {
  const before = calls().length;
  const r = await verdicts('Hello there, a brand new line about lunch plans.');
  assert.deepEqual(r.data, { verdicts: [] });
  assert.equal(calls().length, before);
});

test('no linked login: no check, and it says to link one', async () => {
  const before = calls().length;
  const r = await verdicts(REPEAT, joshCookie);
  assert.equal(r.status, 200);
  assert.equal(r.data.verdicts, undefined);
  assert.match(r.data.unlinked, /Your account/);
  assert.equal(calls().length, before, 'never on another person\'s login');
});

test('a failed check says so and gives no verdicts', async () => {
  writeFileSync(join(root, 'fail'), '');
  try {
    const r = await verdicts(REPEAT);
    assert.equal(r.status, 200);
    assert.equal(r.data.verdicts, undefined);
    assert.match(r.data.failed, /usage limit/);
  } finally {
    rmSync(join(root, 'fail'));
  }
});
