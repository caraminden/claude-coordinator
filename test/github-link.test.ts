import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { GithubLink, personGithub } from '../src/github-link.ts';
import { asEnv } from '../src/scheme-repo.ts';
import { newToken } from '../src/machines.ts';
import { hideTokens, pushKind, Runner, slimEvent } from '../src/runner.ts';
import { jsonLines, stopTurns, testPins } from './helpers.ts';
testPins();

// People link their own GitHub (#182): the token is kept encrypted, and each turn gets the token of the
// person it runs for, or none, so an unlinked person's turn can't push as anyone else.
const root = mkdtempSync(join(tmpdir(), 'ghlink-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
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

// #479: a deploy restart between Link and GitHub's way back used to lose the state, which lived in the server's memory,
// so the link failed as "expired". The state now carries what it stands for, signed, and a new server takes it.
test('linking: a state outlives a restart, but not tampering, another kind\'s secret, or its 10 minutes', async () => {
  // Rachel, so Josh keeps the link the tests below use.
  const gh = fakeGithub({ gho_new: { login: 'joshdev', id: 7, name: 'Josh D' } });
  const before = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch);
  const state = new URL(before.authorizeUrl(rachel.id, project.id, 'cb')).searchParams.get('state')!;
  const after = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch);
  assert.equal(await after.finish(rachel.id, new URLSearchParams({ state, code: 'c' }), 'cb'), project.id);
  assert.equal((await after.status(rachel.id)).error, null);
  assert.equal(creds.get(rachel.id, 'github')!.meta.login, 'joshdev');
  creds.remove(rachel.id, 'github');

  const fresh = () => new URL(after.authorizeUrl(rachel.id, project.id, 'cb')).searchParams.get('state')!;
  const refused = async (st: string, by = after) => {
    await by.finish(rachel.id, new URLSearchParams({ state: st, code: 'c' }), 'cb');
    assert.match((await by.status(rachel.id)).error!, /expired or was for someone else/);
    assert.equal(creds.get(rachel.id, 'github'), null);
  };
  // Its body rewritten to name someone else's scheme, with the signature kept.
  const [body, sig] = fresh().split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), p: 999 })).toString('base64url');
  await refused(`${forged}.${sig}`);
  // Signed by a server with another client secret.
  await refused(fresh(), new GithubLink(store, creds, 'cid', 'other secret', gh.fetch));
  // A limited state can't pass as a full one: the kind is in what's signed.
  const both = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch, APP);
  const [lb, ls] = new URL(both.authorizeUrl(rachel.id, project.id, 'cb', true)).searchParams.get('state')!.split('.');
  const asFull = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(lb, 'base64url').toString()), l: 0 })).toString('base64url');
  await refused(`${asFull}.${ls}`, both);
  await refused('garbage');
  // A signature of the right length in characters but not in bytes is refused, not thrown.
  await refused(`${fresh().split('.')[0]}.${'é'.repeat(43)}`);
  // A used state with a part tacked on is still used.
  const once = fresh();
  await after.finish(rachel.id, new URLSearchParams({ state: once, code: 'c' }), 'cb');
  creds.remove(rachel.id, 'github');
  await refused(`${once}.x`);
  // Ten minutes on, it has expired: the person goes back to the scheme they came from, with the error.
  const old = fresh();
  const now = Date.now;
  Date.now = () => now() + 10 * 60_000 + 1;
  try {
    assert.equal(await after.finish(rachel.id, new URLSearchParams({ state: old, code: 'c' }), 'cb'), project.id);
  } finally {
    Date.now = now;
  }
  assert.match((await after.status(rachel.id)).error!, /expired/);
  assert.equal(creds.get(rachel.id, 'github'), null);
});

// #464: the limited link, through Citadel's GitHub App, beside the OAuth App's full access.
const APP = { clientId: 'appid', clientSecret: 'appsecret', slug: 'citadel-app' };

/** GitHub with the App installed on `repos` for whoever asks; the exchange gives a ghu_ token with no scope. */
function fakeApp(repos: string[] | null) {
  const gh = fakeGithub({ ghu_new: { login: 'alexdev', id: 11, name: 'Alex' }, gho_old: { login: 'alexdev', id: 11, name: 'Alex' } }, 'ghu_new', '');
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes('/user/installations/5/repositories')) return gh.calls.push({ url, init }), Response.json({ repositories: repos!.map((full_name) => ({ full_name })) });
    if (url.includes('/user/installations')) return gh.calls.push({ url, init }), repos ? Response.json({ installations: [{ id: 5 }] }) : new Response('', { status: 500 });
    return gh.fetch(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls: gh.calls };
}

