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
  /** The runners every faked repo lists. */
  const runners: { id: number; name: string; status: string; busy: boolean; labels: { name: string }[] }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    if (opts.down) throw new Error('fetch failed');
    const me = tokens[String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '').replace('Bearer ', '')];
    const headers = { 'X-OAuth-Scopes': opts.scopes };
    if (!me) return Response.json({ message: 'Bad credentials' }, { status: 401, headers });
    const m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runners(?:\/(registration-token|\d+)|\?per_page=(\d+)&page=(\d+))$/.exec(path);
    const method = init?.method ?? 'GET';
    if (!m || method !== (m[3] ? 'GET' : m[2] === 'registration-token' ? 'POST' : 'DELETE')) return Response.json({ message: 'unfaked' }, { status: 500 });
    if (!opts.scopes.includes('repo')) return Response.json({ message: 'Resource not accessible by integration' }, { status: 403, headers });
    if (admins[m[1]] !== me) return Response.json({ message: 'Not Found' }, { status: 404, headers });
    if (m[3]) {
      // The repo's runners a page at a time, as GitHub lists them.
      const per = Number(m[3]);
      return Response.json({ total_count: runners.length, runners: runners.slice((Number(m[4]) - 1) * per, Number(m[4]) * per) }, { headers });
    }
    if (m[2] !== 'registration-token') {
      const at = runners.findIndex((r) => r.id === Number(m[2]));
      if (at < 0) return Response.json({ message: 'Not Found' }, { status: 404, headers });
      if (runners[at].busy) return Response.json({ message: 'Runner is currently running a job and cannot be deleted.' }, { status: 422, headers });
      runners.splice(at, 1);
      return new Response(null, { status: 204, headers });
    }
    return Response.json({ token: 'AREGTOKEN', expires_at: '2026-11-05T13:00:00Z' }, { status: 201, headers });
  }) as typeof globalThis.fetch;
  return { fetch, calls, opts, runners };
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
  const machine = (name: string, owner: number) => store.createMachine(name, 'x', 'Cara', owner);
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

test("a member's machine gets the token, made with the owner's login, and the Taskmaster is told", async () => {
  const w = world();
  const got = await w.tokens.issue(w.machine('josh-pc', w.josh.id), 'Peek Auras');
  assert.deepEqual(got, { scheme: 'Peek Auras', repo: 'caraminden/peek-auras', label: 'peek-auras-ci', token: 'AREGTOKEN', expires_at: '2026-11-05T13:00:00Z' });
  assert.deepEqual(w.gh.calls, ['POST /repos/caraminden/peek-auras/actions/runners/registration-token']);
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /^Peek Auras: Machine josh-pc fetched a CI runner registration token for caraminden\/peek-auras/);
  assert.doesNotMatch(w.notes[0], /AREGTOKEN|gho_/, 'the note never carries a token');
  assert.doesNotMatch(JSON.stringify(got), /gho_|caraminden"/, "the answer never carries the owner's token or login field");
});

