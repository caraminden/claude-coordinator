// Secrets (#838): a secret card's value goes to the secret store and nowhere else. Never into the stored chat, the
// events, the database in the clear, any file under the data folder, the server's output or a turn's prompt. A turn
// gets it as CITADEL_SECRET_<NAME>; a contraption reads it by name for one of its people; each person lists,
// replaces and deletes their own, and a scheme's members its scheme's.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { hashPassword } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { looksSecret } from '../public/secret-check.js';
import { agentToken, bootServer, jsonLines, PASSWORD, SECRET, stopProcs, stopTurns, until, type Booted } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'secrets-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

// Made up for the test, and long and odd enough that no other byte string in the data folder matches it by chance.
const VALUE = 'hunter2-Zq8#vX!p0wL9-correct-horse';
const SCHEME_VALUE = 'az-key-7f3Kq9LmP2xR8tW1vB6nY4cD';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// A stand-in `claude -p`: records each turn's prompt, its token and a hash of every CITADEL_SECRET_* it was given
// (never the value), and, asked to "echo it", says the value out loud, as a careless minion might.
const fakeClaude = join(root, 'claude-fake');
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (line) => {
  const prompt = JSON.parse(line);
  const secrets = {};
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('CITADEL_SECRET_')) secrets[k] = createHash('sha256').update(v).digest('hex');
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt, token: process.env.COORDINATOR_TOKEN, secrets, names: process.env.CITADEL_SECRET_NAMES ?? null }) + '\\n');
  if (JSON.stringify(prompt).includes('fail loudly')) {
    process.stderr.write('connecting with ' + process.env.CITADEL_SECRET_SITE_PW + '\\nboom\\n');
    process.exit(3);
  }
  if (JSON.stringify(prompt).includes('echo it')) {
    const text = 'The password is ' + process.env.CITADEL_SECRET_SITE_PW + ' and the key ' + process.env.CITADEL_SECRET_AZURE_KEY;
    console.log('plain line: ' + process.env.CITADEL_SECRET_SITE_PW);
    console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text }));
  } else console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fakeClaude, 0o755);

// People made before the server starts, on its database; the scheme and a contraption once it runs.
const store = new Store(join(data, 'coordinator.db'));
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const Dana = store.createUser({ name: 'Dana', login: 'dana' });
for (const u of [Josh, Dana]) store.updateUser(u.id, { password_hash: await hashPassword(PASSWORD) });
let P: { id: number };
let KEY = '';

let base = '';
const cookies: Record<string, string> = {};
let out = '';

let srv: Booted;
const call = async (path: string, opts: { method?: string; body?: unknown; token?: string; as?: string; bearer?: string } = {}) => {
  const token = opts.bearer ?? opts.token;
  const r = await srv.as(token ? { token } : { cookie: cookies[opts.as ?? 'Cara'] })(path, opts.body, opts.method);
  return { status: r.status, body: r.data };
};
const ok = async (path: string, opts: Parameters<typeof call>[1] = {}) => {
  const r = await call(path, opts);
  if (r.status >= 300) throw new Error(`${r.status} ${r.body.error}`);
  return r.body;
};

const turns = () => jsonLines(join(root, 'turns.jsonl'));
let ticket: { id: number; number: number; status: string };
const live = () => agentToken(data, ticket.id);
const idle = () => until('the turn to end', async () => (await ok(`/api/tickets/${ticket.id}`)).ticket.status !== 'running');

/** Every file under `dir` whose bytes hold `needle`, as paths. */
function filesHolding(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookies.Cara = srv.cookie;
  procs.push(srv.proc);
  srv.proc.stdout!.on('data', (b) => {
    out += b;
  });
  for (const name of ['Josh', 'Dana']) {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: name.toLowerCase(), password: PASSWORD }) });
    cookies[name] = res.headers.get('set-cookie')!.split(';')[0];
  }
  P = await ok('/api/projects', { body: { name: 'P' } });
  store.addMember(P.id, Josh.id);
  const twi = new Contraptions(store, SECRET, join(data, 'contraptions')).register({ name: 'twi', title: 'TWI', port: 9131, icon: null, home_scheme: P.id, open_paths: '[]', default_model: null, turn_cap: null });
  for (const u of [Cara, Josh]) store.setContraptionUser(twi.id, u.id, true, Cara.id);
  KEY = readFileSync(join(data, 'contraptions', 'twi', 'contraption.key'), 'utf8');
  ticket = await ok(`/api/projects/${P.id}/tickets`, { body: { message: 'I need the site password' } });
  await until('the first turn', () => turns().length >= 1);
  await idle();
});

