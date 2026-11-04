// Scheme members get push access to the scheme's GitHub repo (#310): the owner's token invites, the
// member's accepts, and leaving undoes only what Citadel did. GitHub is faked; nothing here reaches it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { GithubLink } from '../src/github-link.ts';
import { RepoAccess } from '../src/repo-access.ts';

/** A GitHub holding repos' collaborators and invites, answering for the tokens in `tokens` (login per token). */
function fakeGithub(tokens: Record<string, string>) {
  const collaborators = new Map<string, Set<string>>(); // slug → logins
  const invites = new Map<number, { slug: string; login: string }>();
  const owners = new Map<string, string>(); // slug → the login that may manage it
  const calls: string[] = [];
  let next = 100;
  const opts = { scopes: 'repo, workflow', orgRefuses: false, down: false };
  const fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.github.com', '');
    calls.push(`${method} ${path}`);
    if (opts.down) throw new Error('fetch failed');
    const me = tokens[String((init?.headers as any)?.Authorization ?? '').replace('Bearer ', '')];
    const headers = { 'X-OAuth-Scopes': opts.scopes };
    if (!me) return Response.json({ message: 'Bad credentials' }, { status: 401, headers });
    let m: RegExpExecArray | null;
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)$/.exec(path))) {
      const [, slug, login] = m;
      if (owners.get(slug) !== me) return Response.json({ message: 'Not Found' }, { status: 404, headers });
      const set = collaborators.get(slug) ?? new Set();
      collaborators.set(slug, set);
      if (method === 'GET') return new Response(null, { status: set.has(login) ? 204 : 404, headers });
      if (method === 'DELETE') return set.delete(login), new Response(null, { status: 204, headers });
      if (opts.scopes && !opts.scopes.includes('repo')) return Response.json({ message: 'Must have admin rights to Repository.' }, { status: 403, headers });
      if (opts.orgRefuses) return Response.json({ message: 'Outside collaborators are not allowed' }, { status: 403, headers });
      const id = next++;
      invites.set(id, { slug, login });
      return Response.json({ id }, { status: 201, headers });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/invitations\/(\d+)$/.exec(path)) && method === 'DELETE') {
      return new Response(null, { status: invites.delete(Number(m[2])) ? 204 : 404, headers });
    }
    if ((m = /^\/user\/repository_invitations\/(\d+)$/.exec(path)) && method === 'PATCH') {
      const inv = invites.get(Number(m[1]));
      if (!inv || inv.login !== me) return Response.json({ message: 'Not Found' }, { status: 404, headers });
      invites.delete(Number(m[1]));
      collaborators.get(inv.slug)!.add(inv.login);
      return new Response(null, { status: 204, headers });
    }
    return Response.json({ message: `unfaked ${method} ${path}` }, { status: 500 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, collaborators, invites, owners, opts };
}

function world(live = true) {
  const store = new Store(':memory:');
  const creds = new Credentials(store, 'secret');
  const link = new GithubLink(store, creds, 'client', 'shh');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const scheme = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', cara.id);
  const gh = fakeGithub({ gho_cara: 'caraminden', gho_josh: 'KatzMeIfYouCan', gho_olive: 'olive-gh' });
  gh.owners.set('caraminden/peek-auras', 'caraminden');
  const linkGithub = (uid: number, token: string, login: string) => creds.put(uid, 'github', token, { login, id: uid, name: null });
  linkGithub(cara.id, 'gho_cara', 'caraminden');
  const access = new RepoAccess(store, link, live, gh.fetch);
  return { store, creds, link, cara, josh, olive, scheme, gh, linkGithub, access };
}

test('a linked member is invited with the owner\'s token and accepted with their own', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.deepEqual(w.access.view(w.scheme.id, w.josh.id), { state: 'added', slug: 'caraminden/peek-auras', error: null });
  assert.ok(w.gh.collaborators.get('caraminden/peek-auras')!.has('KatzMeIfYouCan'));
  assert.equal(w.gh.invites.size, 0, 'the invite was accepted');
  // Settled: syncing again asks GitHub nothing.
  const before = w.gh.calls.length;
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.equal(w.gh.calls.length, before);
  // The owner themself is never invited.
  await w.access.sync(w.scheme.id, w.cara.id);
  assert.equal(w.access.view(w.scheme.id, w.cara.id), null);
});

test('an unlinked member waits, and linking GitHub invites them', async () => {
  const w = world();
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'waiting');
  assert.equal(w.gh.calls.length, 0);
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  await w.access.syncPerson(w.josh.id);
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'added');
});

test('a member whose link stopped working is left with an invite to accept on GitHub', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.creds.fail(w.josh.id, 'github');
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'invited');
  assert.equal(w.gh.invites.size, 1);
  // Accepted on GitHub by hand: the next sweep sees it and it stays Citadel's to undo.
  const [[id, inv]] = w.gh.invites;
  w.gh.invites.delete(id);
  w.gh.collaborators.get(inv.slug)!.add(inv.login);
  await w.access.sweep();
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'added');
});

