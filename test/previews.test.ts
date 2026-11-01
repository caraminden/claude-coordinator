import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Previews } from '../src/previews.ts';
import { agentToken, listeningPort, PASSWORD, SECRET, stopProcs } from './helpers.ts';

// Previews (src/previews.ts): the live server runs a minion's worktree in preview mode on a copy of
// its database and proxies /preview/<id>/ to it, for signed-in people only.
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'previews-test-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  rmSync(root, { recursive: true, force: true });
});

/** A minion's worktree: here, a copy of this checkout's app. */
function worktree(name: string): string {
  const dir = join(root, name);
  for (const d of ['server.ts', 'src', 'public']) cpSync(join(repo, d), join(dir, d), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'coordinator.db'));
const project = store.createProject('Test', null);
const ticket = store.createTicket({ project_id: project.id, title: 'UI change', permission_mode: 'default', created_by: 'Cara' });
store.setTicketDir(ticket.id, worktree('wt1'), 'ticket/1-ui-change');
// An older branch: its server answers, but knows nothing of preview mode.
const old = store.createTicket({ project_id: project.id, title: 'Old branch', permission_mode: 'default', created_by: 'Cara' });
const oldDir = join(root, 'old');
mkdirSync(oldDir);
execFileSync('git', ['init', '-q'], { cwd: oldDir });
writeFileSync(join(oldDir, 'server.ts'), `import { createServer } from 'node:http';
createServer((req, res) => res.end(JSON.stringify({ ok: true }))).listen(Number(process.env.PORT), '127.0.0.1');
`);
store.setTicketDir(old.id, oldDir, 'ticket/2-old');
store.savePushSubscription('Josh', 'https://push.example/x', 'k', 'a');
// A running turn's record, as live has for a turn in its own systemd unit.
store.setSetting(`turn:${ticket.id}`, { resumes: 0, unit: 'citadel-turn-x.service' });
store.db.close();

let base = '';
let cookie = '';
const startPreview = (id: number) => fetch(`${base}/api/tickets/${id}/preview`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(data, id)}` } });
const page = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { Accept: 'text/html', Cookie: cookie, ...headers }, redirect: 'manual' });

before(async () => {
  const server = spawn(process.execPath, [join(repo, 'server.ts')], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, PORT: '0', DATA_DIR: data, CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(server);
  server.stdout!.pipe(process.stdout);
  base = `http://127.0.0.1:${await listeningPort(server)}`;
  const res = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cara', password: PASSWORD }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
  // What a page load through Caddy would record as the app's address.
  await fetch(`${base}/api/me`, { headers: { Cookie: cookie, 'X-Forwarded-Host': 'app.example', 'X-Forwarded-Proto': 'https' } });
});

test('a minion has no preview until it starts one', async () => {
  assert.equal((await page(`/preview/${ticket.id}/`)).status, 404);
  const view = await (await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(view.ticket.preview, false);
});

test('start_preview boots the worktree and returns the full link; the view offers it', async () => {
  const res = await startPreview(ticket.id);
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.equal(body.url, `https://app.example/preview/${ticket.id}/`);
  const view = await (await fetch(`${base}/api/tickets/${ticket.id}`, { headers: { Cookie: cookie } })).json();
  assert.equal(view.ticket.preview, true);
});

test('a minion may only start its own preview', async () => {
  const res = await fetch(`${base}/api/tickets/${ticket.id}/preview`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(data, old.id)}` } });
  assert.equal(res.status, 403);
});

test('the proxy serves the preview to a signed-in person, as that person, without touching the live cookie', async () => {
  // The copy's own root sends the page on to its /c/ (src/http.ts ownPath), staying inside /preview/N/.
  assert.equal((await page(`/preview/${ticket.id}/`)).headers.get('location'), 'c/');
  const res = await page(`/preview/${ticket.id}/c/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Citadel preview<\/title>/);
  const me = await fetch(`${base}/preview/${ticket.id}/api/me`, { headers: { Cookie: cookie } });
  assert.deepEqual(await me.json(), { id: 1, name: 'Cara', login: 'cara', admin: true, turns: true, payer: null });
  // The preview's logout clears its cookie; that header must not reach the browser.
  const logout = await fetch(`${base}/preview/${ticket.id}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.get('set-cookie'), null);
  // The copy came without push subscriptions or turn records, though the live database has them.
  const copy = new DatabaseSync(join(data, 'previews', String(ticket.id), 'coordinator.db'), { readOnly: true });
  assert.equal(copy.prepare('SELECT count(*) AS n FROM push_subscriptions').get()!.n, 0);
  assert.equal(copy.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'turn:%'").get()!.n, 0);
  copy.close();
});

test('the event stream passes through', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/preview/${ticket.id}/api/stream`, { headers: { Cookie: cookie }, signal: ctl.signal });
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /"type":"hello"/);
  ctl.abort();
});

test('no login: a page goes to the login, anything else is refused; a bare path gets its slash', async () => {
  assert.equal((await page(`/preview/${ticket.id}/`, { Cookie: '' })).headers.get('location'), '/');
  assert.equal((await fetch(`${base}/preview/${ticket.id}/api/me`)).status, 401);
  assert.equal((await fetch(`${base}/preview/${ticket.id}/api/me`, { headers: { Authorization: `Bearer ${agentToken(data, ticket.id)}` } })).status, 401);
  assert.equal((await page(`/preview/${ticket.id}`)).headers.get('location'), `/preview/${ticket.id}/`);
});