test('a saved secret never reaches the chat, the events, the files or the prompt; the next turn gets it as an env var', async () => {
  const asked = await ok(`/api/tickets/${ticket.id}/questions`, { token: live(), body: { secret: { name: 'site_pw', why: 'To sign in to the site' } } });
  assert.match(asked.href, /e=\d+/);
  const before = turns().length;
  await ok(`/api/tickets/${ticket.id}/secret`, { body: { questionId: asked.id, value: VALUE } });
  await until('the turn its answer starts', () => turns().length > before);
  await idle();

  const events = await ok(`/api/tickets/${ticket.id}/events?after=0`);
  assert.ok(!JSON.stringify(events).includes(VALUE), 'the value is in the events');
  const card = JSON.parse(events.find((e: { kind: string }) => e.kind === 'question').data);
  assert.deepEqual({ name: card.secret.name, saved: card.settled.saved }, { name: 'SITE_PW', saved: 'SITE_PW' });
  const view = await ok(`/api/tickets/${ticket.id}`);
  assert.ok(!JSON.stringify(view).includes(VALUE), 'the value is in the ticket view');

  const turn = turns().at(-1);
  const prompt = JSON.stringify(turn.prompt);
  assert.ok(!prompt.includes(VALUE), "the value is in the turn's prompt");
  assert.match(prompt, /saved as `SITE_PW`/);
  assert.match(prompt, /\$CITADEL_SECRET_SITE_PW/);
  assert.equal(turn.secrets.CITADEL_SECRET_SITE_PW, sha(VALUE), 'the turn got the value in its env');
  assert.equal(turn.names, 'SITE_PW');

  assert.deepEqual(filesHolding(root, VALUE), [], 'a file holds the value in the clear');
  assert.ok(!out.includes(VALUE), 'the server printed the value');
  // Answered once: a second save is refused.
  assert.equal((await call(`/api/tickets/${ticket.id}/secret`, { body: { questionId: asked.id, value: 'again' } })).status, 409);
});

test('a secret said out loud in a turn is hidden in the chat', async () => {
  await ok(`/api/secrets`, { method: 'PUT', as: 'Josh', body: { scope: 'scheme', project: P.id, name: 'AZURE_KEY', value: SCHEME_VALUE } });
  const before = turns().length;
  await ok(`/api/tickets/${ticket.id}/messages`, { body: { text: 'echo it' } });
  await until('the echo turn', () => turns().length > before);
  await idle();
  const events = JSON.stringify(await ok(`/api/tickets/${ticket.id}/events?after=0`));
  assert.ok(!events.includes(VALUE) && !events.includes(SCHEME_VALUE), 'a value said in a turn is in the events');
  assert.match(events, /\[secret SITE_PW hidden\]/);
  assert.match(events, /\[secret AZURE_KEY hidden\]/);
  assert.match(events, /plain line: \[secret SITE_PW hidden\]/);
  assert.deepEqual(filesHolding(root, VALUE), [], 'a file holds the value said in a turn');
  assert.ok(!out.includes(VALUE), 'the server printed the value said in a turn');
});

test("a failed turn's stderr in the chat has its secrets hidden", async () => {
  const before = turns().length;
  await ok(`/api/tickets/${ticket.id}/messages`, { body: { text: 'fail loudly' } });
  await until('the failing turn', () => turns().length > before);
  await idle();
  const events = JSON.stringify(await ok(`/api/tickets/${ticket.id}/events?after=0`));
  assert.match(events, /connecting with \[secret SITE_PW hidden\]/);
  assert.ok(!events.includes(VALUE), 'the stderr quoted in the chat holds the value');
});