test('a limited link goes through the GitHub App with no scope, is kept as limited, and lists the repos it reaches', async () => {
  const gh = fakeApp(['caraminden/zeta', 'caraminden/alpha']);
  const link = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch, APP);
  const url = new URL(link.authorizeUrl(rachel.id, project.id, 'https://x/cb', true));
  assert.equal(url.searchParams.get('client_id'), 'appid');
  assert.equal(url.searchParams.has('scope'), false, 'a GitHub App takes no scope');
  assert.equal(await link.finish(rachel.id, new URLSearchParams({ state: url.searchParams.get('state')!, code: 'c' }), 'https://x/cb'), project.id);
  const exchange = gh.calls.find((c) => c.url.endsWith('/login/oauth/access_token'))!;
  assert.deepEqual(JSON.parse(String(exchange.init!.body)), { client_id: 'appid', client_secret: 'appsecret', code: 'c', redirect_uri: 'https://x/cb' });
  const s = await link.status(rachel.id);
  assert.equal(s.error, null, 'no repo scope is asked of a limited link');
  assert.deepEqual({ full: s.full, limited: s.limited, install_url: s.install_url }, { full: true, limited: true, install_url: 'https://github.com/apps/citadel-app/installations/new' });
  assert.deepEqual({ limited: s.link!.limited, reach: s.link!.reach }, { limited: true, reach: ['caraminden/alpha', 'caraminden/zeta'] });
  assert.equal(link.token(rachel)!.limited, true);
  // The turn is told what a refusal means, with where the App is installed.
  const turn = link.forTurn(rachel, mkdtempSync(join(root, 'limited-')))!;
  assert.equal(turn.env.GH_TOKEN, 'ghu_new');
  assert.match(turn.line, /limited kind.*github\.com\/apps\/citadel-app\/installations\/new/);
  // Unlinking revokes with the App's client, not the OAuth App's.
  await link.unlink(rachel.id);
  const revoke = gh.calls.find((c) => c.url.includes('/applications/'))!;
  assert.ok(revoke.url.endsWith('/applications/appid/grant'));
  assert.equal((revoke.init!.headers as any).Authorization, `Basic ${Buffer.from('appid:appsecret').toString('base64')}`);
  assert.equal(creds.get(rachel.id, 'github'), null);
});

test('a full link is unchanged beside the App, and switching kind replaces the link and revokes the old one', async () => {
  creds.put(rachel.id, 'github', 'gho_old', { login: 'alexdev', id: 11, name: 'Alex' });
  const gh = fakeApp(null);
  const link = new GithubLink(store, creds, 'cid', 'csecret', gh.fetch, APP);
  const before = await link.status(rachel.id);
  assert.deepEqual({ limited: before.link!.limited, reach: before.link!.reach }, { limited: false, reach: null });
  assert.equal(link.token(rachel)!.limited, false);
  assert.doesNotMatch(link.forTurn(rachel, mkdtempSync(join(root, 'full-')))!.line, /limited/);
  assert.equal(new URL(link.authorizeUrl(rachel.id, project.id, 'cb')).searchParams.get('client_id'), 'cid');

  const state = new URL(link.authorizeUrl(rachel.id, project.id, 'cb', true)).searchParams.get('state')!;
  await link.finish(rachel.id, new URLSearchParams({ state, code: 'c' }), 'cb');
  assert.equal(creds.get(rachel.id, 'github')!.secret, 'ghu_new');
  const revokes = gh.calls.filter((c) => c.url.includes('/applications/'));
  assert.deepEqual(revokes.map((c) => [c.url.split('/applications/')[1], JSON.parse(String(c.init!.body)).access_token]), [['cid/grant', 'gho_old']], 'the full link is revoked with the OAuth App');
  // GitHub not saying which repos: the link still shows, with no list.
  assert.equal((await link.status(rachel.id)).link!.reach, null);
  // Linking limited again keeps the grant the new token shares.
  const again = new URL(link.authorizeUrl(rachel.id, project.id, 'cb', true)).searchParams.get('state')!;
  await link.finish(rachel.id, new URLSearchParams({ state: again, code: 'c' }), 'cb');
  assert.equal(gh.calls.filter((c) => c.url.includes('/applications/')).length, 1);
  creds.remove(rachel.id, 'github');
});

