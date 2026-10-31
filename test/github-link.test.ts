import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { GithubLink, personGithub } from '../src/github-link.ts';
import { asEnv } from '../src/scheme-repo.ts';
import { hideTokens, pushKind, Runner, slimEvent } from '../src/runner.ts';
import { jsonLines } from './helpers.ts';

// People link their own GitHub (#182): the token is kept encrypted, and each turn gets the token of the
// person it runs for, or none, so an unlinked person's turn can't push as anyone else.
const root = mkdtempSync(join(tmpdir(), 'ghlink-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const store = new Store(join(root, 'test.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
const josh = store.createUser({ name: 'Josh', login: 'josh', server_login: true });
const rachel = store.createUser({ name: 'Rachel', login: 'rachel', server_login: true });
const project = store.createProject('Test', null, cara.id);
// Josh works in this scheme: a relay carries its sender's person only inside a scheme they're in (#211).
store.addMember(project.id, josh.id);
const creds = new Credentials(store, 'secret one');

/** GitHub, faked: the token exchange gives `token`, and /user answers for tokens in `users` (401 otherwise). */
function fakeGithub(users: Record<string, { login: string; id: number; name: string | null }>, token = 'gho_new', scope = 'repo,workflow') {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/login/oauth/access_token')) return Response.json({ access_token: token, scope });
    if (url.endsWith('/user')) {
      const t = String((init?.headers as any)?.Authorization ?? '').replace('Bearer ', '');
      return users[t] ? Response.json(users[t]) : new Response('', { status: 401 });
    }
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

test('a credential opens only with the same secret, on its own row', () => {
  creds.put(rachel.id, 'github', 'gho_rachel', { login: 'rach' });
  assert.equal(creds.get(rachel.id, 'github')!.secret, 'gho_rachel');
  assert.equal(creds.get(rachel.id, 'github')!.failed, false);
  assert.ok(!store.getCredential(rachel.id, 'github')!.secret.includes('gho_rachel'), 'stored encrypted');
  // A rotated SESSION_SECRET can't open it: it reads as needing linking again.
  const rotated = new Credentials(store, 'secret two').get(rachel.id, 'github')!;
  assert.equal(rotated.secret, null);
  assert.equal(rotated.failed, true);
  // Copied onto someone else's row, it doesn't open either.
  store.putCredential(josh.id, 'github', store.getCredential(rachel.id, 'github')!.secret, { login: 'rach' });
  assert.equal(creds.get(josh.id, 'github')!.secret, null);
  creds.remove(josh.id, 'github');
  creds.remove(rachel.id, 'github');
  assert.equal(creds.get(rachel.id, 'github'), null);
});

test('linking: the state must be the person\'s own and fresh; a token without repo is refused', async () => {
  const gh = fakeGithub({ gho_new: { login: 'joshdev', id: 7, name: 'Josh D' } });
  const link = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch);
  const url = new URL(link.authorizeUrl(josh.id, project.id, 'https://x/api/github/callback'));
  assert.equal(url.searchParams.get('scope'), 'repo workflow');
  const state = url.searchParams.get('state')!;
  // Someone else bringing Josh's state back links nothing.
  assert.equal(await link.finish(cara.id, new URLSearchParams({ state, code: 'c' }), 'https://x/api/github/callback'), null);
  assert.match((await link.status(cara.id)).error!, /expired or was for someone else/);
  assert.equal(creds.get(cara.id, 'github'), null);
  assert.equal(await link.finish(josh.id, new URLSearchParams({ state, code: 'c' }), 'https://x/api/github/callback'), project.id);
  const s = await link.status(josh.id);
  assert.equal(s.error, null);
  assert.deepEqual({ login: s.link!.login, email: s.link!.email, failed: s.link!.failed }, { login: 'joshdev', email: '7+joshdev@users.noreply.github.com', failed: false });
  // A state works once.
  await link.finish(josh.id, new URLSearchParams({ state, code: 'c' }), 'https://x/api/github/callback');
  assert.match((await link.status(josh.id)).error!, /expired/);

  const narrow = new GithubLink(store, creds, 'cid', 'csecret', fakeGithub({ gho_new: { login: 'r', id: 9, name: null } }, 'gho_new', 'read:user').fetch);
  const st = new URL(narrow.authorizeUrl(rachel.id, project.id, 'r')).searchParams.get('state')!;
  await narrow.finish(rachel.id, new URLSearchParams({ state: st, code: 'c' }), 'r');
  assert.match((await narrow.status(rachel.id)).error!, /without the repo permission/);
  assert.equal(creds.get(rachel.id, 'github'), null);
});

test('a token GitHub refuses (401) shows as needing linking again; unlink revokes it on GitHub', async () => {
  creds.put(rachel.id, 'github', 'gho_revoked', { login: 'rach', id: 3, name: null });
  const gh = fakeGithub({});
  const link = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch);
  assert.equal((await link.status(rachel.id)).link!.failed, true);
  assert.deepEqual(link.login(rachel.id), { login: 'rach', failed: true });
  await link.unlink(rachel.id);
  const revoke = gh.calls.find((c) => c.url.endsWith('/applications/cid/grant'))!;
  assert.equal(revoke.init!.method, 'DELETE');
  assert.match(String(revoke.init!.body), /gho_revoked/);
  assert.equal(link.login(rachel.id), null);
});

test('a turn gets its person\'s token and name; unlinked, none and a line saying why; not set up, nothing', () => {
  const link = new GithubLink(store, creds, 'cid', 'csecret');
  const dir = join(root, 'turn-env');
  const linked = link.forTurn(josh, dir)!;
  assert.equal(linked.env.GH_TOKEN, 'gho_new');
  assert.equal(linked.env.GH_CONFIG_DIR, join(dir, 'gh'));
  assert.ok(existsSync(join(dir, 'gh')), 'an empty gh config, so the box login is out of reach');
  assert.equal(linked.env.GIT_AUTHOR_EMAIL, '7+joshdev@users.noreply.github.com');
  assert.equal(linked.env.GIT_COMMITTER_NAME, 'Josh D');
  assert.equal(linked.login, 'joshdev');
  assert.match(linked.line, /runs for Josh.*@joshdev/);

  const unlinked = link.forTurn(cara, dir)!;
  assert.equal(unlinked.env.GH_TOKEN, undefined);
  assert.equal(unlinked.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(unlinked.env.GIT_AUTHOR_EMAIL, 'cara@citadel.invalid');
  assert.equal(unlinked.login, null);
  assert.match(unlinked.line, /Cara hasn't linked GitHub.*can't push/);

  assert.equal(new GithubLink(store, creds, '', '').forTurn(josh, dir), null);
  // Disabled: their link stays, but no turn uses it.
  assert.equal(link.forTurn({ ...josh, disabled_at: Date.now() }, dir)!.env.GH_TOKEN, undefined);
});

test('server work for a person (#195): their token, or no login at all, and never the server\'s own GH_TOKEN', () => {
  const link = new GithubLink(store, creds, 'cid', 'csecret');
  const dir = join(root, 'person-env');
  assert.deepEqual(personGithub(link, josh, dir), { login: 'joshdev', env: { GH_CONFIG_DIR: join(dir, 'gh'), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GH_TOKEN: 'gho_new' } });
  for (const none of [personGithub(link, cara, dir), personGithub(link, { ...josh, disabled_at: Date.now() }, dir), personGithub(new GithubLink(store, creds, '', ''), josh, dir)]) {
    assert.equal(none.login, null);
    assert.equal(none.env.GH_TOKEN, undefined);
    assert.equal(none.env.GH_CONFIG_DIR, join(dir, 'gh'));
  }
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  Object.assign(process.env, { GH_TOKEN: 'gho_box', GITHUB_TOKEN: 'gho_box' });
  try {
    const none = asEnv(personGithub(link, cara, dir).env)!;
    assert.equal(none.GH_TOKEN, undefined);
    assert.equal(none.GITHUB_TOKEN, undefined);
    const mine = asEnv(personGithub(link, josh, dir).env)!;
    assert.equal(mine.GH_TOKEN, 'gho_new');
    assert.equal(mine.GITHUB_TOKEN, undefined);
    assert.equal(asEnv(undefined), undefined, 'an admin\'s runs as the server does');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('pushKind spots pushes and new pull requests, not the word in passing', () => {
  assert.equal(pushKind('git push -u origin HEAD'), 'push');
  assert.equal(pushKind('cd a && git -C b push --force-with-lease'), 'push');
  assert.equal(pushKind('gh pr create --fill'), 'pr');
  assert.equal(pushKind('git commit -m "push it"'), null);
  assert.equal(pushKind('echo push'), null);
  assert.equal(pushKind('git commit -m "then git push later"'), null);
  assert.equal(pushKind("git commit -m 'gh pr create next'"), null);
  assert.equal(pushKind('git commit -m "x" && git push'), 'push');
});

test('GitHub tokens are hidden in what the chat stores: tool output and replies', () => {
  const token = 'gho_' + 'a'.repeat(36);
  const ev = slimEvent({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `GH_TOKEN=${token}\nPORT=1` }] } });
  assert.equal(ev.message.content[0].content, 'GH_TOKEN=[GitHub token hidden]\nPORT=1');
  const reply = slimEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `it is ${token}` }] } });
  assert.equal(reply.message.content[0].text, 'it is [GitHub token hidden]');
  assert.equal(hideTokens('ghost_town and gho_short stay'), 'ghost_town and gho_short stay');
});

