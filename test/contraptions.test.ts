// Contraptions' registry (src/contraptions.ts, the brief's section 1): who a contraption is enabled
// for, its key files, identity headers, bearer keys, and the admin routes.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions, verifyIdentity } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { bootServer } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'contraptions-'));
after(() => rmSync(root, { recursive: true, force: true }));
const SECRET = 's'.repeat(40);
const store = new Store(join(root, 'test.db'));
const keys = join(root, 'keys');
const c = new Contraptions(store, SECRET, keys);
const fields = { title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: 200 };
const mandate = c.register({ name: 'mandate', ...fields });
const peek = c.register({ name: 'peek-auras', ...fields, title: 'Peek Auras', open_paths: '["/link"]' });
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const mode = (p: string) => statSync(p).mode & 0o777;
const file = (name: string, f: string) => readFileSync(join(keys, name, f), 'utf8');

test('a contraption is enabled only for the people on its list, and disabling takes at once', () => {
  const scheme = store.createProject('Mandate', null, cara.id);
  store.addMember(scheme.id, josh.id);
  store.updateContraption('mandate', { home_scheme: scheme.id });
  assert.equal(c.enabled('mandate', josh.id), false, 'being in the scheme that builds it grants nothing');
  store.setContraptionUser(mandate.id, josh.id, true, cara.id);
  assert.equal(c.enabled('mandate', josh.id), true);
  assert.equal(c.enabled('peek-auras', josh.id), false, 'enabling one contraption enables no other');
  assert.deepEqual(store.contraptionsFor(josh.id).map((r) => ({ ...r })), [{ name: 'mandate', title: 'Mandate', icon: '/icon.svg' }]);
  store.setContraptionUser(mandate.id, josh.id, false, cara.id);
  assert.equal(c.enabled('mandate', josh.id), false);
  assert.deepEqual(store.contraptionsFor(josh.id), []);
  // Disabled in Citadel: off everywhere, without losing their place on the list.
  store.setContraptionUser(mandate.id, josh.id, true, cara.id);
  store.updateUser(josh.id, { disabled_at: Date.now() });
  assert.equal(c.enabled('mandate', josh.id), false);
  store.updateUser(josh.id, { disabled_at: null });
  assert.equal(c.enabled('mandate', josh.id), true);
});

test('key files are written for the contraption to read, and only this account can', () => {
  assert.equal(mode(keys), 0o700);
  assert.equal(mode(join(keys, 'mandate')), 0o700);
  assert.equal(mode(join(keys, 'mandate', 'identity.pub')), 0o600);
  assert.equal(mode(join(keys, 'mandate', 'contraption.key')), 0o600);
  assert.match(file('mandate', 'identity.pub'), /^-----BEGIN PUBLIC KEY-----\n/);
  assert.match(file('mandate', 'contraption.key'), /^ck_[\w-]{43}$/);
  // Citadel keeps no copy of the bearer key or the private key in the clear.
  const row = store.getContraption('mandate')!;
  assert.notEqual(row.key_hash, file('mandate', 'contraption.key'));
  assert.doesNotMatch(row.identity_private, /PRIVATE KEY/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM credentials').get()!.n, 0, 'nothing goes in the credentials table turns can reach');
});

test('an identity header verifies with its own contraption\'s public key only, until it expires', () => {
  const header = c.signIdentity('mandate', josh)!;
  assert.match(header, /^v1\.[\w-]+\.[\w-]+$/);
  const claims = verifyIdentity(header, file('mandate', 'identity.pub'), 'mandate')!;
  assert.equal(claims.sub, josh.id);
  assert.equal(claims.login, 'josh');
  assert.equal(claims.name, 'Josh');
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(verifyIdentity(header, file('peek-auras', 'identity.pub'), 'mandate'), null, 'another contraption\'s key');
  assert.equal(verifyIdentity(header, file('mandate', 'identity.pub'), 'peek-auras'), null, 'naming another contraption');
  assert.equal(verifyIdentity(header, file('mandate', 'identity.pub'), 'mandate', Date.now() + 61_000), null, 'expired');
  // A changed claim breaks the signature.
  const [v, part, sig] = header.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: cara.id, login: 'cara' })).toString('base64url');
  assert.equal(verifyIdentity(`${v}.${forged}.${sig}`, file('mandate', 'identity.pub'), 'mandate'), null);
  assert.ok(part);
  // Another SESSION_SECRET (a preview, a copy of the database) can't sign.
  assert.equal(new Contraptions(store, 't'.repeat(40), keys).signIdentity('mandate', josh), null);
});

