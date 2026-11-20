// The turn wrapper's side of the shared tool server (#1259, src/mcp-pool.ts): find its place's pool for the turn's
// pinned version, start it if none runs, and keep the turn registered with it. Self-contained apart from node:
// turn-launch pins it beside turn-wrapper.ts.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Where one version's pool lives and how to start it; `systemdRun` (the host) runs it in its own unit, so it outlives the turn that started it. */
export type PoolSpec = { dir: string; script: string; node: string; version: string; env: Record<string, string>; systemdRun?: string[] };
export type PoolInfo = { pid: number; port: number; key: string; version: string };
export type TurnReg = { env: Record<string, string | undefined>; cwd: string };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
};

/** The pool running in `dir`, or null when none is (no pool.json, or its process is gone). */
export function readPool(dir: string): PoolInfo | null {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8'));
    return Number.isInteger(p.pid) && Number.isInteger(p.port) && typeof p.key === 'string' && alive(p.pid) ? p : null;
  } catch {
    return null;
  }
}

async function healthy(p: PoolInfo, version: string): Promise<boolean> {
  const r = await fetch(`http://127.0.0.1:${p.port}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  const h = r?.ok ? await r.json().catch(() => null) : null;
  return h?.pid === p.pid && h?.version === version;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** This place's pool for `spec.version`, started if none answers; throws if it can't start within about 10 s. */
export async function ensurePool(spec: PoolSpec): Promise<PoolInfo> {
  mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
  const lock = join(spec.dir, 'start.lock');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const p = readPool(spec.dir);
    if (p && (await healthy(p, spec.version))) return p;
    let fd: number | null = null;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      // Another turn is starting it; a lock left by a starter that died is stale after 15 s.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15_000) unlinkSync(lock);
      } catch {}
      await sleep(200);
      continue;
    }
    try {
      const again = readPool(spec.dir);
      if (!(again && (await healthy(again, spec.version)))) {
        start(spec);
        while (Date.now() < deadline) {
          const p = readPool(spec.dir);
          if (p && (await healthy(p, spec.version))) return p;
          await sleep(100);
        }
      }
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {}
    }
  }
  throw new Error(`the shared tool server in ${spec.dir} did not start`);
}

function start(spec: PoolSpec) {
  const argv = [spec.node, spec.script, spec.dir, spec.version];
  // The pool gets only these, never a turn's secrets: each turn's env comes with its registration.
  if (spec.systemdRun) {
    const env = Object.entries(spec.env).flatMap(([k, v]) => ['-E', `${k}=${v}`]);
    spawn('systemd-run', [...spec.systemdRun, ...env, ...argv], { stdio: 'ignore' }).on('error', () => {});
  } else {
    spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', env: spec.env }).on('error', () => {}).unref();
  }
}

/** Tell the pool who `token` is; it forgets a turn not registered again within its TTL. Throws on any refusal. */
export async function registerTurn(pool: PoolInfo, token: string, reg: TurnReg): Promise<void> {
  const r = await fetch(`http://127.0.0.1:${pool.port}/register`, {
    method: 'POST',
    headers: { 'X-Pool-Key': pool.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(reg),
    signal: AbortSignal.timeout(3000),
  });
  if (!r.ok) throw new Error(`the shared tool server refused the turn (${r.status}): ${await r.text().catch(() => '')}`);
}

/** One beat of a turn's wrapper: its pool is up (started again if it died) and knows the turn. */
export async function keepTurn(spec: PoolSpec, token: string, reg: TurnReg): Promise<PoolInfo> {
  const p = readPool(spec.dir);
  if (p) {
    try {
      await registerTurn(p, token, reg);
      return p;
    } catch {}
  }
  const fresh = await ensurePool(spec);
  await registerTurn(fresh, token, reg);
  return fresh;
}