test('a GitHub App left handing out expiring tokens links nothing and says which setting to change', async () => {
  const fetch = (async (url: string) => (url.endsWith('/login/oauth/access_token') ? Response.json({ access_token: 'ghu_short', expires_in: 28800, refresh_token: 'ghr_x' }) : Response.json({ login: 'a', id: 1, name: null }))) as typeof globalThis.fetch;
  const link = new GithubLink(store, creds, 'cid', 'csecret', fetch, APP);
  const state = new URL(link.authorizeUrl(rachel.id, project.id, 'cb', true)).searchParams.get('state')!;
  await link.finish(rachel.id, new URLSearchParams({ state, code: 'c' }), 'cb');
  assert.match((await link.status(rachel.id)).error!, /Expire user authorization tokens/);
  assert.equal(creds.get(rachel.id, 'github'), null);
});

test('each way of linking shows only when it is set up; a limited state is refused once the App is gone', async () => {
  const none = { clientId: '', clientSecret: '', slug: '' };
  const only = new GithubLink(store, creds, '', '', fakeApp([]).fetch, APP);
  assert.deepEqual([only.configured, only.full, only.limited], [true, false, true]);
  assert.notEqual(only.forTurn(josh, mkdtempSync(join(root, 'only-'))), null, 'with only the App set up, turns still never use the box\'s login');
  const oauth = new GithubLink(store, creds, 'cid', 'csecret', fakeApp([]).fetch, none);
  assert.deepEqual([oauth.configured, oauth.full, oauth.limited, oauth.installUrl], [true, true, false, null]);
  const state = new URL(oauth.authorizeUrl(rachel.id, project.id, 'cb', true)).searchParams.get('state')!;
  await oauth.finish(rachel.id, new URLSearchParams({ state, code: 'c' }), 'cb');
  assert.match((await oauth.status(rachel.id)).error!, /isn't set up/);
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

test("Citadel's machine tokens, Anthropic and AWS keys and PEM private keys are hidden too (#481)", () => {
  // Made up, in each real shape: machines.ts's ccm_<id>_<32 bytes base64url>, and the rest as their issuers print them.
  const machine = newToken(12);
  const anthropic = `sk-ant-api03-${'Zq9_'.repeat(20)}`;
  const aws = 'AKIAIOSFODNN7EXAMPLE';
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(hideTokens(`Authorization: Bearer ${machine}`), 'Authorization: Bearer [Citadel machine token hidden]');
  assert.equal(hideTokens(`ANTHROPIC_API_KEY=${anthropic}\nX=1`), 'ANTHROPIC_API_KEY=[Anthropic key hidden]\nX=1');
  assert.equal(hideTokens(`aws_access_key_id = ${aws}`), 'aws_access_key_id = [AWS key hidden]');
  assert.equal(hideTokens(`key:\n${pem}\ndone`), 'key:\n[private key hidden]\ndone');
  assert.equal(hideTokens('cut off:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow'), 'cut off:\n[private key hidden]');
  // Lookalikes stay: a short ccm_ id, a public key, prose.
  for (const s of ['ccm_12_short', '-----BEGIN PUBLIC KEY-----', 'ask-ant-farm', 'AKIA is how AWS key ids start']) assert.equal(hideTokens(s), s);
  // In tool output and in a person's message as the chat stores it.
  const ev = slimEvent({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `TOKEN=${machine}` }] } });
  assert.equal(ev.message.content[0].content, 'TOKEN=[Citadel machine token hidden]');
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
    // No GitHub App on this server: the limited way isn't offered (#464).
    assert.equal((await get(`/api/github/link?project=${scheme.id}&kind=limited`)).status, 503);
    assert.equal((await s.call('/api/me/github')).data.limited, false);
    const back = await get('/api/github/callback?state=forged&code=c');
    assert.equal(back.status, 302);
    assert.equal(back.headers.get('location'), '../../c/');
    const status = (await s.call('/api/me/github')).data;
    assert.equal(status.configured, true);
    assert.equal(status.link, null);
    assert.match(status.error, /expired or was for someone else/);
  } finally {
    await s.stop();
  }
});

test("a person's message shows with its key hidden, and the turn still gets it as typed (#481)", async () => {
  const t = newTicket();
  const r = runner();
  r.send(t.id, 'Josh', 'the key is AKIAIOSFODNN7EXAMPLE');
  await until(() => seen(t.dir).length > 0);
  const stored = store.listEvents(t.id).filter((e) => e.kind === 'user_message').map((e) => JSON.parse(e.data).text);
  assert.deepEqual(stored, ['the key is [AWS key hidden]']);
  assert.match(seen(t.dir)[0], /the key is AKIAIOSFODNN7EXAMPLE/);
  await finish(r, t);
});