test('a bearer contraption key names its contraption, and rotating replaces both keys', () => {
  const key = file('mandate', 'contraption.key');
  assert.equal(c.byKey(key)?.name, 'mandate');
  assert.equal(c.byKey(file('peek-auras', 'contraption.key'))?.name, 'peek-auras');
  assert.equal(c.byKey('ck_' + 'x'.repeat(43)), null);
  assert.equal(c.byKey(undefined), null);
  const pub = file('mandate', 'identity.pub');
  const before = c.signIdentity('mandate', josh)!;
  c.rotate('mandate');
  assert.equal(c.byKey(key), null, 'the old key stops working at once');
  assert.equal(c.byKey(file('mandate', 'contraption.key'))?.name, 'mandate');
  assert.notEqual(file('mandate', 'identity.pub'), pub);
  assert.equal(verifyIdentity(before, file('mandate', 'identity.pub'), 'mandate'), null);
  assert.ok(verifyIdentity(c.signIdentity('mandate', josh), file('mandate', 'identity.pub'), 'mandate'));
  assert.equal(mode(join(keys, 'mandate', 'contraption.key')), 0o600);
});

test('admins register, edit, enable and rotate; everyone else is refused, and lists only their own', { timeout: 60_000 }, async () => {
  const srv = await bootServer();
  after(() => srv.stop());
  const made = await srv.call('/api/people', { name: 'Olive' });
  const invited = await fetch(`${srv.base}/api/invite/${made.data.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
  const olive = { id: made.data.person.id as number, cookie: invited.headers.get('set-cookie')!.split(';')[0] };
  const asOlive = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => fetch(srv.base + path, {
    method, headers: { Cookie: olive.cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

  assert.equal((await srv.call('/api/contraptions', { name: 'Bad Name', title: 'x', port: 9000 })).status, 400);
  assert.equal((await srv.call('/api/contraptions', { name: 'mine', title: 'x', port: 9000 })).status, 400);
  assert.equal((await srv.call('/api/contraptions', { name: 'mandate', title: 'Mandate', port: 80 })).status, 400);
  const reg = await srv.call('/api/contraptions', { name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', default_model: 'haiku', turn_cap: 200 });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.keys_dir, join(srv.root, 'contraptions', 'mandate'));
  assert.equal(JSON.stringify(reg.data).includes('ck_'), false, 'no key in what the API shows');
  assert.equal((await srv.call('/api/contraptions', { name: 'mandate', title: 'Again', port: 9102 })).status, 409);
  const edited = await srv.call('/api/contraptions/mandate', { title: 'Mandate!', open_paths: ['/link'], turn_cap: '' }, 'PATCH');
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.data.title, edited.data.open_paths, edited.data.turn_cap, edited.data.port], ['Mandate!', ['/link'], null, 9101]);

  assert.deepEqual((await asOlive('/api/contraptions/mine')).data, []);
  for (const [path, body, method] of [
    ['/api/contraptions', undefined, 'GET'], ['/api/contraptions', { name: 'x', title: 'x', port: 9000 }, 'POST'],
    ['/api/contraptions/mandate', { title: 'Mine now' }, 'PATCH'], [`/api/contraptions/mandate/people/${olive.id}`, { enabled: true }, 'PUT'],
    ['/api/contraptions/mandate/keys', {}, 'POST'],
  ] as const) assert.equal((await asOlive(path, body, method)).status, 403, `${method} ${path}`);

  assert.equal((await srv.call(`/api/contraptions/mandate/people/${olive.id}`, { enabled: true }, 'PUT')).data.people.includes(olive.id), true);
  assert.deepEqual((await asOlive('/api/contraptions/mine')).data, [{ name: 'mandate', title: 'Mandate!', icon: '/icon.svg' }]);
  assert.deepEqual((await srv.call('/api/contraptions/mine')).data, [], 'an admin isn\'t enabled by being one');
  const key = readFileSync(join(srv.root, 'contraptions', 'mandate', 'contraption.key'), 'utf8');
  assert.equal((await srv.call('/api/contraptions/mandate/keys', {})).status, 200);
  assert.notEqual(readFileSync(join(srv.root, 'contraptions', 'mandate', 'contraption.key'), 'utf8'), key);
  await srv.call(`/api/contraptions/mandate/people/${olive.id}`, { enabled: false }, 'PUT');
  assert.deepEqual((await asOlive('/api/contraptions/mine')).data, []);
  assert.equal((await srv.call('/api/contraptions/nope/keys', {})).status, 404);
});
