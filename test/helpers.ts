// Shared test plumbing: boot the real server.ts on a scratch data dir and the port it picks.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Auth } from '../src/auth.ts';
import { freePort, listeningPort } from '../src/ports.ts';

/**
 * Stop servers a test started and wait until they have exited: a server still finishing its requests
 * can write into its folder while the test deletes it (ENOTEMPTY on a disk-backed TMPDIR, #218).
 */
export async function stopProcs(procs: ChildProcess[]) {
  await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? undefined : new Promise((r) => { p.once('exit', r); p.kill(); }))));
}

export { freePort, listeningPort };

// Every test request gets a fresh connection. Under load a test's synchronous step can hold its event
// loop past a server's 5 s keep-alive; fetch then sends the next request on the idle socket the server
// closed meanwhile and fails with "other side closed" (#235).
const keepAliveFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const req = new Request(input, init);
  req.headers.set('Connection', 'close');
  return keepAliveFetch(req);
};

export const REPO = join(import.meta.dirname, '..');

/** The lines a fake's log file holds, leaving out a last line it is still writing. */
export function lines(path: string): string[] {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
}
export const jsonLines = (path: string): any[] => lines(path).map((l) => JSON.parse(l));
export const PASSWORD = 'test-password-123';
export const SECRET = 'x'.repeat(40);

/** The token minion `id`'s current turn holds on the server whose DATA_DIR is `data`. */
export function agentToken(data: string, id: number): string {
  const db = new DatabaseSync(join(data, 'coordinator.db'), { readOnly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`agent-nonce:${id}`) as { value: string } | undefined;
  db.close();
  return new Auth(PASSWORD, SECRET).agentToken(id, row ? JSON.parse(row.value).current ?? undefined : undefined);
}

/** Poll `fn` every 50 ms until it returns something truthy, or fail after `ms`. */
export async function until<T>(what: string, fn: () => Promise<T | undefined | null | false> | T | undefined | null | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export type Booted = {
  base: string;
  port: number;
  /** The scratch folder: `data` is the server's DATA_DIR, `claude` its CLAUDE_CONFIG_DIR. */
  root: string;
  data: string;
  proc: ChildProcess;
  /** The session cookie of a person signed in as `name`. */
  cookie: string;
  /** A JSON call as that person: GET without a body, else `method` (POST by default). */
  call: (path: string, body?: unknown, method?: string) => Promise<{ status: number; data: any }>;
  /** Kill the server and delete the scratch folder. */
  stop: () => Promise<void>;
};

/**
 * Start server.ts (or a copy of it, `script`) on a fresh scratch folder (or `root`, which is then the
 * caller's to delete) and sign in as `name`. Turns can't run (CLAUDE_BIN is /bin/false) unless `env`
 * says otherwise; `env` entries override the defaults, and an undefined one removes it.
 */
export async function bootServer(opts: { env?: NodeJS.ProcessEnv; root?: string; name?: string; stdout?: boolean; script?: string } = {}): Promise<Booted> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'boot-'));
  const data = join(root, 'data');
  const proc = spawn(process.execPath, [opts.script ?? join(REPO, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: '0', DATA_DIR: data, CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stop = async () => {
    await stopProcs([proc]);
    if (!opts.root) rmSync(root, { recursive: true, force: true });
  };
  if (opts.stdout) proc.stdout!.pipe(process.stdout);
  const port = await listeningPort(proc).catch(async (err) => {
    await stop();
    throw err;
  });
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: opts.name ?? 'Cara', password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) {
    await stop();
    throw new Error(`Signing in answered ${login.status} without a cookie`);
  }
  const call = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  };
  return { base, port, root, data, proc, cookie, call, stop };
}

/** A stand-in systemctl: logs each call to $FAKE_SYSTEMD/calls and keeps units' states as files there. */
export function fakeSystemd(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'systemctl');
  writeFileSync(bin, `#!/bin/sh
d="${dir}"; echo "$*" >> "$d/calls"; shift; verb=$1; shift
case $verb in
  show) u=$1; a=inactive; s=dead; e=disabled; l=loaded
    [ -f "$d/$u.active" ] && a=active && s=running; [ -f "$d/$u.enabled" ] && e=enabled
    printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nUnitFileState=%s\\n' $l $a $s $e;;
  enable|disable|start|restart|stop) now=; for u; do
      [ "$u" = --now ] && now=1 && continue
      case $verb in enable) touch "$d/$u.enabled"; [ -n "$now" ] && touch "$d/$u.active";;
        disable) rm -f "$d/$u.enabled"; [ -n "$now" ] && rm -f "$d/$u.active";;
        start|restart) touch "$d/$u.active";; stop) rm -f "$d/$u.active";; esac; done;;
  daemon-reload) ;;
  *) echo "unknown $verb" >&2; exit 1;;
esac
exit 0
`);
  chmodSync(bin, 0o755);
  const journal = join(dir, 'journalctl');
  writeFileSync(journal, '#!/bin/sh\necho "journal $*"\n');
  chmodSync(journal, 0o755);
  return { bin, journal, calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []), state: (f: string) => existsSync(join(dir, f)) };
}
