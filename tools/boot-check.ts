// Boot check for tools/deploy.sh: syntax-check the front end, start a checkout's server on a spare port
// against a copy of the database, confirm it serves the app, that the app renders in headless Chromium
// without a console error, and that a minion turn and a Taskmaster turn start through the runner's real
// arguments (with tools/boot-check-claude.ts as claude, which checks the turn's MCP server initializes,
// reads the longest chat and the scheme instructions, and that no launch argument nears Linux's cap and no
// launch file its consumer's), that
// the file viewer's details of a linked and a shared file load, then stop it. Prints the front-end version it served; exits non-zero with the reason on any
// failure.
//   node tools/boot-check.ts <checkout> <coordinator.db>
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { copyDb } from '../src/db-copy.ts';
import { MAX_STRETCH, stepLimit, within } from '../src/load-stretch.ts';
import { listeningPort } from '../src/ports.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { projectSharedDir } from '../src/workspace.ts';

const [checkout, db] = process.argv.slice(2);
if (!checkout || !db) throw new Error('usage: boot-check.ts <checkout> <coordinator.db>');
const { Store } = await import(join(checkout, 'src', 'db.ts'));

const root = mkdtempSync(join(tmpdir(), 'citadel-boot-check-'));
const procs: ChildProcess[] = [];
let log = '';
// Each step's time goes to stderr (deploy.sh's log), and the 3-minute message names the step it was on.
const start = Date.now();
let step = '';
let stepAt = start;
const begin = (next: string) => {
  if (step) console.error(`boot-check: ${step}: ${((Date.now() - stepAt) / 1000).toFixed(1)} s`);
  [step, stepAt] = [next, Date.now()];
};
const fail = (why: string): never => {
  throw new Error(`${why}${log ? `\n--- server output ---\n${log.slice(-3000)}` : ''}`);
};
// Whatever hangs (a browser call, a turn), deploy.sh gets an answer. Each step has its own shorter
// limit; on a loaded box the steps together can take two minutes. Armed again after the copy, which
// grows with the database while the boot does not, so the copy has its own 3 minutes (#497).
let backstop: NodeJS.Timeout | undefined;
let copied = false;
const arm = () => {
  clearTimeout(backstop);
  backstop = setTimeout(() => {
    console.error(`The boot check did not finish within 3 minutes${copied ? ' after the copy' : ''} (stuck ${((Date.now() - stepAt) / 1000).toFixed(0)} s on: ${step}; ${((Date.now() - start) / 1000).toFixed(0)} s in all)${log ? `\n--- server output ---\n${log.slice(-3000)}` : ''}`);
    for (const p of procs) p.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }, 180_000).unref();
};
arm();