test("an HTML page's file token gets through without a login, to the preview's own check", async () => {
  // A page in the preview's copy of the scheme's shared folder, and a picture beside it.
  const shared = join(data, 'previews', String(ticket.id), 'projects', String(project.id), 'shared', 'project');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'gallery.html'), '<img src="pic.png">');
  writeFileSync(join(shared, 'pic.png'), 'png');
  const path = `/preview/${ticket.id}/api/projects/${project.id}/shared/file?path=gallery.html`;
  const res = await fetch(base + path, { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(res.status, 302);
  const pageUrl = new URL(res.headers.get('location')!, base + path);
  assert.match(pageUrl.pathname, new RegExp(`^/preview/${ticket.id}/api/files/p${project.id}\\.`));
  // The sandboxed frame sends no cookie.
  assert.equal((await fetch(pageUrl)).status, 200);
  assert.equal((await fetch(new URL('pic.png', pageUrl))).status, 200);
  // The preview refuses a forged token itself; the bypass is for reading files only.
  const forged = await fetch(`${base}/preview/${ticket.id}/api/files/p${project.id}.zzzzzz.forged/pic.png`);
  assert.equal(forged.status, 403);
  assert.match((await forged.json()).error, /expired/);
  assert.equal((await fetch(`${base}/preview/${ticket.id}/api/files/x`, { method: 'POST' })).status, 401);
});

test('a branch without preview mode is refused, and nothing is left running', async () => {
  const res = await startPreview(old.id);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /no preview mode; rebase/);
  assert.equal(existsSync(join(data, 'previews', String(old.id))), false);
});

test('dismissing the minion stops its preview and deletes its copy', async () => {
  const dir = join(data, 'previews', String(ticket.id));
  assert.equal(existsSync(join(dir, 'coordinator.db')), true);
  const res = await fetch(`${base}/api/tickets/${ticket.id}/status`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
  assert.equal(res.status, 200);
  assert.equal(existsSync(dir), false);
  assert.equal((await page(`/preview/${ticket.id}/`)).status, 404);
});

test('idle previews stop (a page load starts them again) and at most `max` run at once', async () => {
  // The Previews class on its own, against a second store.
  const d2 = join(root, 'data2');
  mkdirSync(d2);
  const s2 = new Store(join(d2, 'coordinator.db'));
  const p2 = s2.createProject('Two', null);
  const make = (n: number) => {
    const t = s2.createTicket({ project_id: p2.id, title: `T${n}`, permission_mode: 'default', created_by: 'Cara' });
    s2.setTicketDir(t.id, worktree(`wt-two-${n}`), `ticket/${n}`);
    return s2.getTicket(t.id)!;
  };
  const [a, b] = [make(1), make(2)];
  const previews = new Previews(s2, d2);
  previews.max = 1;
  try {
    await previews.start(a);
    assert.equal(previews.isRunning(a.id), true);
    await previews.start(b);
    assert.equal(previews.isRunning(a.id), false, 'the least recently used one made room');
    assert.equal(existsSync(join(previews.root, String(a.id))), false);
    assert.equal(previews.offered(a.id), true, 'still offered: a page load starts it again');
    await previews.sweep(Date.now() + previews.idleMs + 1);
    assert.equal(previews.isRunning(b.id), false);
    assert.equal(existsSync(join(previews.root, String(b.id))), false);
  } finally {
    await previews.stop(a.id, true);
    await previews.stop(b.id, true);
  }
});

test('stopping a preview waits for its process to exit before deleting its copy', async () => {
  // A preview that ignores SIGTERM and keeps writing into its folder, as a shutting-down server does
  // (its exit handler removes run/mcp-<pid>, which made a delete racing it leave the folder behind).
  const d3 = join(root, 'data3');
  mkdirSync(d3);
  const s3 = new Store(join(d3, 'coordinator.db'));
  const t = s3.createTicket({ project_id: s3.createProject('Three', null).id, title: 'Stubborn', permission_mode: 'default', created_by: 'Cara' });
  const wt = join(root, 'stubborn');
  mkdirSync(wt);
  writeFileSync(join(wt, 'server.ts'), `import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const dir = process.env.DATA_DIR!;
writeFileSync(join(dir, '..', 'stubborn.pid'), String(process.pid));
process.on('SIGTERM', () => setInterval(() => {
  mkdirSync(join(dir, 'run'), { recursive: true });
  writeFileSync(join(dir, 'run', String(Date.now())), 'x');
}, 1));
createServer((req, res) => res.end(JSON.stringify({ ok: true, preview: true }))).listen(Number(process.env.PORT), '127.0.0.1');
`);
  s3.setTicketDir(t.id, wt, 'ticket/3-stubborn');
  const previews = new Previews(s3, d3);
  const dir = join(previews.root, String(t.id));
  const pid = () => Number(readFileSync(join(previews.root, 'stubborn.pid'), 'utf8'));
  const pids: number[] = [];
  try {
    await previews.start(s3.getTicket(t.id)!);
    pids.push(pid());
    // A restart while the old one is still stopping waits for it, so its delete can't take the new copy.
    const stopping = previews.stop(t.id);
    await previews.start(s3.getTicket(t.id)!);
    pids.push(pid());
    await stopping;
    assert.throws(() => process.kill(pids[0], 0), { code: 'ESRCH' });
    assert.equal(existsSync(join(dir, 'coordinator.db')), true, 'the new copy survives the old stop');

    await previews.stop(t.id, true);
    assert.throws(() => process.kill(pids[1], 0), { code: 'ESRCH' }, 'the process is gone once stop returns');
    assert.equal(existsSync(dir), false);
  } finally {
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {}
    }
  }
});