test('leaving takes off only a collaborator Citadel added', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.linkGithub(w.olive.id, 'gho_olive', 'olive-gh');
  w.gh.collaborators.set('caraminden/peek-auras', new Set(['olive-gh'])); // Olive was a collaborator already
  for (const p of [w.josh, w.olive]) {
    w.store.addMember(w.scheme.id, p.id);
    await w.access.sync(w.scheme.id, p.id);
  }
  assert.equal(w.access.view(w.scheme.id, w.olive.id)?.state, 'existing');
  assert.ok(!w.gh.calls.some((c) => c.startsWith('PUT') && c.includes('olive-gh')), 'Olive wasn\'t invited again');
  for (const p of [w.josh, w.olive]) {
    w.store.removeMember(w.scheme.id, p.id);
    assert.equal(await w.access.remove(w.scheme.id, p.id), null);
  }
  assert.deepEqual([...w.gh.collaborators.get('caraminden/peek-auras')!], ['olive-gh']);
  assert.equal(w.store.listRepoCollaborators().length, 0);
});

test('a pending invite is withdrawn when they leave; a refusal stays for the next sweep', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.creds.fail(w.josh.id, 'github');
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sync(w.scheme.id, w.josh.id);
  w.store.removeMember(w.scheme.id, w.josh.id);
  w.gh.opts.down = true;
  assert.match((await w.access.remove(w.scheme.id, w.josh.id))!, /Couldn't reach GitHub/);
  assert.equal(w.store.listRepoCollaborators().length, 1, 'kept to try again');
  w.gh.opts.down = false;
  await w.access.sweep();
  assert.equal(w.gh.invites.size, 0);
  assert.equal(w.store.listRepoCollaborators().length, 0);
});

test('a removed person\'s invites are withdrawn by tidy', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sync(w.scheme.id, w.josh.id);
  w.store.deleteUser(w.josh.id, w.cara.id);
  await w.access.tidy();
  assert.equal(w.gh.collaborators.get('caraminden/peek-auras')!.size, 0);
});

test('errors are kept and said: no owner link, missing scope, an org that refuses, a repo that isn\'t theirs', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.store.addMember(w.scheme.id, w.josh.id);

  w.creds.remove(w.cara.id, 'github');
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.deepEqual([w.access.view(w.scheme.id, w.josh.id)?.state, w.access.view(w.scheme.id, w.josh.id)?.error], ['failed', 'Cara hasn\'t linked a working GitHub in Settings → Your account, so Citadel can\'t invite @KatzMeIfYouCan to caraminden/peek-auras.']);
  w.linkGithub(w.cara.id, 'gho_cara', 'caraminden');

  w.gh.opts.scopes = 'read:user';
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.match(w.access.view(w.scheme.id, w.josh.id)!.error!, /lacks the repo permission/);
  w.gh.opts.scopes = 'repo, workflow';

  const org = w.store.createProject('Org game', 'https://github.com/some-org/game', w.cara.id);
  w.gh.owners.set('some-org/game', 'caraminden');
  w.gh.opts.orgRefuses = true;
  w.store.addMember(org.id, w.josh.id);
  await w.access.sync(org.id, w.josh.id);
  assert.match(w.access.view(org.id, w.josh.id)!.error!, /belongs to some-org, which doesn't let @caraminden add outside collaborators/);
  w.gh.opts.orgRefuses = false;

  const theirs = w.store.createProject('Not hers', 'https://github.com/someone/else', w.cara.id);
  w.store.addMember(theirs.id, w.josh.id);
  await w.access.sync(theirs.id, w.josh.id);
  assert.match(w.access.view(theirs.id, w.josh.id)!.error!, /can't manage collaborators on someone\/else/);

  // The sweep retries what failed: with everything fixed, the first scheme settles.
  await w.access.sweep();
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'added');
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.error, null);
});

test('a boot check or preview, or a server with no OAuth App, leaves GitHub alone', async () => {
  const w = world(false);
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sweep();
  await w.access.sync(w.scheme.id, w.josh.id);
  const off = new RepoAccess(w.store, new GithubLink(w.store, w.creds, '', ''), true, w.gh.fetch);
  await off.sweep();
  assert.equal(w.gh.calls.length, 0);
  assert.equal(w.store.listRepoCollaborators().length, 0);
});

test('an invite GitHub made stays Citadel\'s when accepting it fails, so leaving withdraws it', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.store.addMember(w.scheme.id, w.josh.id);
  const real = w.gh.fetch;
  (w.access as any).fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') throw new Error('timed out');
    return real(url, init);
  }) as typeof fetch;
  await w.access.sync(w.scheme.id, w.josh.id);
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'invited');
  assert.match(w.access.view(w.scheme.id, w.josh.id)!.error!, /Couldn't reach GitHub/);
  w.store.removeMember(w.scheme.id, w.josh.id);
  assert.equal(await w.access.remove(w.scheme.id, w.josh.id), null);
  assert.equal(w.gh.invites.size, 0);
});

test('members of a scheme whose repo went stay on GitHub at the sweep', async () => {
  const w = world();
  w.linkGithub(w.josh.id, 'gho_josh', 'KatzMeIfYouCan');
  w.store.addMember(w.scheme.id, w.josh.id);
  await w.access.sync(w.scheme.id, w.josh.id);
  w.store.setProjectUpstream(w.scheme.id, null, null);
  await w.access.sweep();
  assert.ok(w.gh.collaborators.get('caraminden/peek-auras')!.has('KatzMeIfYouCan'));
  assert.equal(w.access.view(w.scheme.id, w.josh.id)?.state, 'added');
});
