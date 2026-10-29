// Boot check for tools/deploy.sh: syntax-check the front end, start a checkout's server on a spare port
// against a copy of the database, confirm it serves the app, that the app renders in headless Chromium
// without a console error, that its MCP server initializes and reaches the API, and that a minion turn
// and a Taskmaster turn start through the runner's real arguments (with tools/boot-check-claude.ts as
// claude), then stop it. Prints the front-end version it served; exits non-zero with the reason on any
// failure.
//   node tools/boot-check.ts <checkout> <coordinator.db>
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { DatabaseSync, backup } from 'node:sqlite';

const [checkout, db] = process.argv.slice(2);
if (!checkout || !db) throw new Error('usage: boot-check.ts <checkout> <coordinator.db>');
const { Auth } = await import(join(checkout, 'src', 'auth.ts'));
const { Store } = await import(join(checkout, 'src', 'db.ts'));

const root = mkdtempSync(join(tmpdir(), 'citadel-boot-check-'));
const procs: ChildProcess[] = [];
let log = '';
const fail = (why: string): never => {
  throw new Error(`${why}${log ? `\n--- server output ---\n${log.slice(-3000)}` : ''}`);
};

try {
  // A syntax error in any front-end file blanks the app; node --check finds it without a browser.
  const pub = join(checkout, 'public');
  const scripts = readdirSync(pub).filter((f) => /\.m?js$/.test(f));
  const bad = (await Promise.all(scripts.map((f) => promisify(execFile)(process.execPath, ['--check', join(pub, f)]).then(() => null, (err) => `${f}: ${err.stderr.trim()}`)))).filter(Boolean);
  if (bad.length) fail(`Front-end files don't parse:\n${bad.join('\n')}`);

  // A consistent copy even while the live server writes (WAL).
  const copy = join(root, 'coordinator.db');
  const live = new DatabaseSync(db, { readOnly: true });
  await backup(live, copy);
  live.close();

  // The turns to start: the Taskmaster of the scheme with the most minions (the largest arguments)
  // and a new minion there. Both run in folders of their own, never a real worktree, and nothing is
  // held for the usage limit in the copy.
  const turnStore = new Store(copy);
  const busiest = turnStore.db.prepare(`select c.id, c.permission_mode, c.branch from tickets c where c.kind = 'coordinator'
    order by (select count(*) from tickets t where t.project_id = c.project_id) desc limit 1`).get() as any;
  const turnChecks: { what: string; id: number; dir: string }[] = [];
  if (busiest) {
    const project = turnStore.getTicket(busiest.id).project_id;
    const minion = turnStore.createTicket({ project_id: project, title: 'Boot check', permission_mode: busiest.permission_mode, created_by: 'boot-check' });
    for (const [what, id, branch] of [['Taskmaster', busiest.id, busiest.branch], ['minion', minion.id, null]] as const) {
      const dir = join(root, `turn-${id}`);
      mkdirSync(dir);
      turnStore.setTicketDir(id, dir, branch);
      turnChecks.push({ what, id, dir });
    }
    turnStore.deleteSetting('limit-resumes');
  }
  turnStore.db.close();
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dirname, 'boot-check-claude.ts'))} "$@"\n`);
  chmodSync(claude, 0o755);

  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  const base = `http://127.0.0.1:${port}`;
  const password = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const server = spawn(process.execPath, [join(checkout, 'server.ts')], {
    cwd: checkout,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG,
      HOST: '127.0.0.1', PORT: String(port), DATA_DIR: root, BOOT_CHECK: '1', CLAUDE_BIN: claude, TURN_UNITS: '0',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: password, SESSION_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(server);
  server.stdout!.on('data', (d) => (log += d));
  server.stderr!.on('data', (d) => (log += d));

  let health: any = null;
  for (const end = Date.now() + 20_000; !health; await new Promise((r) => setTimeout(r, 100))) {
    if (server.exitCode !== null) fail(`The server exited during boot (code ${server.exitCode})`);
    if (Date.now() > end) fail('The server did not answer /api/health within 20 s');
    health = await fetch(`${base}/api/health`).then((r) => (r.ok ? r.json() : null), () => null);
  }
  const page = await fetch(`${base}/`);
  if (page.status !== 200 || !/<html/i.test(await page.text())) fail(`The app page answered ${page.status}`);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'boot-check', password }) });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  if (!login.ok || !cookie) fail(`Signing in answered ${login.status}`);
  await pageCheck(`${base}/`, cookie);

  // The MCP server a turn would start, run as a ticket of the copy so its tool call goes through the API.
  const store = new DatabaseSync(copy, { readOnly: true });
  const ticket = (store.prepare("select id, project_id, kind from tickets order by kind = 'coordinator' desc, id limit 1").get() ?? null) as any;
  store.close();
  const mcp = spawn(process.execPath, [join(checkout, 'src', 'mcp.ts')], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      COORDINATOR_API: base, COORDINATOR_TOKEN: ticket ? new Auth(password, secret).agentToken(ticket.id) : '',
      COORDINATOR_PROJECT: String(ticket?.project_id ?? 0), COORDINATOR_TICKET: String(ticket?.id ?? 0),
      COORDINATOR_ROLE: ticket?.kind === 'coordinator' ? 'coordinator' : 'thread',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(mcp);
  mcp.stderr!.on('data', (d) => (log += `[mcp] ${d}`));
  const replies = createInterface({ input: mcp.stdout! })[Symbol.asyncIterator]();
  const call = async (id: number, method: string, params: object) => {
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error(`MCP ${method} timed out`)), 10_000).unref());
    const { value, done } = await Promise.race([replies.next(), timeout]);
    if (done) fail(`The MCP server exited before answering ${method}`);
    const reply = JSON.parse(value);
    if (reply.error) fail(`MCP ${method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
  };
  await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'boot-check', version: '1' } });
  const tools = (await call(2, 'tools/list', {})).tools as { name: string }[];
  if (!tools?.length) fail('The MCP server listed no tools');
  if (ticket) {
    // list_tickets (Taskmaster) or list_properties (minion): both read through the API with the token.
    const name = ticket.kind === 'coordinator' ? 'list_tickets' : 'list_properties';
    const result = await call(3, 'tools/call', { name, arguments: {} });
    if (result.isError) fail(`MCP ${name} failed: ${JSON.stringify(result.content)}`);
  }

  // A person's message starts each turn; the stand-in claude leaves report.json in its folder.
  await Promise.all(turnChecks.map(async ({ what, id, dir }) => {
    const ticket = async () => (await fetch(`${base}/api/tickets/${id}`, { headers: { Cookie: cookie } }).then((r) => r.json())).ticket;
    const sent = await fetch(`${base}/api/tickets/${id}/messages`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Boot check', after: true }),
    });
    if (!sent.ok) fail(`Messaging the ${what} answered ${sent.status}: ${await sent.text()}`);
    const report = join(dir, 'report.json');
    for (const end = Date.now() + 30_000; ; await new Promise((r) => setTimeout(r, 100))) {
      const t = await ticket();
      if (t.status !== 'running' && t.status !== 'new') {
        if (!existsSync(report)) fail(`A ${what} turn could not start (${t.status}): ${t.note ?? 'no reason given'}`);
        const r = JSON.parse(readFileSync(report, 'utf8'));
        if (!r.ok) fail(`A ${what} turn started, but: ${r.error}`);
        return console.error(`boot-check: a ${what} turn started (${r.found})`);
      }
      if (Date.now() > end) fail(`A ${what} turn did not finish within 30 s`);
    }
  }));
  console.log(health.version);
} finally {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exitCode !== null || p.signalCode !== null || new Promise((r) => { p.once('exit', r); setTimeout(r, 5000).unref(); })));
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
  // Port 0: Chromium takes a free port at random and says which, so nothing else's browser is reached.
  const chrome = spawn(chromium(), ['--headless', '--remote-debugging-port=0', `--user-data-dir=${join(root, 'chromium')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(chrome);
  let chromeLog = '';
  const endpoint = await new Promise<string>((ok, no) => {
    const t = setTimeout(() => no(new Error(`Chromium did not start within 15 s:\n${chromeLog.slice(-2000)}`)), 15_000);
    chrome.stderr!.on('data', (d) => {
      chromeLog += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(chromeLog);
      if (m) clearTimeout(t), ok(m[1]);
    });
    chrome.once('exit', (code) => (clearTimeout(t), no(new Error(`Chromium exited (code ${code}):\n${chromeLog.slice(-2000)}`))));
  });
  const ws = new WebSocket(endpoint);
  await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = () => no(new Error('Could not reach Chromium over DevTools')))));
  let next = 0;
  const pending = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  const errors: string[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.error ? p?.no(new Error(`DevTools ${m.error.message}`)) : p?.ok(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description).join(' ')}`);
    // The copy has the database but not the data folder's files (chat images): an API 404 is that.
    const missingData = (e: any) => / 404 /.test(e.text) && new URL(e.url ?? url, url).pathname.startsWith('/api/');
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !missingData(m.params.entry)) errors.push(`${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url})` : ''}`);
  };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((ok, no) => {
    pending.set(++next, { ok, no });
    ws.send(JSON.stringify({ id: next, method, params, sessionId }));
  });
  try {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (const domain of ['Runtime', 'Log', 'Network', 'Page']) await send(`${domain}.enable`, {}, sessionId);
    const [name, ...value] = cookie.split('=');
    await send('Network.setCookie', { name, value: value.join('='), url }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    const app = `(() => { const a = document.querySelector('#app'); return a && !a.querySelector('#login-form') ? a.innerText.trim().length : 0; })()`;
    for (const end = Date.now() + 15_000; !(await send('Runtime.evaluate', { expression: app, returnByValue: true }, sessionId)).result.value; await new Promise((r) => setTimeout(r, 100))) {
      if (errors.length) break;
      if (Date.now() > end) fail('The app page loaded but rendered nothing in #app within 15 s');
    }
    // Room for errors that come just after the first render (a view's own imports, its first fetches).
    await new Promise((r) => setTimeout(r, 1000));
    if (errors.length) fail(`The app page logged errors in Chromium:\n${errors.join('\n').slice(0, 3000)}`);
  } finally {
    ws.close();
  }
}
