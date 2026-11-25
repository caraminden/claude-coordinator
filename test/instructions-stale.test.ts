// #1859 (Josh, 2026-11-24: "F6 Two people saving instructions: Go"): a save of the scheme's or the Citadel-wide instructions, or of
// typed minion rules, over a version its page never showed is refused, like the Reviewers page's stale save. The version is optional.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, type Booted } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'instr-stale-'));
let srv: Booted;
let path = '';
let joshCookie = '';

const send = async (method: string, to: string, body: object, cookie = srv.cookie) => {
  const r = await fetch(srv.base + to, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, data: (await r.json()) as { error?: string } };
};
const stored = async () => (await srv.call(path)).data.project;
const wide = async () => (await srv.call('/api/app/instructions')).data.text;

before(async () => {
  srv = await bootServer({ root });
  const project = (await srv.call('/api/projects', { name: 'P' })).data;
  path = `/api/projects/${project.id}`;
  const made = (await srv.call('/api/people', { name: 'Josh', admin: true })).data;
  const inv = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Josh-password-1' }) });
  joshCookie = inv.headers.get('set-cookie')!.split(';')[0];
  await srv.call(`${path}/members`, { person: made.person.id });
  const citadel = (await srv.call('/api/projects', { name: 'Citadel' })).data; // id 2: its members are admins (#621), who edit the Citadel-wide instructions
  await srv.call(`/api/projects/${citadel.id}/members`, { person: made.person.id });
});
after(async () => {
  await srv?.stop();
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

test("the scheme's instructions: a save over a version it hasn't seen is refused, naming who saved, and theirs stays", async () => {
  assert.equal((await send('PATCH', path, { instructions: 'One.' })).status, 200);
  assert.equal((await send('PATCH', path, { instructions: 'One. And Josh.', was: { instructions: 'One.' } }, joshCookie)).status, 200);
  const late = await send('PATCH', path, { name: 'Renamed', instructions: 'One. And mine.', was: { instructions: 'One.' } });
  assert.equal(late.status, 409);
  assert.match(late.data.error ?? '', /^Josh saved a different text since you opened it\./);
  const now = await stored();
  assert.equal(now.instructions, 'One. And Josh.');
  assert.equal(now.name, 'P', 'nothing else of a refused save is written');
  // Line ends and outer blank lines are the field's, not another version; the same text again is no conflict (a lost reply's retry).
  assert.equal((await send('PATCH', path, { instructions: 'Two.', was: { instructions: '\r\nOne. And Josh.\n' } })).status, 200);
  assert.equal((await send('PATCH', path, { instructions: 'Two.', was: { instructions: 'One.' } })).status, 200);
});

test('a save that names no version works as it did', async () => {
  await send('PATCH', path, { instructions: 'Josh again.' }, joshCookie);
  assert.equal((await send('PATCH', path, { instructions: 'A tool.' })).status, 200);
  assert.equal((await stored()).instructions, 'A tool.');
  assert.equal((await send('PUT', '/api/app/instructions', { text: 'A tool.' })).status, 200);
  assert.equal(await wide(), 'A tool.');
});

test('the Citadel-wide instructions: the same', async () => {
  await send('PUT', '/api/app/instructions', { text: 'Wide.' });
  assert.equal((await send('PUT', '/api/app/instructions', { text: 'Wide. Josh.', was: 'Wide.' }, joshCookie)).status, 200);
  const late = await send('PUT', '/api/app/instructions', { text: 'Wide. Mine.', was: 'Wide.' });
  assert.equal(late.status, 409);
  assert.match(late.data.error ?? '', /^Josh saved/);
  assert.equal(await wide(), 'Wide. Josh.');
  assert.equal((await send('PUT', '/api/app/instructions', { text: 'Wide. Both.', was: 'Wide. Josh.' })).status, 200);
});

test("typed minion rules: another person's rule and note are kept; the rules' order is no change", async () => {
  await send('PATCH', path, { approval_rules: 'Bash(a:*)\nBash(b:*)', shot_note: 'Both themes' });
  await send('PATCH', path, { approval_rules: 'Bash(a:*)\nBash(b:*)\nBash(josh:*)', shot_note: 'Josh says phone too' }, joshCookie);
  assert.equal((await send('PATCH', path, { approval_rules: 'Bash(a:*)\nBash(b:*)\nBash(mine:*)', was: { approval_rules: 'Bash(a:*)\nBash(b:*)' } })).status, 409);
  assert.equal((await send('PATCH', path, { shot_note: 'Mine', was: { shot_note: 'Both themes' } })).status, 409);
  const now = await stored();
  assert.equal(now.approval_rules, 'Bash(a:*)\nBash(b:*)\nBash(josh:*)');
  assert.equal(now.shot_note, 'Josh says phone too');
  assert.equal((await send('PATCH', path, { approval_rules: 'Bash(a:*)', was: { approval_rules: 'Bash(josh:*)\nBash(b:*)\nBash(a:*)' } })).status, 200);
});