try {
  begin('front-end syntax check');
  // A syntax error in any front-end file blanks the app; node --check finds it without a browser.
  const pub = join(checkout, 'public');
  const scripts = readdirSync(pub).filter((f) => /\.m?js$/.test(f));
  const bad = (
    await Promise.all(
      scripts.map((f) =>
        promisify(execFile)(process.execPath, ['--check', join(pub, f)]).then(
          () => null,
          (err) => `${f}: ${err.stderr.trim()}`,
        ),
      ),
    )
  ).filter(Boolean);
  if (bad.length) fail(`Front-end files don't parse:\n${bad.join('\n')}`);

  begin('copying the database');
  const copy = join(root, 'coordinator.db');
  await copyDb(db, copy, { events: 'open' }); // the open chats are what a turn reads; the closed ones were most of the bytes (#1169)
  copied = true;
  arm();

  // The turns to start: the largest Taskmaster launch and a new minion in its scheme. That is the Citadel scheme's,
  // asked by an admin as below, so it reads every scheme (#656, #661: that launch passed Claude Code's 2 MiB cap
  // while a plain one passed this check); with no Citadel Taskmaster, the one with the most open minions. Both run
  // in folders of their own, never a real worktree, and nothing is held for the usage limit in the copy.
  begin('migrating the copy');
  const turnStore = new Store(copy);
  arm(); // migrating grows with the database too: moving the chat log into events.db took ~30 s on a copy (#1169)
  // A running ultra review's record names its live working folder, which a server recovering it would delete.
  turnStore.deleteSetting('ultrareview_running');
  // The stand-in tests Claude's launch, not a real Codex turn or review. Copied volume paths can
  // otherwise select (or wake) the server login's Codex container, bypassing CLAUDE_BIN entirely.
  turnStore.db.prepare("DELETE FROM settings WHERE key GLOB 'container_home:*' OR key GLOB 'codex:on:user:*'").run();
  // A Taskmaster's git rules name each open minion's worktree (#92, #661): counted here from the copy, as the runner does.
  const openIn = (projectId: number) => (turnStore.db.prepare(`select count(*) n from tickets where project_id = ? and kind != 'coordinator' and status != 'closed' and coalesce(cwd, '') != ''`).get(projectId) as any).n as number;
  const busiest = (turnStore.db.prepare(`select id, project_id, permission_mode, branch from tickets where kind = 'coordinator'`).all() as any[]).map((c) => ({ ...c, open: openIn(c.project_id) })).sort((a, b) => Number(b.project_id === GLOBAL_OWNER) - Number(a.project_id === GLOBAL_OWNER) || b.open - a.open)[0];
  const turnChecks: { what: string; id: number; dir: string }[] = [];
  // A file in the new minion's folder and one in the scheme's shared folder, for the file viewer's details (#157).
  const fileChecks: { what: string; path: string }[] = [];
  if (busiest) {
    const minion = turnStore.createTicket({ project_id: busiest.project_id, title: 'Boot check', permission_mode: busiest.permission_mode, created_by: 'boot-check' });
    for (const [what, id, branch] of [
      ['Taskmaster', busiest.id, busiest.branch],
      ['minion', minion.id, null],
    ] as const) {
      const dir = join(root, `turn-${id}`);
      mkdirSync(dir);
      turnStore.setTicketDir(id, dir, branch);
      turnChecks.push({ what, id, dir });
    }
    const others =
      busiest.project_id === GLOBAL_OWNER
        ? (
            turnStore.db
              .prepare(`select count(*) n from tickets t join projects p on p.id = t.project_id
      where t.project_id != ? and coalesce(p.repo_dir, '') != '' and t.kind != 'coordinator' and t.status != 'closed' and coalesce(t.cwd, '') != ''`)
              .get(busiest.project_id) as any
          ).n
        : null;
    console.error(`boot-check: the Taskmaster of scheme ${busiest.project_id}, with ${busiest.open} open minions${others === null ? '' : ` and every scheme's reads (${others} open minions in other schemes)`}`);
    // What the Taskmaster's stand-in claude reads back: the longest open chat (#120 broke read_ticket past
    // one page) and the first line of the scheme's instructions.
    const longest = turnStore.db
      .prepare(`select t.number from events e join tickets t on t.id = e.ticket_id
      where t.project_id = ? and t.number is not null and t.status != 'closed' group by e.ticket_id order by count(*) desc limit 1`)
      .get(busiest.project_id) as any;
    const instructions =
      turnStore
        .getProject(busiest.project_id)
        ?.instructions?.split('\n')
        .find((l: string) => l.trim())
        ?.trim() ?? null;
    writeFileSync(join(turnChecks[0].dir, 'boot-check.json'), JSON.stringify({ longest: longest?.number ?? null, instructions }));
    const shared = projectSharedDir(root, busiest.project_id);
    mkdirSync(shared, { recursive: true });
    for (const [where, dir] of [
      ['linked', turnChecks[1].dir],
      ['shared', shared],
    ])
      writeFileSync(join(dir, 'boot-check.md'), `# Boot check\n\nA ${where} file.\n`);
    fileChecks.push({ what: 'a linked file', path: `/api/tickets/${minion.id}/file?path=boot-check.md&info` }, { what: 'a shared file', path: `/api/projects/${busiest.project_id}/shared/file?path=boot-check.md&info` });
    turnStore.deleteSetting('limit-resumes');
  } else {
    console.error('boot-check: no Taskmaster in the database, so no turn was started');
  }
  // The shared password signs in only an admin, by login: the copy's first one, or the one the server
  // makes from COORDINATOR_ADMIN below when the copy has no people yet.
  const adminLogin = turnStore.listUsers().find((u) => u.admin && !u.disabled_at)?.login ?? 'boot-check';
  turnStore.db.close();
  // Keep the executable separate from CLAUDE_CONFIG_DIR, which must be a directory.
  mkdirSync(join(root, 'bin'));
  const claude = join(root, 'bin', 'claude');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, 'boot-check-claude.ts'))} "$@"\n`);
  chmodSync(claude, 0o755);

  begin('server start');
  const password = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const server = spawn(process.execPath, [join(checkout, 'server.ts')], {
    cwd: checkout,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: root,
      BOOT_CHECK: '1',
      CLAUDE_BIN: claude,
      TURN_UNITS: '0',
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      COORDINATOR_PASSWORD: password,
      COORDINATOR_ADMIN: 'boot-check',
      SESSION_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(server);
  server.stdout!.on('data', (d) => (log += d));
  server.stderr!.on('data', (d) => (log += d));
  // The checkout's server.ts is the one being deployed, so it reports the port it bound.
  // Each step's limit is sized for a quiet box and stretched by the load while it runs (src/load-stretch.ts, #1514);
  // the backstop above still bounds all the steps together at 3 minutes.
  const base = `http://127.0.0.1:${await within(listeningPort(server, 2 * MAX_STRETCH * 20_000), 20_000, (limit) => `The server did not say which port it listens on within ${limit}`).catch((err) => fail(err.message))}`;

  begin('/api/health');
  let health: any = null;
  const healthy = stepLimit();
  for (; !health; await new Promise((r) => setTimeout(r, 100))) {
    if (server.exitCode !== null) fail(`The server exited during boot (code ${server.exitCode})`);
    if (healthy.over(20_000)) fail(`The server did not answer /api/health within ${healthy.text(20_000)}`);
    health = await fetch(`${base}/api/health`).then(
      (r) => (r.ok ? r.json() : null),
      () => null,
    );
  }
  begin('app page and sign-in');
  const page = await fetch(`${base}/`);
  if (page.status !== 200 || !/<html/i.test(await page.text())) fail(`The app page answered ${page.status}`);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: adminLogin, password }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!login.ok || !cookie) fail(`Signing in answered ${login.status}`);
  begin('render in Chromium');
  await pageCheck(`${base}/`, cookie);
  // A GET the server may answer with a retryable 503 while its readers are slow on a busy box (#2003): asked again, as the page does.
  const get = async (path: string, limit = stepLimit()) => {
    for (;;) {
      const r = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
      if (r.status !== 503 || limit.over(20_000)) return r;
      await r.body?.cancel();
      await new Promise((ok) => setTimeout(ok, 250));
    }
  };
  begin("file viewer's details");
  for (const { what, path } of fileChecks) {
    const r = await get(path);
    const body = await r.text();
    const name = (() => {
      try {
        return JSON.parse(body).name;
      } catch {
        return null;
      }
    })();
    if (!r.ok || name !== 'boot-check.md') fail(`The file viewer's details of ${what} (GET ${path}) answered ${r.status}: ${body.slice(0, 300)}`);
  }
  begin('Taskmaster and minion turns');

  // A person's message starts each turn; the stand-in claude leaves report.json in its folder. Both settle before a
  // failure is reported: the stop below ends the server, not a turn still running (each has its own 30 s, stretched by the load).
  const turns = await Promise.allSettled(
    turnChecks.map(async ({ what, id, dir }) => {
      const sent = await fetch(`${base}/api/tickets/${id}/messages`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Boot check', after: true }),
      });
      if (!sent.ok) fail(`Messaging the ${what} answered ${sent.status}: ${await sent.text()}`);
      const report = join(dir, 'report.json');
      const slow = stepLimit();
      for (; ; await new Promise((r) => setTimeout(r, 100))) {
        const got = await get(`/api/tickets/${id}`, slow);
        if (!got.ok) fail(`Reading the ${what} answered ${got.status}: ${(await got.text()).slice(0, 300)}`);
        const t = (await got.json()).ticket;
        if (t.status !== 'running' && t.status !== 'new') {
          if (!existsSync(report)) fail(`A ${what} turn could not start (${t.status}): ${t.note ?? 'no reason given'}`);
          const r = JSON.parse(readFileSync(report, 'utf8'));
          if (!r.ok) fail(`A ${what} turn started, but: ${r.error}`);
          return console.error(`boot-check: a ${what} turn started (${r.found})`);
        }
        if (slow.over(30_000)) fail(`A ${what} turn did not finish within ${slow.text(30_000)}`);
      }
    }),
  );
  for (const t of turns) if (t.status === 'rejected') throw t.reason;
  begin('');
  console.error(`boot-check: total ${((Date.now() - start) / 1000).toFixed(1)} s`);
  console.log(health.version);
} finally {
  for (const p of procs) p.kill();
  await Promise.all(
    procs.map(
      (p) =>
        p.exitCode !== null ||
        p.signalCode !== null ||
        new Promise((r) => {
          p.once('exit', r);
          setTimeout(r, 5000).unref();
        }),
    ),
  );
  rmSync(root, { recursive: true, force: true });
}

