import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { bootServer, jsonLines, tempRoot, until, ok, type Booted } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

// An app's release key (#837; Cara, 2026-11-17, "Both"): make_release_key posts a card any member of the app's scheme
// approves, and the Releases page's button does the same at once. Either makes the key on the server, where a stand-in
// keytool (in the test HOME's JDK) writes the keystore; the password never comes back.
const tmp = tempRoot('release-key-cards-');
const root = tmp.dir;
after(() => tmp.teardown());

const home = join(root, 'home');
const keyDir = join(home, '.config/citadel-android');
const jdkBin = join(home, '.local/share/mise/installs/java/temurin-21/bin');
mkdirSync(jdkBin, { recursive: true });
writeFileSync(
  join(jdkBin, 'keytool'),
  `#!${process.execPath}
const a = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(join(root, 'keytool.jsonl'))}, JSON.stringify(a) + '\\n');
require('node:fs').writeFileSync(a[a.indexOf('-keystore') + 1], 'jks');
`,
);
chmodSync(join(jdkBin, 'keytool'), 0o755);

const fakeClaude = join(root, 'claude-fake');
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fakeClaude, 0o755);

let base = '';
const cookies: Record<string, string> = {};
let srv: Booted;
const call = async (who: string, path: string, opts: { method?: string; body?: unknown } = {}) => ok(await srv.as(who === 'minion' ? { token: live() } : { cookie: cookies[who] })(path, opts.body || undefined, opts.method ?? 'GET'));
const turns = () => jsonLines(join(root, 'turns.jsonl'));
const live = () =>
  turns()
    .filter((t) => t.token.startsWith(`${ticket.id}.`))
    .at(-1).token;
const idle = () => until('the turn to end', async () => (await call('Cara', `/api/tickets/${ticket.id}`)).ticket.status !== 'running');
const events = async (kind: string) => (await call('Cara', `/api/tickets/${ticket.id}/events?after=0`)).filter((e: any) => e.kind === kind).map((e: any) => JSON.parse(e.data));
const ask = (contraption: string) => call('minion', `/api/tickets/${ticket.id}/release-key`, { method: 'POST', body: { contraption } });
const verdict = (who: string, planId: string, v: 'approve' | 'revise', notes?: string) => call(who, `/api/tickets/${ticket.id}/verdict`, { method: 'POST', body: { planId, verdict: v, notes } });
const press = (who: string, projectId: number, contraption: string) => call(who, '/api/releases/release-key', { method: 'POST', body: { projectId, contraption } });
const lastMessage = async () => (await events('user_message')).at(-1).text;
const keytoolRuns = () => (existsSync(join(root, 'keytool.jsonl')) ? jsonLines(join(root, 'keytool.jsonl')) : []);

