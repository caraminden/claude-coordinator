// A scheme with no icon in its repo shows its home contraption's icon (#810): fetched from the app's service,
// inert, capped, versioned by the app's last deployed commit; a repo icon still wins.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_ICON_BYTES } from '../src/scheme-icon.ts';
import { bootServer, stopTurns } from './helpers.ts';
import { json } from './typed.ts';

const root = mkdtempSync(join(tmpdir(), 'scheme-icon-app-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="red"/></svg>';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The fake app service at the boundary: /icon.svg, /icon.png, /big.svg, /text.svg (wrong type).
let svgBody = SVG;
const service = createServer((req, res) => {
  req.url = req.url!.replace(/^\/apps\/[^/]+\//, '/apps/twi/');
  if (req.url === '/apps/twi/icon.svg') res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(svgBody);
  else if (req.url === '/apps/twi/icon.png') res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
  else if (req.url === '/apps/twi/big.svg') res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(`<svg><!--${'x'.repeat(MAX_ICON_BYTES)}--></svg>`);
  else if (req.url === '/apps/twi/page.svg') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<script>1</script>');
  else res.writeHead(404).end();
});
await new Promise<void>((r) => service.listen(0, '127.0.0.1', r));
const port = (service.address() as { port: number }).port;
after(async () => {
  service.close();
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

const store = new Store(join(data, 'coordinator.db'));
store.createProject('Delve', null);
store.createProject('Citadel', null);
let n = 0;
const app = (name: string, home: number, icon: string | null) =>
  store.createContraption({ name, title: name, icon, port, home_scheme: home, open_paths: '[]', relay_paths: '[]', repo: null, branch: null, folder: null, default_model: null, turn_cap: null, identity_public: 'x', identity_private: 'x', key_hash: `h${n++}`, keys_at: 0 });
const deploy = (name: string, sha: string) => store.addContraptionDeploy({ name, from_sha: null, to_sha: sha, by: 'Cara', started_at: 1, finished_at: 2, outcome: 'deployed', stages: '{}', changes: '[]' });
function scheme(name: string, repoIcon?: string) {
  const p = store.createProject(name, null);
  const repo = join(root, 'repos', name);
  mkdirSync(join(repo, 'assets', 'icon'), { recursive: true });
  if (repoIcon) writeFileSync(join(repo, 'assets/icon/icon.svg'), repoIcon);
  store.setProjectRepoDir(p.id, repo);
  return p;
}
const twi = scheme('TWI');
const voice = scheme('Voice');
const both = scheme('Both', SVG.replace('red', 'green'));
const bad = scheme('Bad');
const big = scheme('Big');
const none = scheme('None');
app('twi', twi.id, '/icon.svg');
deploy('twi', 'aaaaaaaaaaaa1111');
app('voice', voice.id, '/icon.png');
app('both', both.id, '/icon.svg');
app('bad', bad.id, '/page.svg'); // wrong type
app('big', big.id, '/big.svg');
// Two home apps: the older registration (lowest id) is the one.
app('second', twi.id, '/icon.png');
for (const name of ['bad', 'big']) store.updateContraption(name, { name: `x-${name}` });
// The fake serves /apps/twi/...: point bad and big's rows at that prefix through absolute icon paths.
store.updateContraption('x-bad', { icon: '/apps/twi/page.svg' });
store.updateContraption('x-big', { icon: '/apps/twi/big.svg' });

test("a scheme with no repo icon shows its home app's icon, inert, capped, versioned by deploy", { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop());
  const get = (id: number) => fetch(`${srv.base}/api/projects/${id}/icon`, { headers: { Cookie: srv.cookie } });
  const list = async () => Object.fromEntries((await fetch(`${srv.base}/api/projects`, { headers: { Cookie: srv.cookie } }).then((r) => json<{ name: string; icon: unknown }[]>(r))).map((p) => [p.name, p.icon]));

  const res = await get(twi.id);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SVG);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  // A PNG goes out as image/png, still nosniff.
  const png = await get(voice.id);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);

  // The repo's own icon wins over the app's.
  assert.equal(await (await get(both.id)).text(), SVG.replace('red', 'green'));
  // A reply that isn't an image, or is over the cap, is no icon.
  assert.equal((await get(bad.id)).status, 404);
  assert.equal((await get(big.id)).status, 404);
  assert.equal((await get(none.id)).status, 404);

  const before = await list();
  assert.equal(typeof before.TWI, 'number');
  assert.equal(before.None, null);
  assert.equal(typeof before.Both, 'number');

  // A redeploy moves the version, and the new icon is served.
  svgBody = SVG.replace('red', 'blue');
  deploy('twi', 'bbbbbbbbbbbb2222');
  const after2 = await list();
  assert.notEqual(after2.TWI, before.TWI);
  assert.equal(await (await get(twi.id)).text(), svgBody);
});