test('only machines whose person is in the scheme may fetch, and one with no owner never', async () => {
  const w = world();
  // Olive isn't in Peek Auras: her machine is told there's no such scheme, and GitHub is never asked.
  await assert.rejects(w.tokens.issue(w.machine('olive-pc', w.olive.id), 'Peek Auras'), { status: 404 });
  // An admin's own machine reaches every scheme, whatever its list of schemes says.
  assert.equal((await w.tokens.issue(w.machine('cara-pc', w.cara.id), w.scheme.id)).token, 'AREGTOKEN');
  // A row with no owner (one the owner backfill could name no one for, Build 10 H1) reaches nothing, listed or not.
  const vault = w.machine('vault', w.cara.id);
  w.store.db.prepare('UPDATE machines SET owner_id = NULL WHERE id = ?').run(vault.id);
  w.store.setMachineProjects(vault.id, [w.scheme.id]);
  await assert.rejects(w.tokens.issue(w.store.getMachine(vault.id)!, 'Peek Auras'), { status: 404 });
  // A disabled person's machine reaches nothing.
  w.store.updateUser(w.josh.id, { disabled_at: Date.now() });
  await assert.rejects(w.tokens.issue(w.machine('josh-pc', w.josh.id), 'Peek Auras'), { status: 404 });
  assert.equal(w.gh.calls.length, 1);
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

test("an owner's limited link that can't reach the repo says the App isn't installed there (#464)", async () => {
  const w = world();
  w.creds.put(w.cara.id, 'github', 'gho_cara', { login: 'caraminden', id: 1, name: null, app: true });
  const other = w.store.createProject('Elsewhere', 'https://github.com/someone/else.git', w.cara.id);
  await assert.rejects(w.tokens.issue(w.machine('cara-pc', w.cara.id), other.id), { status: 502, message: /limited kind, which reaches someone\/else only once its owner has installed Citadel's GitHub App/ });
});

// ---------- taking a runner off GitHub (#476 B1) ----------
// remove-runner.ps1 runs nothing from the runner's folder (a job can write there, and the script runs as SYSTEM), so
// Citadel deletes the runner on GitHub itself, by name, with the scheme owner's login.

const runner = (id: number, name: string, ...labels: string[]) => ({ id, name, status: 'online', busy: false, labels: ['self-hosted', 'Windows', ...labels].map((l) => ({ name: l })) });
const RUNNERS = '/repos/caraminden/peek-auras/actions/runners';

test("a machine takes a runner of its scheme off GitHub by name, with the owner's login, and the Taskmaster is told", async () => {
  const w = world();
  w.gh.runners.push(runner(7, 'DESK', 'peek-auras-ci'), runner(8, 'DESK-2', 'peek-auras-ci'), runner(9, 'DESK-desktop', 'peek-auras-desktop'), runner(10, 'wsl', 'peek-auras-ci-linux'));
  const pc = w.machine('josh-pc', w.josh.id);
  assert.deepEqual(await w.tokens.unregister(pc, 'Peek Auras', 'DESK-2', 'peek-auras-ci'), { scheme: 'Peek Auras', repo: 'caraminden/peek-auras', name: 'DESK-2', removed: true });
  assert.deepEqual(w.gh.calls, [`GET ${RUNNERS}?per_page=100&page=1`, `DELETE ${RUNNERS}/8`]);
  assert.deepEqual(
    w.gh.runners.map((r) => r.name),
    ['DESK', 'DESK-desktop', 'wsl'],
    'only the named one went',
  );
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /^Peek Auras: Machine josh-pc took the CI runner DESK-2 of caraminden\/peek-auras off GitHub, with Cara's GitHub login/);
  assert.doesNotMatch(w.notes[0], /gho_/);
  // The session runner's and the Linux runner's labels are the scheme's too.
  assert.equal((await w.tokens.unregister(pc, w.scheme.id, 'DESK-desktop', 'peek-auras-desktop')).removed, true);
  assert.equal((await w.tokens.unregister(pc, w.scheme.id, 'wsl', 'peek-auras-ci-linux')).removed, true);
  assert.deepEqual(
    w.gh.runners.map((r) => r.name),
    ['DESK'],
  );
  // Someone else's GitHub login is never the one asked with: a revoked owner link fails, whoever's machine asks.
  w.creds.put(w.josh.id, 'github', 'gho_josh', { login: 'josh', id: 2, name: null });
  w.creds.put(w.cara.id, 'github', 'gho_revoked', { login: 'caraminden', id: 1, name: null });
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci'), { status: 502, message: /link stopped working/ });
  assert.deepEqual(
    w.gh.runners.map((r) => r.name),
    ['DESK'],
  );
});

test('a runner GitHub no longer lists is already gone: success, nothing deleted, nothing noted', async () => {
  const w = world();
  w.gh.runners.push(runner(7, 'DESK', 'peek-auras-ci'));
  assert.deepEqual(await w.tokens.unregister(w.machine('cara-pc', w.cara.id), 'Peek Auras', 'DESK-2', 'peek-auras-ci'), { scheme: 'Peek Auras', repo: 'caraminden/peek-auras', name: 'DESK-2', removed: false });
  // An exact name: not a prefix, not another case.
  assert.equal((await w.tokens.unregister(w.machine('cara-pc2', w.cara.id), 'Peek Auras', 'desk', 'peek-auras-ci')).removed, false);
  assert.deepEqual(w.gh.calls, [`GET ${RUNNERS}?per_page=100&page=1`, `GET ${RUNNERS}?per_page=100&page=1`]);
  assert.equal(w.gh.runners.length, 1);
  assert.equal(w.notes.length, 0);
});

test('a runner whose label Citadel took off and owes back can still be removed', async () => {
  const w = world();
  w.gh.runners.push(runner(7, 'DESK'), runner(8, 'BARE'));
  w.tokens.owed = (id, label) => id === 7 && label === 'peek-auras-ci';
  const pc = w.machine('cara-pc', w.cara.id);
  assert.equal((await w.tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci')).removed, true);
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'BARE', 'peek-auras-ci'), { status: 403 });
});

test("a runner without one of the scheme's own labels is refused and stays", async () => {
  const w = world();
  // Delve's runner by hand on the same repo, another scheme's label, and a label that only starts like this scheme's.
  w.gh.runners.push(runner(1, 'DESK-perf', 'delve-perf'), runner(2, 'OTHER', 'delve-ci'), runner(3, 'NEAR', 'peek-auras-ci-2'), runner(4, 'BARE'));
  const pc = w.machine('cara-pc', w.cara.id);
  for (const name of ['DESK-perf', 'OTHER', 'NEAR', 'BARE']) {
    await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', name, 'peek-auras-ci'), { status: 403, message: new RegExp(`${name} of caraminden/peek-auras doesn't carry the label peek-auras-ci`) });
  }
  assert.equal(w.gh.runners.length, 4);
  assert.ok(
    w.gh.calls.every((c) => c.startsWith('GET ')),
    'nothing was deleted',
  );
  assert.equal(w.notes.length, 0);
});

test("the runner is found on a later page of GitHub's list", async () => {
  const w = world();
  for (let i = 1; i <= 230; i++) w.gh.runners.push(runner(i, `R${i}`, 'peek-auras-ci'));
  assert.equal((await w.tokens.unregister(w.machine('cara-pc', w.cara.id), 'Peek Auras', 'R215', 'peek-auras-ci')).removed, true);
  assert.deepEqual(w.gh.calls, [1, 2, 3].map((n) => `GET ${RUNNERS}?per_page=100&page=${n}`).concat(`DELETE ${RUNNERS}/215`));
  assert.equal(w.gh.runners.length, 229);
});

test('taking a runner off GitHub meets the same checks as a token, and says why GitHub refused', async () => {
  const w = world();
  w.gh.runners.push({ ...runner(7, 'DESK', 'peek-auras-ci'), busy: true });
  const pc = w.machine('cara-pc', w.cara.id);
  // Not this machine's scheme, no repo, no name, a name that isn't one.
  await assert.rejects(w.tokens.unregister(w.machine('olive-pc', w.olive.id), 'Peek Auras', 'DESK', 'peek-auras-ci'), { status: 404 });
  await assert.rejects(w.tokens.unregister(pc, 'No Repo', 'DESK', 'no-repo-ci'), { status: 409 });
  for (const bad of [undefined, '', 7, 'a\nb', 'x'.repeat(65)]) await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', bad, 'peek-auras-ci'), { status: 400, message: /name/ });
  // The label says which kind of runner is being removed, and is one of the scheme's own.
  for (const bad of [undefined, '', 'delve-ci', 'self-hosted', 'peek-auras-ci-2']) await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'DESK', bad), { status: 400, message: /label must be one of peek-auras-ci, peek-auras-ci-linux, peek-auras-desktop/ });
  assert.equal(w.gh.calls.length, 0);
  // GitHub won't delete a runner in the middle of a job.
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci'), { status: 502, message: /GitHub said "Runner is currently running a job and cannot be deleted\." \(422\)/ });
  w.gh.opts.down = true;
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci'), { status: 502, message: /Couldn't reach GitHub/ });
  assert.equal(w.gh.runners.length, 1);
  assert.equal(w.notes.length, 0);
  await assert.rejects(world(false).tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci'), { status: 403 });
});

// The name can come from a file a job wrote (a session runner's .runner): it must not reach a runner of another kind.
test('a check runner (#1934), which carries only its role label, is removed by the label its role comes from', async () => {
  const w = world();
  w.gh.runners.push(runner(7, 'DESK', 'peek-auras-ci-check'), runner(8, 'wsl', 'peek-auras-ci-linux-check'));
  const pc = w.machine('josh-pc', w.josh.id);
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'wsl', 'peek-auras-ci'), { status: 403 });
  assert.equal((await w.tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci')).removed, true);
});

test("a named runner carrying another of the scheme's labels than the one expected is refused", async () => {
  const w = world();
  w.gh.runners.push(runner(7, 'DESK', 'peek-auras-ci'), runner(9, 'DESK-desktop', 'peek-auras-desktop'), runner(10, 'wsl', 'peek-auras-ci-linux'));
  const pc = w.machine('cara-pc', w.cara.id);
  for (const [name, label] of [
    ['wsl', 'peek-auras-desktop'],
    ['DESK', 'peek-auras-desktop'],
    ['DESK-desktop', 'peek-auras-ci'],
    ['wsl', 'peek-auras-ci'],
    ['DESK', 'peek-auras-ci-linux'],
  ]) {
    await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', name, label), { status: 403, message: new RegExp(`${name} of caraminden/peek-auras doesn't carry the label ${label}`) });
  }
  assert.equal(w.gh.runners.length, 3);
  assert.ok(
    w.gh.calls.every((c) => c.startsWith('GET ')),
    'nothing was deleted',
  );
  assert.equal(w.notes.length, 0);
});

test('#2064: a PC whose CI no longer lends to the scheme takes only its own runners off, the ones named for its hosts', async () => {
  const w = world();
  w.gh.runners.push(runner(7, 'DESK', 'peek-auras-ci'), runner(8, 'OTHER-PC', 'peek-auras-ci'));
  const pc = w.machine('josh-pc', w.josh.id);
  w.store.writeMachineRoles(pc.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, on: true, projects: [], setup: { runner_agent: true } } : r)));
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'OTHER-PC', 'peek-auras-ci'), { status: 403, message: /isn't on josh-pc/ });
  w.tokens.hostsOf = () => ['DESK'];
  await assert.rejects(w.tokens.unregister(pc, 'Peek Auras', 'OTHER-PC', 'peek-auras-ci'), { status: 403 });
  assert.equal((await w.tokens.unregister(pc, 'Peek Auras', 'DESK', 'peek-auras-ci')).removed, true);
  assert.deepEqual(
    w.gh.runners.map((r) => r.name),
    ['OTHER-PC'],
  );
});
