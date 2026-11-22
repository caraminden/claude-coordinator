// A scheme's own icon (#222): its favicon, served from its checkout to its people only, inert (headers),
// capped in size, never through a symlink out of the repo, and re-read when it changes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ICON_PATHS, MAX_ICON_BYTES } from '../src/scheme-icon.ts';
import { bootServer, stopTurns } from './helpers.ts';

const ICON_PATH = ICON_PATHS[0];

const root = mkdtempSync(join(tmpdir(), 'scheme-icon-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="red"/></svg>';
const store = new Store(join(data, 'coordinator.db'));
store.createProject('Delve', null);
store.createProject('Citadel', null); // id 2, Citadel's (#621): its members are admins, so no test scheme sits there
/** A scheme whose checkout holds `icon` at assets/icon/icon.svg (a string, or a symlink target), or nothing. */
function scheme(name: string, icon?: string | { link: string }) {
  const p = store.createProject(name, null);
  const repo = join(root, 'repos', name);
  mkdirSync(join(repo, 'assets', 'icon'), { recursive: true });
  if (typeof icon === 'string') writeFileSync(join(repo, ICON_PATH), icon);
  else if (icon) symlinkSync(icon.link, join(repo, ICON_PATH));
  store.setProjectRepoDir(p.id, repo);
  return { ...p, repo };
}
const withIcon = scheme('Iconic', SVG);
const plain = scheme('Plain');
const huge = scheme('Huge', `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(MAX_ICON_BYTES)}--></svg>`);
writeFileSync(join(root, 'secret.svg'), SVG);
const linked = scheme('Linked', { link: join(root, 'secret.svg') });
// A web app's favicon in public/, as Citadel keeps its own; and one with both, where assets/icon/ wins.
const webApp = scheme('WebApp');
mkdirSync(join(webApp.repo, 'public'));
writeFileSync(join(webApp.repo, 'public', 'icon.svg'), SVG.replace('red', 'green'));
const both = scheme('Both', SVG);
mkdirSync(join(both.repo, 'public'));
writeFileSync(join(both.repo, 'public', 'icon.svg'), SVG.replace('red', 'green'));
// One it can't use (too big) doesn't hide the next one down.
const fallback = scheme('Fallback', `<svg xmlns="http://www.w3.org/2000/svg"><!--${'x'.repeat(MAX_ICON_BYTES)}--></svg>`);
mkdirSync(join(fallback.repo, 'public'));
writeFileSync(join(fallback.repo, 'public', 'icon.svg'), SVG.replace('red', 'green'));

test('a scheme favicon goes to its people only, inert, and is left out when there is none', { timeout: 60_000 }, async () => {
  const srv = await bootServer({ root });
  after(() => srv.stop()); // waits for the server to exit, so it isn't writing when the folder goes (#218)
  const invited = async (name: string) => {
    const made = await fetch(`${srv.base}/api/people`, { method: 'POST', headers: { Cookie: srv.cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => r.json());
    const res = await fetch(`${srv.base}/api/invite/${made.token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-long-password' }) });
    return { id: made.person.id as number, cookie: res.headers.get('set-cookie')!.split(';')[0] };
  };
  const [member, outsider] = [await invited('Max'), await invited('Olive')];
  store.addMember(withIcon.id, member.id);
  store.addMember(plain.id, member.id);
  const get = (id: number, cookie: string) => fetch(`${srv.base}/api/projects/${id}/icon`, { headers: { Cookie: cookie } });

  // A member gets the file, with the headers that keep it inert.
  const res = await get(withIcon.id, member.cookie);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SVG);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  // Someone not in the scheme is told it doesn't exist.
  const refused = await get(withIcon.id, outsider.cookie);
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).error, 'No such scheme');

  // The batch answers every key in one request: a data URL for the member's icon, null for one with none or not theirs (#1543).
  const batch = async (ids: string, cookie: string) => (await fetch(`${srv.base}/api/icons?ids=${ids}`, { headers: { Cookie: cookie } })).json();
  const mine = await batch(`${withIcon.id}.1,${plain.id}.1`, member.cookie);
  assert.deepEqual(mine.icons, { [`${withIcon.id}.1`]: `data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}`, [`${plain.id}.1`]: null });
  assert.deepEqual((await batch(`${withIcon.id}.1`, outsider.cookie)).icons, { [`${withIcon.id}.1`]: null });
  assert.equal((await fetch(`${srv.base}/api/icons?ids=x`, { headers: { Cookie: member.cookie } })).status, 400);

  // No file, a file too big, and a symlink out of the repo all answer 404; the list says there is none.
  for (const [p, why] of [[plain, 'has no'], [huge, 'is over 256 KB'], [linked, 'points outside']] as const) {
    const r = await get(p.id, srv.cookie);
    assert.equal(r.status, 404, p.name);
    assert.match((await r.json()).error, new RegExp(why), p.name);
  }
  const list = async (cookie: string) => Object.fromEntries((await fetch(`${srv.base}/api/projects`, { headers: { Cookie: cookie } }).then((r) => r.json())).map((p: any) => [p.name, p.icon]));
  const icons = await list(srv.cookie);
  assert.equal(typeof icons.Iconic, 'number');
  assert.deepEqual([icons.Plain, icons.Huge, icons.Linked], [null, null, null]);
  assert.deepEqual(Object.keys(await list(member.cookie)).sort(), ['Iconic', 'Plain']);

  // A favicon in public/ is found too, but assets/icon/icon.svg comes first.
  assert.equal(await (await get(webApp.id, srv.cookie)).text(), SVG.replace('red', 'green'));
  assert.equal(await (await get(both.id, srv.cookie)).text(), SVG);
  assert.equal(await (await get(fallback.id, srv.cookie)).text(), SVG.replace('red', 'green'));

  // A new icon (a fast-forward rewrites the file) is served at once, under a new version.
  const SVG2 = SVG.replace('red', 'blue');
  writeFileSync(join(withIcon.repo, ICON_PATH), SVG2);
  utimesSync(join(withIcon.repo, ICON_PATH), new Date(), new Date(Date.now() + 5000));
  assert.equal(await (await get(withIcon.id, member.cookie)).text(), SVG2);
  assert.notEqual((await list(srv.cookie)).Iconic, icons.Iconic);

  // Delve's case: a scheme with none whose main gains one in a fast-forward gets it on the next list, no restart.
  writeFileSync(join(plain.repo, ICON_PATH), SVG2);
  assert.equal(typeof (await list(srv.cookie)).Plain, 'number');
  assert.equal(await (await get(plain.id, member.cookie)).text(), SVG2);
});

test('citadel-app.json names the scheme icon: its override, else its source, ahead of the usual places (#840)', async () => {
  const { findIcon } = await import('../src/scheme-icon.ts');
  const repo = join(root, 'repos', 'Manifest');
  mkdirSync(join(repo, 'art'), { recursive: true });
  mkdirSync(join(repo, 'web', 'public'), { recursive: true });
  writeFileSync(join(repo, 'web/public/icon.svg'), SVG);
  writeFileSync(join(repo, 'art/logo.svg'), SVG + ' ');
  writeFileSync(join(repo, 'art/small.svg'), SVG + '  ');
  assert.match((await findIcon(repo) as any).file, /web\/public\/icon\.svg$/);
  writeFileSync(join(repo, 'citadel-app.json'), JSON.stringify({ icon: { source: 'art/logo.svg' } }));
  assert.match((await findIcon(repo) as any).file, /art\/logo\.svg$/);
  writeFileSync(join(repo, 'citadel-app.json'), JSON.stringify({ icon: { source: 'art/logo.svg', overrides: { scheme: 'art/small.svg' } } }));
  assert.match((await findIcon(repo) as any).file, /art\/small\.svg$/);
  writeFileSync(join(root, 'repos', 'x.svg'), SVG + '   ');
  writeFileSync(join(repo, 'citadel-app.json'), JSON.stringify({ icon: { source: '../x.svg', overrides: { scheme: join(root, 'repos', 'x.svg') } } }));
  assert.match((await findIcon(repo) as any).file, /web\/public\/icon\.svg$/);
});