/** The newest Playwright headless Chromium, which this box keeps in ~/.cache/ms-playwright. */
function chromium(): string {
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium_headless_shell-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    const bin = join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (existsSync(bin)) return bin;
  }
  return fail(`No headless Chromium in ${cache} (npx playwright install chromium-headless-shell)`);
}

/** Load the app signed in, over the DevTools protocol: fail on a console error or an empty #app. */
async function pageCheck(url: string, cookie: string) {
  // Over a pipe (fd 3 in, fd 4 out, NUL-separated), not a port: no other local user can reach the
  // signed-in page, which shows a copy of the live chats, and no port can clash with anyone's.
  const chrome = spawn(chromium(), ['--headless', '--remote-debugging-pipe', `--user-data-dir=${join(root, 'chromium')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  procs.push(chrome);
  let chromeLog = '';
  chrome.stderr!.on('data', (d) => (chromeLog += d));
  const [input, output] = [chrome.stdio[3] as Writable, chrome.stdio[4] as Readable];
  let next = 0;
  const pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  const errors: string[] = [];
  const loading = new Set<string>();
  let lastLoad = Date.now();
  let gone: Error | null = null;
  chrome.once('exit', (code) => {
    gone = new Error(`Chromium exited (code ${code}):\n${chromeLog.slice(-2000)}`);
    for (const p of pending.values()) p.no(gone);
  });
  const handle = (m: any) => {
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.error ? p?.no(new Error(`DevTools ${m.error.message}`)) : p?.ok(m.result);
    }
    // What the page still loads, for the render wait; the event stream stays open by design.
    if (m.method === 'Network.requestWillBeSent' && m.params.type !== 'EventSource') {
      loading.add(m.params.requestId);
      lastLoad = Date.now();
    }
    if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && loading.delete(m.params.requestId)) lastLoad = Date.now();
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
    // The copy has the database but not the data folder's files (chat images): an API 404 (/api/ or the app's /c/api/) is that.
    // An API 503 is a slow reader's "ask again" on a busy box (#2003), which the page does.
    const missingData = (e: any) => / (404|503) /.test(e.text) && /^(?:\/c)?\/api\//.test(new URL(e.url ?? url, url).pathname);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !missingData(m.params.entry)) errors.push(`${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
  };
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (d: string) => {
    buf += d;
    for (let i; (i = buf.indexOf('\0')) >= 0; buf = buf.slice(i + 1)) handle(JSON.parse(buf.slice(0, i)));
  });
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((ok, no) => {
      if (gone) return no(gone);
      pending.set(++next, { ok, no });
      input.write(JSON.stringify({ id: next, method, params, sessionId }) + '\0');
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  for (const domain of ['Runtime', 'Log', 'Network', 'Page']) await send(`${domain}.enable`, {}, sessionId);
  const [name, ...value] = cookie.split('=');
  await send('Network.setCookie', { name, value: value.join('='), url }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const app = `(() => { const a = document.querySelector('#app'); return a && !a.querySelector('#login-form') ? a.innerText.trim().length : 0; })()`;
  // The first render waits on several rounds of API calls, each seconds long when the box is loaded, so
  // wait while the page is still loading and fail once it has gone quiet with #app still empty.
  const slow = stepLimit();
  for (; !(await send('Runtime.evaluate', { expression: app, returnByValue: true }, sessionId)).result.value; await new Promise((r) => setTimeout(r, 100))) {
    if (errors.length) break;
    if (!loading.size && slow.over(10_000, lastLoad)) fail(`The app page finished loading but rendered nothing in #app (nothing loading for ${slow.text(10_000)})`);
    if (slow.over(60_000)) fail(`The app page rendered nothing in #app within ${slow.text(60_000)} (still loading: ${loading.size} requests)`);
  }
  // Room for errors that come just after the first render (a view's own imports, its first fetches).
  await new Promise((r) => setTimeout(r, 1000));
  if (errors.length) fail(`The app page logged errors in Chromium:\n${errors.join('\n').slice(0, 3000)}`);
}
