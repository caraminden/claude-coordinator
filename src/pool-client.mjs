// The turn wrapper's side of the shared tool server (#1259, src/mcp-pool.ts): find its place's pool for the turn's
// pinned version, start it if none runs, and keep the turn registered with it. Self-contained apart from node:
// turn-launch pins it beside turn-wrapper.mjs. Plain JS with JSDoc types, like the wrapper: a .ts file makes node load its
// TypeScript stripper, about 18 MB in every turn's wrapper (#1343).
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Where one version's pool lives and how to start it; `systemdRun` (the host) runs it in its own unit, so it outlives the turn that started it.
 * @typedef {{ dir: string, script: string, node: string, version: string, env: Record<string, string>, systemdRun?: string[] }} PoolSpec
 */
/** @typedef {{ pid: number, port: number, key: string, version: string }} PoolInfo */
/** @typedef {{ env: Record<string, string | undefined>, cwd: string }} TurnReg */

/**
 * `pid` runs a pool; its pid reused by another process doesn't count (where /proc can't say, a live pid does).
 * @param {number} pid @returns {boolean}
 */
export function poolAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EPERM') return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('mcp-pool');
  } catch {
    return true;
  }
}

/**
 * The pool running in `dir`, or null when none is (no pool.json, or its process is gone).
 * @param {string} dir @returns {PoolInfo | null}
 */
export function readPool(dir) {
  try {
    const p = JSON.parse(readFileSync(join(dir, 'pool.json'), 'utf8'));
    return Number.isInteger(p.pid) && Number.isInteger(p.port) && typeof p.key === 'string' && poolAlive(p.pid) ? p : null;
  } catch {
    return null;
  }
}

/** @param {PoolInfo} p @param {string} version @returns {Promise<boolean>} */
async function healthy(p, version) {
  try {
    const r = await call(p.port, 'GET', '/health');
    const h = r.status === 200 ? JSON.parse(r.text) : null;
    return h?.pid === p.pid && h?.version === version;
  } catch {
    return false;
  }
}

/**
 * One request to the pool on this host. node:http, not fetch: fetch's client adds about 15 MB to every turn's wrapper.
 * @param {number} port @param {string} method @param {string} path @param {Record<string, string>} [headers] @param {string} [body]
 * @returns {Promise<{ status: number, text: string }>}
 */
function call(port, method, path, headers = {}, body) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: 3000 }, (res) => {
      let text = '';
      res
        .setEncoding('utf8')
        .on('data', (c) => (text += c))
        .on('end', () => done({ status: res.statusCode ?? 0, text }))
        .on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('timed out'))).on('error', fail);
    req.end(body);
  });
}

/**
 * This place's pool for `spec.version`, started if none answers; throws if it can't start within about 20 s (a loaded box is slow to load it).
 * @param {PoolSpec} spec @returns {Promise<PoolInfo>}
 */
export async function ensurePool(spec) {
  mkdirSync(spec.dir, { recursive: true, mode: 0o700 });
  const lock = join(spec.dir, 'start.lock');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const p = readPool(spec.dir);
    if (p && (await healthy(p, spec.version))) return p;
    let fd;
    try {
      fd = openSync(lock, 'wx');
    } catch {
      // Another turn is starting it; a lock left by a starter that died is stale after 25 s.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 25_000) unlinkSync(lock);
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

/** @param {PoolSpec} spec */
function start(spec) {
  const argv = [spec.node, spec.script, spec.dir, spec.version];
  // The pool gets only these, never a turn's secrets: each turn's env comes with its registration.
  if (spec.systemdRun) {
    const env = Object.entries(spec.env).flatMap(([k, v]) => ['-E', `${k}=${v}`]);
    spawn('systemd-run', [...spec.systemdRun, ...env, ...argv], { stdio: 'ignore' }).on('error', () => {});
  } else {
    spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', env: spec.env })
      .on('error', () => {})
      .unref();
  }
}

/**
 * Tell the pool who `token` is; it forgets a turn not registered again within its TTL. Throws on any refusal.
 * @param {PoolInfo} pool @param {string} token @param {TurnReg} reg @returns {Promise<void>}
 */
export async function registerTurn(pool, token, reg) {
  const r = await call(pool.port, 'POST', '/register', { 'X-Pool-Key': pool.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, JSON.stringify(reg));
  if (r.status >= 300) throw new Error(`the shared tool server refused the turn (${r.status}): ${r.text}`);
}

/**
 * One beat of a turn's wrapper: its pool is up (started again if it died) and knows the turn.
 * @param {PoolSpec} spec @param {string} token @param {TurnReg} reg @returns {Promise<PoolInfo>}
 */
export async function keepTurn(spec, token, reg) {
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