// Through the runner: a fake claude that writes its GitHub env, and, asked to, "runs" a push.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
writeFileSync('env.json', JSON.stringify({ token: process.env.GH_TOKEN ?? null, author: process.env.GIT_AUTHOR_NAME ?? null }));
let replied = false, closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const text = JSON.parse(l).message.content.map((c) => c.text).join('\\n');
  appendFileSync('seen.txt', JSON.stringify(text) + '\\n');
  if (text.includes('push now')) {
    console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git push origin HEAD' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: !process.env.GH_TOKEN, content: 'ok' }] } }));
  }
});
rl.on('close', () => (closed = true));
setInterval(() => {
  if (!replied && existsSync('release')) {
    replied = true;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  }
  if (replied && closed) process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

function runner() {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  const link = new GithubLink(store, creds, 'cid', 'csecret');
  r.personOf = (author, from) => (from ? store.getTicket(from)?.person_id ?? null : store.findUser('name', author)?.id ?? null);
  r.githubFor = (person, dir) => link.forTurn(person ? store.getUser(person) ?? null : null, dir);
  return r;
}

function newTicket() {
  const t = store.createTicket({ project_id: project.id, kind: 'thread', title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  return { id: t.id, dir };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}
const seen = (dir: string): string[] => jsonLines(join(dir, 'seen.txt'));
const env = (dir: string) => JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'));
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
async function finish(r: Runner, t: { id: number; dir: string }) {
  writeFileSync(join(t.dir, 'release'), '');
  await until(() => !r.isRunning(t.id));
  rmSync(join(t.dir, 'release'));
}

test('a turn runs for its sender: their token, a line in its prompt, a note on each push', async () => {
  const t = newTicket();
  const r = runner();
  r.send(t.id, 'Josh', 'push now');
  await until(() => notes(t.id).some((n) => n.startsWith('Pushed')));
  assert.deepEqual(env(t.dir), { token: 'gho_new', author: 'Josh D' });
  assert.match(seen(t.dir)[0], /GitHub: this turn runs for Josh/);
  assert.ok(notes(t.id).includes('Pushed as @joshdev (Josh\'s GitHub)'));
  assert.equal(store.getTicket(t.id)!.person_id, josh.id);
  await finish(r, t);

  // Cara hasn't linked: no token, and the failed push says why.
  r.send(t.id, 'Cara', 'push now');
  await until(() => notes(t.id).some((n) => n.startsWith('Couldn\'t push')));
  assert.deepEqual(env(t.dir), { token: null, author: 'Cara' });
  assert.match(notes(t.id).at(-1)!, /runs for Cara, who hasn't linked GitHub/);
  await finish(r, t);
});

test('a message from someone else waits for its own turn instead of steering; a relay carries its sender\'s person', async () => {
  const t = newTicket();
  const r = runner();
  r.send(t.id, 'Josh', 'build it');
  await until(() => seen(t.dir).length === 1);
  r.send(t.id, 'Cara', 'also this', [], {}, true);
  r.send(t.id, 'Josh', 'and tabs', [], {}, true);
  await until(() => seen(t.dir).length === 2);
  assert.match(seen(t.dir)[1], /and tabs/);
  assert.equal(store.listEvents(t.id).filter((e) => e.kind === 'user_message' && JSON.parse(e.data).steered).length, 1);
  await finish(r, t);
  // Cara's waited, and starts a turn of her own.
  await until(() => seen(t.dir).some((l) => l.includes('also this')));
  assert.equal(store.getTicket(t.id)!.person_id, cara.id);
  assert.equal(r.relayedBy(t.id), null, 'a person\'s turn was relayed by no one');
  await finish(r, t);

  // The Taskmaster's message speaks for the person its own turn ran for.
  const tm = store.createTicket({ project_id: project.id, kind: 'thread', title: 'TM', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(tm.id, { person_id: josh.id });
  r.send(t.id, 'Taskmaster', 'over to you', [], { from: tm.id });
  await until(() => seen(t.dir).some((l) => l.includes('over to you')));
  assert.equal(store.getTicket(t.id)!.person_id, josh.id);
  assert.equal(env(t.dir).token, 'gho_new');
  assert.equal(r.relayedBy(t.id), tm.id, 'a new minion it starts this turn is the relayer\'s (#197)');
  r.send(t.id, 'Josh', 'start one for me', [], {}, true);
  await until(() => r.relayedBy(t.id) === null);
  await finish(r, t);
});

test('through the server: Link GitHub goes to GitHub for a scheme you can see; a stray callback links nothing and says so', async () => {
  const { bootServer } = await import('./helpers.ts');
  const bootRoot = join(root, 'boot');
  mkdirSync(join(bootRoot, 'data'), { recursive: true });
  const scheme = new Store(join(bootRoot, 'data', 'coordinator.db')).createProject('Linked', null);
  const s = await bootServer({ root: bootRoot, env: { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret' } });
  try {
    const get = (path: string) => fetch(s.base + path, { headers: { Cookie: s.cookie }, redirect: 'manual' });
    const go = await get(`/api/github/link?project=${scheme.id}`);
    assert.equal(go.status, 302);
    const to = new URL(go.headers.get('location')!);
    assert.equal(to.origin + to.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(to.searchParams.get('redirect_uri'), `${s.base}/api/github/callback`);
    assert.equal(to.searchParams.get('client_id'), 'cid');
    assert.equal((await get('/api/github/link?project=99999')).status, 400);
    const back = await get('/api/github/callback?state=forged&code=c');
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '../../');
    const status = (await s.call('/api/me/github')).data;
    assert.equal(status.configured, true);
    assert.equal(status.link, null);
    assert.match(status.error, /expired or was for someone else/);
  } finally {
    s.stop();
  }
});