test("a person's own secrets go only to turns they sent themselves; a minion's message gets the scheme's alone", async () => {
  const other = await ok(`/api/projects/${P.id}/tickets`, { body: { message: 'another minion' } });
  await until("the other minion's turn", () => turns().some((t) => t.token === agentToken(data, other.id)));
  await until('it to end', async () => (await ok(`/api/tickets/${other.id}`)).ticket.status !== 'running');
  const before = turns().length;
  await ok(`/api/tickets/${other.id}/minion-message`, { token: agentToken(data, other.id), body: { to: ticket.number, text: 'a relay from another minion' } });
  await until('the relayed turn', () => turns().length > before);
  await idle();
  const turn = turns().at(-1);
  assert.match(JSON.stringify(turn.prompt), /a relay from another minion/);
  assert.equal(turn.secrets.CITADEL_SECRET_SITE_PW, undefined, "a minion's message carried Cara's own secret");
  assert.equal(turn.secrets.CITADEL_SECRET_AZURE_KEY, sha(SCHEME_VALUE));
  assert.equal(turn.names, 'AZURE_KEY');
});

test('a secret card can go to one person; NAMES is taken', async () => {
  const asked = await call(`/api/tickets/${ticket.id}/questions`, { token: live(), body: { to: 'josh', secret: { name: 'JOSH_KEY', scope: 'scheme' } } });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { scope: 'person', name: 'names', value: 'x' } })).status, 400);
});

test("people list, replace and delete their own secrets; a scheme's are its members'", async () => {
  const mine = await ok('/api/secrets');
  assert.ok(!JSON.stringify(mine).includes(VALUE) && !JSON.stringify(mine).includes(SCHEME_VALUE), 'a list holds a value');
  assert.deepEqual(
    mine.person.map((s: { name: string }) => s.name),
    ['SITE_PW'],
  );
  assert.deepEqual(
    mine.schemes.map((s: { project: number; name: string }) => [s.project, s.name]),
    [[P.id, 'AZURE_KEY']],
  );
  // Cara's own is hers alone; the scheme's is Josh's too, and not Dana's.
  const josh = await ok('/api/secrets', { as: 'Josh' });
  assert.deepEqual([josh.person, josh.schemes.map((s: { name: string }) => s.name)], [[], ['AZURE_KEY']]);
  const dana = await ok('/api/secrets', { as: 'Dana' });
  assert.deepEqual([dana.person, dana.schemes], [[], []]);
  assert.equal((await call('/api/secrets', { method: 'PUT', as: 'Dana', body: { scope: 'scheme', project: P.id, name: 'AZURE_KEY', value: 'mine now' } })).status, 403);
  assert.equal((await call('/api/secrets', { method: 'DELETE', as: 'Dana', body: { scope: 'scheme', project: P.id, name: 'AZURE_KEY' } })).status, 403);
  // Names are checked; a value can't be empty.
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { scope: 'person', name: '1bad name', value: 'x' } })).status, 400);
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { scope: 'person', name: 'OK', value: '' } })).status, 400);
  // Replace, then delete.
  const t0 = mine.person[0].updated_at;
  await ok('/api/secrets', { method: 'PUT', body: { scope: 'person', name: 'site_pw', value: 'a-new-one' } });
  const replaced = await ok('/api/secrets');
  assert.equal(replaced.person.length, 1);
  assert.ok(replaced.person[0].updated_at >= t0);
  await ok('/api/secrets', { method: 'DELETE', body: { scope: 'person', name: 'SITE_PW' } });
  assert.deepEqual((await ok('/api/secrets')).person, []);
  assert.equal((await call('/api/secrets', { method: 'DELETE', body: { scope: 'person', name: 'SITE_PW' } })).status, 404);
  await ok('/api/secrets', { method: 'PUT', body: { scope: 'person', name: 'SITE_PW', value: VALUE } });
});

