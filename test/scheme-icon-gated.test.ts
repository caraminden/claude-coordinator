// A scheme's icon fallback (#810) from an app that gates its routes: the app answers 401 without an identity, so the
// fetch goes unsigned on an open path (the app's open_paths) and signed as the person asking everywhere else.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { readIcon } from '../src/scheme-icon.ts';

const root = mkdtempSync(join(tmpdir(), 'scheme-icon-gated-'));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
// The gated app: every route but /apps/gated/open.svg needs an x-citadel-identity of "good".
const service = createServer((req, res) => {
  const open = req.url === '/apps/gated/open.svg';
  const ok = open || req.headers['x-citadel-identity'] === 'good';
  if (!ok) return void res.writeHead(401).end('no identity');
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(SVG);
});
await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
const port = (service.address() as { port: number }).port;
const store = new Store(join(root, 'coordinator.db'));
after(() => {
  service.close();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
function home(name: string, icon: string, open: string[]) {
  const p = store.createProject(name, null);
  store.createContraption({ name: 'gated', title: name, icon, port, home_scheme: p.id, open_paths: JSON.stringify(open), relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: `h${n++}`, keys_at: 0 });
  return p.id;
}
const NO_REPO = join(root, 'nope');
mkdirSync(NO_REPO);

test('an icon on an open path is fetched with no identity', async () => {
  const id = home('Open', '/open.svg', ['/open.svg']);
  const got = await readIcon(id, NO_REPO, store);
  assert.ok('body' in got, JSON.stringify(got));
  assert.equal(got.body.toString(), SVG);
});

test('a gated icon is fetched with the identity of the person asking', async () => {
  store.updateContraption('gated', { name: 'x' });
  const id = home('Gated', '/apps/gated/secret.svg', []);
  assert.ok('missing' in (await readIcon(id, NO_REPO, store)), 'no identity: 401, no icon');
  const got = await readIcon(id, NO_REPO, store, () => 'good');
  assert.ok('body' in got, JSON.stringify(got));
});
