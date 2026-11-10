// CI runner registration tokens (#320): minted with the scheme owner's GitHub login for a machine's
// installer, never kept, each one noted for the Taskmaster. GitHub is faked; nothing here reaches it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findScheme, runnerLabel, RunnerTokens } from '../src/ci-runner.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { GithubLink } from '../src/github-link.ts';

/** A GitHub that mints runner tokens for repos whose admin holds the token, answering with `scopes`. */
function fakeGithub(tokens: Record<string, string>, admins: Record<string, string>) {
  const calls: string[] = [];
  const opts = { scopes: 'repo, workflow', down: false };
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (opts.down) throw new Error('fetch failed');
    const me = tokens[String((init?.headers as any)?.Authorization ?? '').replace('Bearer ', '')];
    const headers = { 'X-OAuth-Scopes': opts.scopes };
    if (!me) return Response.json({ message: 'Bad credentials' }, { status: 401, headers });
    const m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runners\/registration-token$/.exec(path);
    if (!m || init?.method !== 'POST') return Response.json({ message: 'unfaked' }, { status: 500 });
    if (!opts.scopes.includes('repo')) return Response.json({ message: 'Resource not accessible by integration' }, { status: 403, headers });
    if (admins[m[1]] !== me) return Response.json({ message: 'Not Found' }, { status: 404, headers });
    return Response.json({ token: 'AREGTOKEN', expires_at: '2026-11-05T13:00:00Z' }, { status: 201, headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls, opts };
}

function world(live = true) {
  const store = new Store(':memory:');
  const creds = new Credentials(store, 'secret');
  const link = new GithubLink(store, creds, 'client', 'shh');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const scheme = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', cara.id);
  const bare = store.createProject('No Repo', null, cara.id);
  store.addMember(scheme.id, josh.id);
  const gh = fakeGithub({ gho_cara: 'caraminden' }, { 'caraminden/peek-auras': 'caraminden' });
  creds.put(cara.id, 'github', 'gho_cara', { login: 'caraminden', id: 1, name: null });
  const tokens = new RunnerTokens(store, link, live, gh.fetch);
  const notes: string[] = [];
  tokens.onFetched = (p, words) => notes.push(`${p.name}: ${words}`);
  const machine = (name: string, owner: number | null) => store.createMachine(name, 'x', 'Cara', owner);
  return { store, creds, cara, josh, olive, scheme, bare, gh, tokens, notes, machine };
}

test('labels and scheme lookup follow the scheme name', () => {
  assert.equal(runnerLabel('Delve'), 'delve-ci');
  assert.equal(runnerLabel('Peek Auras'), 'peek-auras-ci');
  const w = world();
  for (const ref of ['Peek Auras', 'peek auras', 'peek-auras', 'peek-auras-ci', w.scheme.id, String(w.scheme.id)]) {
    assert.equal(findScheme(w.store, ref)?.id, w.scheme.id, String(ref));
  }
  assert.equal(findScheme(w.store, 'nope'), undefined);
  assert.equal(runnerLabel('日本'), '');
  w.store.createProject('peek-auras', null, w.cara.id);
  assert.throws(() => findScheme(w.store, 'peek-auras-ci'), { status: 409, message: /more than one scheme/ });
  assert.equal(findScheme(w.store, { id: 1 }), undefined);
});

test('a member\'s machine gets the token, made with the owner\'s login, and the Taskmaster is told', async () => {
  const w = world();
  const got = await w.tokens.issue(w.machine('josh-pc', w.josh.id), 'Peek Auras');
  assert.deepEqual(got, { scheme: 'Peek Auras', repo: 'caraminden/peek-auras', label: 'peek-auras-ci', token: 'AREGTOKEN', expires_at: '2026-11-05T13:00:00Z' });
  assert.deepEqual(w.gh.calls, ['POST /repos/caraminden/peek-auras/actions/runners/registration-token']);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /^Peek Auras: Machine josh-pc fetched a CI runner registration token for caraminden\/peek-auras/);
  assert.doesNotMatch(w.notes[0], /AREGTOKEN|gho_/, 'the note never carries a token');
  assert.doesNotMatch(JSON.stringify(got), /gho_|caraminden"/, 'the answer never carries the owner\'s token or login field');
});

test('only machines whose person is in the scheme, or lent to it, may fetch', async () => {
  const w = world();
  // Olive isn't in Peek Auras: her machine is told there's no such scheme, and GitHub is never asked.
  await assert.rejects(w.tokens.issue(w.machine('olive-pc', w.olive.id), 'Peek Auras'), { status: 404 });
  // An admin's own machine reaches every scheme, whatever its list of schemes says.
  assert.equal((await w.tokens.issue(w.machine('cara-pc', w.cara.id), w.scheme.id)).token, 'AREGTOKEN');
  // An ownerless machine reaches only the schemes on its list.
  const vault = w.machine('vault', null);
  await assert.rejects(w.tokens.issue(vault, 'Peek Auras'), { status: 404 });
  w.store.setMachineProjects(vault.id, [w.scheme.id]);
  assert.equal((await w.tokens.issue(vault, 'Peek Auras')).token, 'AREGTOKEN');
  // A disabled person's machine reaches nothing.
  w.store.updateUser(w.josh.id, { disabled_at: Date.now() });
  await assert.rejects(w.tokens.issue(w.machine('josh-pc', w.josh.id), 'Peek Auras'), { status: 404 });
  assert.equal(w.gh.calls.length, 2);
});

test('clear errors: no repo, no owner login, no admin, a missing scope, a dead link, GitHub down', async () => {
  const w = world();
  const pc = w.machine('cara-pc', w.cara.id);
  await assert.rejects(w.tokens.issue(pc, 'No Repo'), { status: 409, message: /No Repo has no GitHub repo/ });
  w.store.setProjectUpstream(w.scheme.id, 'https://github.com/someone-else/peek-auras.git', null);
  await assert.rejects(w.tokens.issue(pc, 'Peek Auras'), { status: 502, message: /Cara's GitHub login isn't an admin of someone-else\/peek-auras.*needs admin/ });
  w.store.setProjectUpstream(w.scheme.id, 'https://github.com/caraminden/peek-auras.git', null);
  w.gh.opts.scopes = 'read:user';
  await assert.rejects(w.tokens.issue(pc, 'Peek Auras'), { status: 502, message: /lacks the repo permission/ });
  w.gh.opts.scopes = 'repo';
  w.gh.opts.down = true;
  await assert.rejects(w.tokens.issue(pc, 'Peek Auras'), { status: 502, message: /Couldn't reach GitHub/ });
  w.gh.opts.down = false;
  w.creds.put(w.cara.id, 'github', 'gho_revoked', { login: 'caraminden', id: 1, name: null });
  await assert.rejects(w.tokens.issue(pc, 'Peek Auras'), { status: 502, message: /link stopped working/ });
  w.creds.remove(w.cara.id, 'github');
  await assert.rejects(w.tokens.issue(pc, 'Peek Auras'), { status: 409, message: /Cara \(who owns Peek Auras\) hasn't linked a working GitHub/ });
  assert.equal(w.notes.length, 0, 'nothing handed out, nothing noted');
});

test('mint: false gives the names after the same checks, without asking GitHub or noting anything', async () => {
  const w = world();
  const pc = w.machine('cara-pc', w.cara.id);
  assert.deepEqual(await w.tokens.issue(pc, 'Peek Auras', false), { scheme: 'Peek Auras', repo: 'caraminden/peek-auras', label: 'peek-auras-ci', token: null, expires_at: null });
  await assert.rejects(w.tokens.issue(w.machine('olive-pc', w.olive.id), 'Peek Auras', false), { status: 404 });
  await assert.rejects(w.tokens.issue(pc, 'No Repo', false), { status: 409 });
  assert.equal(w.gh.calls.length, 0);
  assert.equal(w.notes.length, 0);
});

test('a scheme with no label, or one another scheme shares, gets no token', async () => {
  const w = world();
  const pc = w.machine('cara-pc', w.cara.id);
  const odd = w.store.createProject('日本', 'https://github.com/caraminden/nihon.git', w.cara.id);
  await assert.rejects(w.tokens.issue(pc, odd.id), { status: 409, message: /no letters/ });
  w.store.createProject('PEEK  auras!', null, w.cara.id);
  await assert.rejects(w.tokens.issue(pc, w.scheme.id), { status: 409, message: /would share the runner label peek-auras-ci/ });
  assert.equal(w.gh.calls.length, 0);
});

test('a boot check or preview never asks GitHub', async () => {
  const w = world(false);
  await assert.rejects(w.tokens.issue(w.machine('cara-pc', w.cara.id), 'Peek Auras'), { status: 403 });
  assert.equal(w.gh.calls.length, 0);
});