test("one secret name saved by two people, or for two schemes, stays each owner's: reads and deletes never cross", () => {
  // Its own database, so the server's rows don't mix in.
  const own = new Store(join(root, 'owners.db'));
  const secrets = new Secrets(own, SECRET);
  const a = own.createUser({ name: 'Ann', login: 'ann' });
  const b = own.createUser({ name: 'Bo', login: 'bo' });
  for (const [scope, x, y] of [
    ['person', a.id, b.id],
    ['scheme', 1001, 1002],
  ] as const) {
    // x saves first, so a lookup that ignores the owner finds x's row for y.
    secrets.put(scope, x, 'SHARED_NAME', 'x-value-1', null);
    secrets.put(scope, y, 'SHARED_NAME', 'y-value-2', null);
    assert.equal(secrets.get(scope, x, 'SHARED_NAME'), 'x-value-1', `${scope}: first owner reads their own`);
    assert.equal(secrets.get(scope, y, 'SHARED_NAME'), 'y-value-2', `${scope}: second owner reads their own`);
    // y deleting theirs leaves x's.
    assert.equal(secrets.remove(scope, y, 'SHARED_NAME'), true);
    assert.equal(secrets.get(scope, y, 'SHARED_NAME'), null);
    assert.equal(secrets.get(scope, x, 'SHARED_NAME'), 'x-value-1', `${scope}: deleting one owner's secret deleted the other's`);
    assert.deepEqual(
      secrets.list(scope, x).map((s) => s.name),
      ['SHARED_NAME'],
    );
  }
  // A person's and a scheme's with the same owner id and name are separate rows too.
  secrets.put('scheme', a.id, 'SHARED_NAME', 'scheme-value', null);
  assert.equal(secrets.get('person', a.id, 'SHARED_NAME'), 'x-value-1');
  assert.equal(secrets.remove('scheme', a.id, 'SHARED_NAME'), true);
  assert.equal(secrets.get('person', a.id, 'SHARED_NAME'), 'x-value-1');
});

test("a contraption reads a secret by name for one of its people: theirs first, then its home scheme's", async () => {
  const read = (name: string, person: number) => call(`/api/contraptions/secrets/${name}?person=${person}`, { bearer: KEY });
  await ok('/api/secrets', { method: 'PUT', as: 'Josh', body: { scope: 'person', name: 'AZURE_KEY', value: 'joshs-own-key' } });
  assert.deepEqual((await read('AZURE_KEY', Josh.id)).body, { name: 'AZURE_KEY', scope: 'person', value: 'joshs-own-key' });
  assert.deepEqual((await read('azure_key', Cara.id)).body, { name: 'AZURE_KEY', scope: 'scheme', value: SCHEME_VALUE });
  assert.deepEqual((await read('SITE_PW', Cara.id)).body.value, VALUE);
  // Cara's own secret isn't Josh's, and Dana isn't one of its people.
  assert.equal((await read('SITE_PW', Josh.id)).status, 404);
  assert.equal((await read('AZURE_KEY', Dana.id)).status, 403);
  // Only the contraption's own server: a person's sign-in gets nothing.
  assert.equal((await call(`/api/contraptions/secrets/AZURE_KEY?person=${Cara.id}`)).status, 403);
});

test('a chat message that looks like a password or key is caught; ordinary words, links and commits are not', () => {
  for (const s of ['my password is hunter2!', 'pw: Tr0ub4dor&3', 'the key is sk-proj-abcdefghijklmnopqrstuvwxyz012345', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'use AKIAABCDEFGHIJKLMNOP', 'token=9fK2xQ7pL0mN3vB8zR5tW1yC6hJ4dG', 'api key: 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c']) {
    assert.ok(looksSecret(s), s);
  }
  // The value offered to save, without the sentence's full stop.
  assert.equal(looksSecret('The password is hunter2.'), 'hunter2');
  for (const s of ['merge it', 'see https://github.com/foo/bar/pull/12?x=abcdefghijklmnop1234', 'landed e59ee5ee5652109c1685ea6d68628e59dc3b6f9f', 'the password field should be masked', 'reset my password please', 'look at src/routes/contraptions.ts:512', '`CITADEL_SECRET_SITE_PW`']) {
    assert.ok(!looksSecret(s), s);
  }
});