let ticket: any;
let dataDir = '';
let project: any;
let other: any;

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude, HOME: home } });
  base = srv.base;
  cookies.Cara = srv.cookie;
  tmp.track(srv.proc);
  project = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'P' } });
  other = await call('Cara', '/api/projects', { method: 'POST', body: { name: 'Q' } });
  const made = await call('Cara', '/api/people', { method: 'POST', body: { name: 'Dana' } });
  const res = await fetch(`${base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'Dana-password-1' }) });
  cookies.Dana = res.headers.get('set-cookie')!.split(';')[0];
  await call('Cara', `/api/projects/${project.id}/members`, { method: 'POST', body: { person: made.person.id } });
  const store = new Store(join(srv.data, 'coordinator.db'));
  let n = 0;
  const app = (name: string, home_scheme: number) =>
    store.createContraption({ name, title: name.toUpperCase(), icon: null, port: 39000 + n, home_scheme, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: `h${n++}`, keys_at: 0 });
  for (const name of ['twi', 'later', 'pressed', 'unbuilt']) app(name, project.id);
  app('qapp', other.id);
  // Their builds found no key, as src/apk-build.ts marks it: only such an app is offered one. unbuilt's never got that far.
  for (const name of ['twi', 'later', 'pressed']) {
    mkdirSync(join(home, '.cache/citadel-apk', name), { recursive: true });
    writeFileSync(join(home, '.cache/citadel-apk', name, 'key-missing-told'), 'c');
  }
  dataDir = srv.data;
  ticket = await call('Cara', `/api/projects/${project.id}/tickets`, { method: 'POST', body: { message: 'make the key' } });
  await until('the first turn', () => turns().length >= 1);
  await idle();
});

test("a minion asks for a key: a card naming where it goes, never the password; only its own scheme's apps", async () => {
  const { id, href } = await ask('twi');
  assert.match(href, /\?e=\d+$/);
  const card = (await events('plan')).at(-1);
  assert.equal(card.id, id);
  assert.deepEqual([card.summary, card.status, card.releaseKey], ["Make TWI's release key", 'pending', { app: 'twi', title: 'TWI' }]);
  assert.ok(card.plan.includes(join(keyDir, 'twi-release.jks')));
  await assert.rejects(ask('qapp'), /403 qapp isn't one of this scheme's contraptions/);
  await assert.rejects(ask('nope'), /403/);
  await assert.rejects(ask('unbuilt'), /409 UNBUILT isn't waiting for a release key/);
  await assert.rejects(call('Cara', `/api/tickets/${ticket.id}/release-key`, { method: 'POST', body: { contraption: 'twi' } }), /403/);
  await assert.rejects(verdict('minion', id, 'approve'), /403/);
  assert.deepEqual(keytoolRuns(), []);
});

test('a plan card and a key card for another app leave it open; a newer one for the same app supersedes it', async () => {
  const first = (await events('plan')).at(-1);
  await call('minion', `/api/tickets/${ticket.id}/plans`, { method: 'POST', body: { summary: 'A plan', plan: 'Steps' } });
  const later = await ask('later');
  let status = Object.fromEntries((await events('plan')).map((c: any) => [c.id, c.status]));
  assert.equal(status[first.id], 'pending');
  const again = await ask('twi');
  status = Object.fromEntries((await events('plan')).map((c: any) => [c.id, c.status]));
  assert.deepEqual([status[first.id], status[again.id], status[later.id]], ['superseded', 'pending', 'pending']);
  await assert.rejects(verdict('Dana', first.id, 'approve'), /409 A newer card for this key replaced this one/);
  const store = new Store(join(dataDir, 'coordinator.db'));
  assert.equal(JSON.parse(store.latestPlan(ticket.id)!.data).summary, 'A plan', "a key card never stands in for the chat's plan (a setup round reads it)");
  store.db.close();
});

test('a member approves: the key is made, mode 600, its password only in its file; it is never made twice', async () => {
  const card = (await events('plan')).filter((c: any) => c.releaseKey?.app === 'twi').at(-1);
  await verdict('Dana', card.id, 'approve');
  assert.equal((await events('plan')).find((c: any) => c.id === card.id).status, 'approved');
  for (const f of ['twi-release.jks', 'twi-release.pass']) assert.equal(statSync(join(keyDir, f)).mode & 0o777, 0o600, f);
  const pw = readFileSync(join(keyDir, 'twi-release.pass'), 'utf8').trim();
  assert.equal(keytoolRuns().length, 1);
  assert.ok(!keytoolRuns()[0].some((a: string) => a.includes(pw)));
  const said = await lastMessage();
  assert.match(said, /^Approved: TWI's release key is made/);
  assert.ok(!said.includes(pw));
  assert.ok(!JSON.stringify(await call('Cara', `/api/tickets/${ticket.id}/events?after=0`)).includes(pw), 'the password is in no event');
  await idle();
  await assert.rejects(ask('twi'), /409 TWI already has a release key/);
  await assert.rejects(press('Cara', project.id, 'twi'), /409 TWI already has a release key/);
});

test('a rejected key card makes nothing, with or without a reason', async () => {
  const later = (await events('plan')).filter((c: any) => c.releaseKey?.app === 'later').at(-1);
  await verdict('Dana', later.id, 'revise', 'Not yet');
  assert.equal(await lastMessage(), 'Rejected the release key card for LATER; no key was made.\n\nNot yet');
  assert.ok(!existsSync(join(keyDir, 'later-release.jks')));
  await assert.rejects(verdict('Cara', later.id, 'approve'), /409 Dana already rejected this key/);
  await idle();
});

test("the Releases button makes the key for a member of the app's scheme, and no one else", async () => {
  await assert.rejects(press('Dana', other.id, 'qapp'), /404 No such scheme/);
  await assert.rejects(press('Dana', project.id, 'qapp'), /403 qapp isn't one of this scheme's contraptions/);
  assert.deepEqual(await press('Dana', project.id, 'pressed'), { ok: true });
  assert.ok(existsSync(join(keyDir, 'pressed-release.jks')) && existsSync(join(keyDir, 'pressed-release.pass')));
});

test('make_release_key is offered with the home apps, and its call posts the card', async () => {
  const list = (await mcp('tools/list', {})).tools.find((t: any) => t.name === 'make_release_key');
  assert.deepEqual(list.inputSchema.properties.contraption.enum, ['later', 'twi']);
  const r = await mcp('tools/call', { name: 'make_release_key', arguments: { contraption: 'later' } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, new RegExp(`\\[the key card below\\]\\(#/p/${ticket.project_id}/t/${ticket.number}\\?e=\\d+\\)`));
  assert.equal((await events('plan')).at(-1).releaseKey.app, 'later');
});

test('approving and rejecting one key card at the same moment gives the minion one answer (#1287 F3)', async () => {
  await idle();
  const card = (await events('plan')).filter((c: any) => c.releaseKey?.app === 'later').at(-1);
  assert.equal(card.status, 'pending');
  const before = (await events('user_message')).length;
  const both = await Promise.allSettled([verdict('Dana', card.id, 'approve'), verdict('Cara', card.id, 'revise', 'No')]);
  assert.deepEqual(both.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.match(String((both.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason), /409/);
  await idle();
  assert.equal((await events('user_message')).length, before + 1, 'one answer reached the minion');
  const done = (await events('plan')).find((c: any) => c.id === card.id);
  assert.equal(existsSync(join(keyDir, 'later-release.jks')), done.status === 'approved', 'the card says what happened');
});

/** One JSON-RPC call through the real MCP server (src/mcp.ts) as this minion's turn, whose scheme's apps are twi and later. */
async function mcp(method: string, params: object): Promise<any> {
  return mcpOnce(agentEnv(base, live(), ticket, 'thread', { COORDINATOR_HOME_CONTRAPTIONS: 'later,twi' }), method, params, tmp.track);
}
