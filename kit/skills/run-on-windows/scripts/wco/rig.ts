// Citadel as an installed app with the title bar overlay (WCO) on the Windows test box: the perigee side.
// Run from a Citadel worktree (the one whose code you test); the run-on-windows skill says when and how.
//   node rig.ts up                 a dev copy (empty data, seeded), the fixture contraption, tailnet ports; prints the box command
//   node rig.ts status             whether the box driver is installed and waiting
//   node rig.ts run <check> [route ...]   checks/<check>.js in the app window, over those routes (default: a scheme page,
//                                  a page with Citadel's .topbar, an artifact page); prints PASS/FAIL lines, saves shots
//   node rig.ts js '<code>'        one snippet there, with checks/lib.js's helpers
//   node rig.ts reload             SIGHUP the dev copy (it reads public/ at boot) and reload the app page, after editing public/
//   node rig.ts down               ends the box driver, this rig's server and the dev copy; prints the box's cleanup
//   node rig.ts serve              (what up starts) fixture pages, the box's files and its command queue on one tailnet
//                                  port, and a raw forward to the dev copy on another
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type ServerResponse } from 'node:http';
import { createServer as tcpServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = import.meta.dirname;
const DIR = join(process.env.TMPDIR || tmpdir(), 'wco-rig');
const STATE = join(DIR, 'state.json');
const SHOTS = join(DIR, 'shots');
const TOPBAR_ROUTE = '#/p/99999'; // a route error: Citadel shows its own .topbar there
interface State {
  token: string;
  host: string;
  rigPort: number;
  fwdPort: number;
  devPort: number;
  devPid: number;
  cookie: string;
  login: string;
  password: string;
  data: string;
  serverPid: number;
  scheme: string;
  minion: string;
  artifact: string;
}

const state = (): State => {
  if (!existsSync(STATE)) die('no rig running from this $TMPDIR: node rig.ts up first');
  return JSON.parse(readFileSync(STATE, 'utf8'));
};
function die(msg: string): never {
  console.error(`rig: ${msg}`);
  process.exit(2);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const local = (s: State, p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.rigPort}/${s.token}/${p}`, init);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const devCopy = (...args: string[]) => execFileSync('citadel-dev-copy', args, { encoding: 'utf8', env: { ...process.env, ...(args[0] === 'seed' ? { WCO_FIXTURE_PORT: String(state().rigPort) } : {}) } });

/** Listens on a random free port in 8100-8999 on every interface: the tailnet reaches 8000-8999 on perigee. */
async function listenTailnet(server: Server): Promise<number> {
  for (;;) {
    const p = 8100 + Math.floor(Math.random() * 900);
    if (p === 8573) continue;
    const ok = await new Promise<boolean>((res) => {
      server.once('error', () => res(false));
      server.listen(p, '0.0.0.0', () => res(true));
    });
    if (ok) return p;
  }
}

async function up() {
  if (existsSync(STATE) && alive(state().serverPid)) die('a rig is already up from this $TMPDIR: node rig.ts down first');
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  console.log(
    devCopy('start', '--data', 'empty')
      .split('\n')
      .filter((l) => !/password|cookie/i.test(l))
      .join('\n'),
  );
  const dev = JSON.parse(devCopy('status', '--json'));
  // RIG_HOST (perigee.tail59477f.ts.net) for a turn with no tailscale command, such as one in a container.
  const host = process.env.RIG_HOST ?? (JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' })).Self.DNSName as string).replace(/\.$/, '');
  writeFileSync(STATE, JSON.stringify({ token: randomBytes(12).toString('hex'), host, devPort: dev.port, devPid: dev.pid, cookie: dev.cookie, login: dev.login, password: dev.password, data: dev.data }));
  const log = openSync(join(DIR, 'server.log'), 'a');
  const server = spawn(process.execPath, [join(HERE, 'rig.ts'), 'serve'], { detached: true, stdio: ['ignore', log, log] });
  server.unref();
  for (let i = 0; i < 50 && !state().rigPort; i++) await sleep(200);
  if (!state().rigPort) die(`the rig server didn't start: ${join(DIR, 'server.log')}`);
  console.log(devCopy('seed', 'wco-fixture').trim());
  const db = new DatabaseSync(join(state().data, 'coordinator.db'), { readOnly: true });
  const scheme = db.prepare("SELECT id FROM projects WHERE name = 'Seeded'").get() as { id: number };
  const t = db.prepare("SELECT id, number FROM tickets WHERE title = 'WCO rig artifact' ORDER BY id DESC").get() as { id: number; number: number };
  const a = db.prepare('SELECT id FROM artifacts WHERE ticket_id = ?').get(t.id) as { id: number };
  db.close();
  const s = { ...state(), scheme: `#/p/${scheme.id}`, minion: `#/p/${scheme.id}/t/${t.number}`, artifact: `#/a/${a.id}` };
  writeFileSync(STATE, JSON.stringify(s));
  const u = `http://${s.host}:${s.rigPort}/${s.token}`;
  console.log(`\nRig up: fixture at /apps/wco-fixture/, routes ${s.scheme} ${TOPBAR_ROUTE} ${s.artifact}. On the box, start the driver (it holds the screen):`);
  console.log(
    JSON.stringify({
      task: 'run',
      wait: 5,
      args: [`$u = '${u}'; $d = Join-Path $env:TEMP 'citadel-wco'; New-Item -ItemType Directory -Force $d | Out-Null; foreach ($f in 'driver.mjs','mouse.ps1','cleanup.ps1') { Invoke-WebRequest -UseBasicParsing \"$u/$f\" -OutFile (Join-Path $d $f) }; node (Join-Path $d 'driver.mjs') $u`],
    }),
  );
  console.log("Then: node rig.ts status (installs in about 20 s), node rig.ts run topbar; node rig.ts down prints the box's cleanup.");
}

async function serve() {
  const s = state();
  const queue: { id: number; code: string }[] = [];
  const results = new Map<number, string>();
  const waiters: (() => void)[] = [];
  const wake = () => waiters.splice(0).forEach((w) => w());
  const until = (ok: () => boolean, ms: number) =>
    new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      const check = () => (ok() ? (clearTimeout(t), res()) : waiters.push(check));
      check();
    });
  let driver = { ready: false, error: '', polled: 0 };
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', ps1: 'text/plain', css: 'text/css', svg: 'image/svg+xml' };
  const file = (res: ServerResponse, f: string) => {
    if (!existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[f.split('.').pop()!] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(f).pipe(res);
  };
  const body = (req: import('node:http').IncomingMessage) =>
    new Promise<Buffer>((res) => {
      const b: Buffer[] = [];
      req.on('data', (c) => b.push(c)).on('end', () => res(Buffer.concat(b)));
    });
  const http = httpServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    // The dev copy proxies /apps/wco-fixture/<path> here as it is.
    const fx = /^\/apps\/wco-fixture\/([\w-]*(?:\.\w+)?)$/.exec(url.pathname);
    if (fx) return file(res, join(HERE, 'fixture', fx[1] || 'index.html'));
    const [, token, what, arg] = url.pathname.split('/');
    if (token !== s.token) return res.writeHead(404).end();
    if (['driver.mjs', 'mouse.ps1', 'cleanup.ps1'].includes(what)) return file(res, join(HERE, what));
    if (what === 'config') return res.writeHead(200).end(JSON.stringify({ upstream: `${s.host}:${state().fwdPort}`, cookie: s.cookie, login: s.login, password: s.password, route: state().scheme }));
    if (what === 'ready') {
      const e = (await body(req)).toString();
      driver = { ...driver, ready: !e, error: e };
      wake();
      return res.end('ok');
    }
    if (what === 'status') return res.end(JSON.stringify({ ...driver, polledAgo: driver.polled ? Date.now() - driver.polled : null, queued: queue.length }));
    if (what === 'shot') {
      writeFileSync(join(SHOTS, `${decodeURIComponent(arg).replace(/[^\w .-]/g, '_')}.png`), await body(req));
      return res.end('ok');
    }
    if (what === 'cmd' && req.method === 'POST') {
      const cmd = { id: (queue.at(-1)?.id ?? 0) + 1, code: (await body(req)).toString() };
      queue.push(cmd);
      wake();
      return res.end(String(cmd.id));
    }
    if (what === 'next') {
      driver.polled = Date.now();
      const after = Number(url.searchParams.get('after'));
      await until(() => queue.some((c) => c.id > after), 25_000);
      driver.polled = Date.now();
      const next = queue.find((c) => c.id > after);
      return next ? res.writeHead(200).end(JSON.stringify(next)) : res.writeHead(204).end();
    }
    if (what === 'result' && req.method === 'POST') {
      results.set(+arg, (await body(req)).toString());
      wake();
      return res.end('ok');
    }
    if (what === 'result') {
      await until(() => results.has(+arg), 25_000);
      return results.has(+arg) ? res.end(results.get(+arg)) : res.writeHead(204).end();
    }
    res.writeHead(404).end();
  });
  const fwd = tcpServer((c) => {
    const u = connect(s.devPort, '127.0.0.1');
    c.pipe(u).pipe(c);
    c.on('error', () => u.destroy());
    u.on('error', () => c.destroy());
  });
  const rigPort = await listenTailnet(http);
  const fwdPort = await listenTailnet(fwd);
  writeFileSync(STATE, JSON.stringify({ ...state(), rigPort, fwdPort, serverPid: process.pid }));
  console.log(`rig server: fixture and box queue on ${rigPort}, dev copy forward on ${fwdPort}`);
  // Ends with the dev copy it fronts.
  setInterval(() => {
    if (!alive(s.devPid)) process.exit(0);
  }, 5000);
}

