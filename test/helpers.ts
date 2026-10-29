// Shared test plumbing: boot the real server.ts on a scratch data dir and a free port.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO = join(import.meta.dirname, '..');
export const PASSWORD = 'test-password-123';
export const SECRET = 'x'.repeat(40);

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as any;
  await new Promise((r) => srv.close(r));
  return port;
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
  stop: () => void;
};

/**
 * Start server.ts on a fresh scratch folder (or `root`) and sign in as `name`. Turns can't run
 * (CLAUDE_BIN is /bin/false) unless `env` says otherwise; `env` entries override the defaults.
 */
export async function bootServer(opts: { env?: NodeJS.ProcessEnv; root?: string; name?: string; stdout?: boolean } = {}): Promise<Booted> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'boot-'));
  const data = join(root, 'data');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(REPO, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: String(port), DATA_DIR: data, CLAUDE_BIN: '/bin/false',
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
      ...opts.env,
    },
    stdio: ['ignore', opts.stdout ? 'inherit' : 'ignore', 'inherit'],
  });
  const stop = () => {
    proc.kill();
    if (!opts.root) rmSync(root, { recursive: true, force: true });
  };
  let cookie = '';
  for (const end = Date.now() + 10_000; !cookie; await new Promise((r) => setTimeout(r, 50))) {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: opts.name ?? 'Cara', password: PASSWORD }),
    }).catch(() => undefined);
    if (res) cookie = res.headers.get('set-cookie')!.split(';')[0];
    else if (Date.now() > end || proc.exitCode !== null) {
      stop();
      throw new Error('Timed out waiting for the server');
    }
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