async function queue(code: string): Promise<{ ok: boolean; text: string }> {
  const s = state();
  const st = JSON.parse(await (await local(s, 'status')).text());
  if (st.error) die(`the box driver stopped: ${st.error}`);
  if (!st.polledAgo || st.polledAgo > 60_000) die("the box driver isn't polling: start it with the run_task line rig.ts up printed, then node rig.ts status");
  const id = await (await local(s, 'cmd', { method: 'POST', body: code })).text();
  for (let i = 0; i < 40; i++) {
    // 40 long polls of 25 s: a check gets about 16 minutes
    const r = await local(s, `result/${id}`);
    if (r.status === 200) return (await r.json()) as { ok: boolean; text: string };
  }
  die(`no answer to command ${id} from the box in 16 minutes`);
}

/** lib.js, the check, and the routes it runs over, as one snippet; the check's PASS/FAIL lines come back. */
const snippet = (body: string, routes: string[]) => {
  const s = state();
  return [`const ROUTES = ${JSON.stringify(routes)}, MINION = ${JSON.stringify(s.minion)};`, readFileSync(join(HERE, 'checks', 'lib.js'), 'utf8'), body, 'return report();'].join('\n');
};

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'up') await up();
else if (cmd === 'serve') await serve();
else if (cmd === 'status') {
  const s = state();
  console.log(await (await local(s, 'status')).text());
} else if (cmd === 'run' || cmd === 'js') {
  const s = state();
  if (!rest[0]) die(`usage: node rig.ts ${cmd === 'run' ? 'run <check> [route ...]' : "js '<code>'"}`);
  const routes = cmd === 'run' && rest.length > 1 ? rest.slice(1) : [s.scheme, TOPBAR_ROUTE, s.artifact];
  const body = cmd === 'run' ? readFileSync(join(HERE, 'checks', `${rest[0].replace(/\.js$/, '')}.js`), 'utf8') : `note(await (async () => { ${rest.join(' ')} })());`;
  const out = await queue(snippet(body, routes));
  console.log(out.text);
  console.log(`shots: ${SHOTS}`);
  process.exit(!out.ok || /^FAIL /m.test(out.text) ? 1 : 0);
} else if (cmd === 'reload') {
  process.kill(state().devPid, 'SIGHUP');
  await sleep(1500);
  const out = await queue(snippet("await ev('setTimeout(() => location.reload(), 50); return 1'); await sleep(4000); note('reloaded');", []));
  console.log(out.ok ? 'dev copy reloaded public/, and the app page reloaded' : out.text);
} else if (cmd === 'down') {
  const s = state();
  if (alive(s.serverPid)) {
    await local(s, 'cmd', { method: 'POST', body: 'quit' }).catch(() => {});
    await sleep(3000); // the driver's next poll takes the quit
    process.kill(s.serverPid);
  }
  console.log(devCopy('stop').trim());
  // The driver fetched cleanup.ps1 beside itself, so this works with the rig server gone; it runs from a copy, since it removes that folder.
  console.log(`Shots stay in ${SHOTS}. Now clean the box:`);
  // -Run names this rig's driver (its command line holds the URL), so the cleanup ends this run and no other minion's.
  const runUrl = `http://${s.host}:${s.rigPort}/${s.token}`;
  console.log(JSON.stringify({ task: 'build', args: [`$c = Join-Path $env:TEMP 'citadel-wco-cleanup-${s.token.slice(0, 6)}.ps1'; Copy-Item (Join-Path $env:TEMP 'citadel-wco\\cleanup.ps1') $c; powershell -NoProfile -ExecutionPolicy Bypass -File $c -Run '${runUrl}'; Remove-Item $c`] }));
} else die('usage: node rig.ts up | status | run <check> [route ...] | js <code> | reload | down');
