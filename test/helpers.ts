// Shared test plumbing: boot the real server.ts on a scratch data dir and the port it picks.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Auth } from '../src/auth.ts';
import { freePort, listeningPort } from '../src/ports.ts';
import { pinTurnFiles, type TurnPins } from '../src/turn-launch.ts';
import { until } from './wait.ts';
import { settled as settledInProcess } from '../src/settled.ts';
import { isTurnNote } from '../src/codex.ts';

/**
 * The pinned turn files (src/turn-launch.ts) for a test that starts turns or builds their hooks: server.ts
 * makes them at start. Without `dataDir` they go in a scratch folder removed when the process exits.
 */
export function testPins(dataDir?: string): TurnPins {
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), 'test-pins-'));
  if (!dataDir) process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return pinTurnFiles(dir);
}

/**
 * Stop servers a test started and wait until they have exited: a server still finishing its requests
 * can write into its folder while the test deletes it (ENOTEMPTY on a disk-backed TMPDIR, #218).
 */
export async function stopProcs(procs: ChildProcess[]) {
  await Promise.all(procs.map((p) => (p.exitCode !== null || p.signalCode !== null ? undefined : new Promise((r) => { p.once('exit', r); p.kill(); }))));
}

/**
 * Kill every process of this user that names a path in one of `dirs` (a turn's wrapper and claude name
 * its turn folder), then wait until they have gone. Turns are detached so they outlive a server restart;
 * a fake claude still waiting for its release would otherwise run forever once its test has deleted the
 * folder (#271). It goes by the command line, not pid.json: a turn the server started just before it
 * was stopped may not have written that yet.
 */
export async function stopTurns(...dirs: string[]) {
  for (let i = 0; i < 100; i++) {
    const left = procsUnder(dirs);
    if (!left.size) return;
    for (const pid of left.keys()) {
      try {
        process.kill(-pid, 'SIGKILL'); // claude leads a process group of its own, with its tools in it
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Processes under ${dirs.join(', ')} would not exit`);
}

/** This user's live processes with an argument that is, or is inside, one of `dirs`: pid → command line. */
export function procsUnder(dirs: string[]): Map<number, string> {
  const found = new Map<number, string>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (statSync(`/proc/${name}`).uid !== process.getuid!()) continue;
      if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${name}/stat`, 'utf8'))) continue; // exited, not yet reaped
      const args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (args.some((a) => dirs.some((d) => a === d || a.startsWith(`${d}/`)))) found.set(Number(name), args.join(' '));
    } catch {} // gone meanwhile
  }
  return found;
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
/**
 * A stand-in for `claude -p` in `root`: it waits for the release file, ends with its words as its result (an error
 * unless they are "ok"; a FAKE_RESULT in its env, a second account's, wins) and appends the prompt it got to `prompts`.
 * setRelease(null) holds turns running.
 */
export function releaseFake(root: string) {
  const fake = join(root, 'claude-fake');
  const release = join(root, 'release');
  const prompts = join(root, 'prompts.log');
  writeFileSync(
    fake,
    `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
const wait = setInterval(() => {
  if (!input.includes('\\n') || !existsSync(${JSON.stringify(release)})) return;
  clearInterval(wait);
  appendFileSync(${JSON.stringify(prompts)}, input);
  const result = process.env.FAKE_RESULT ?? readFileSync(${JSON.stringify(release)}, 'utf8');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'm-main' }));
  const reply = existsSync(${JSON.stringify(release + '.reply')}) ? [{ type: 'text', text: readFileSync(${JSON.stringify(release + '.reply')}, 'utf8') }] : [];
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: reply, usage: { input_tokens: 5, cache_read_input_tokens: 120000, cache_creation_input_tokens: 2000 } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: result !== 'ok', result, modelUsage: { 'm-grunt': { contextWindow: 200000 }, 'm-main': { contextWindow: 1000000 } } }));
  process.exit(0);
}, 20);
`,
  );
  chmodSync(fake, 0o755);
  /** Sets the release file whole: a fake polling for it would otherwise read it between create and write, empty. */
  const setRelease = (words: string | null) => {
    if (words === null) return rmSync(release, { force: true });
    writeFileSync(`${release}.tmp`, words);
    renameSync(`${release}.tmp`, release);
  };
  /** The words of the turn's one reply (a status trailer, say), or null for none. */
  const setReply = (words: string | null) => (words === null ? rmSync(`${release}.reply`, { force: true }) : writeFileSync(`${release}.reply`, words));
  return { fake, prompts, setRelease, setReply, turnsRun: () => lines(prompts).length };
}

export const jsonLines = (path: string): any[] => lines(path).map((l) => JSON.parse(l));

/** A turn message's blocks without the [System] note of the minion's own lines that opens it (#878), for tests about the rest. */
export const withoutTurnNote = (content: any[]): any[] => content.filter((c) => !isTurnNote(c?.text ?? ''));
export const PASSWORD = 'test-password-123';
export const SECRET = 'x'.repeat(40);

/** The token minion `id`'s current turn holds on the server whose DATA_DIR is `data`. */
export function agentToken(data: string, id: number): string {
  const db = new DatabaseSync(join(data, 'coordinator.db'), { readOnly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`agent-nonce:${id}`) as { value: string } | undefined;
  db.close();
  return new Auth(PASSWORD, SECRET).agentToken(id, row ? JSON.parse(row.value).current ?? undefined : undefined);
}

export { until };

/**
 * Wait until this process's own background work is done (#1437): its DB write workers' queues, session saves and
 * restores, WAL checkpoint rounds, app deploys and their install-check retries. For a test with an in-process Store; a
 * booted server has `srv.settled()`. Throws, naming what was still busy, after `ms`. Only what reports to src/settled.ts
 * counts: other background work (a machine's check, a preview's boot, a turn) needs its own wait, or a track() there.
 */
export async function settled(ms = 30_000): Promise<void> {
  const busy = await settledInProcess(ms);
  if (busy.length) throw new Error(`Still busy after ${ms} ms: ${busy.join(', ')}`);
}

/** A call's answer's body, or a throw naming its status and error: for a test that treats any non-2xx as a failure. */
export function ok(r: { status: number; data: any }): any {
  if (r.status < 200 || r.status >= 300) throw new Error(`${r.status} ${r.data?.error ?? JSON.stringify(r.data)}`);
  return r.data;
}

export type Caller = (path: string, body?: unknown, method?: string) => Promise<{ status: number; data: any }>;

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
  call: Caller;
  /** The same call as someone else: a session `cookie` or a Bearer `token` (a minion's, from `agentToken`). */
  as: (who: { cookie?: string; token?: string }) => Caller;
  /**
   * Wait until the server has finished everything it was doing (#1437): its DB write queue, session saves and restores,
   * WAL checkpoint rounds, app deploys and every request not yet answering. Wait on this, not on a first sign of the
   * work (a row, a log line). Throws, naming what was still busy, after `ms`. Only what reports to src/settled.ts counts:
   * a machine's check, a preview's boot or a turn needs its own wait (or a track() call where it starts).
   */
  settled: (ms?: number) => Promise<void>;
  /**
   * Wait for the server to settle, kill it and its turns (all but `keepTurns`, for a restart), then delete the scratch
   * folder. Throws, after cleaning up, naming what the server was still doing if it didn't settle.
   */
  stop: (opts?: { keepTurns?: boolean }) => Promise<void>;
};

/**
 * Start server.ts (or a copy of it, `script`) on a fresh scratch folder (or `root`, which is then the
 * caller's to delete) and sign in as `name`. Turns can't run (CLAUDE_BIN is /bin/false) unless `env`
 * says otherwise; `env` entries override the defaults, and an undefined one removes it.
 */
export async function bootServer(opts: { env?: NodeJS.ProcessEnv; root?: string; name?: string; stdout?: boolean; script?: string; wrap?: string[]; log?: string } = {}): Promise<Booted> {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'boot-'));
  const data = join(root, 'data');
  // `wrap`: a command the server runs under, that execs it (systemd-run --scope for a CPU limit); `log`: a file its stdout and stderr are appended to.
  const [bin, ...pre] = [...(opts.wrap ?? []), process.execPath];
  const err = opts.log ? openSync(opts.log, 'a') : 'inherit';
  const proc = spawn(bin, [...pre, opts.script ?? join(REPO, 'server.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, PORT: '0', DATA_DIR: data, CLAUDE_BIN: '/bin/false', CITADEL_PSI_CPU: '/nonexistent/psi', CITADEL_PSI_MEMORY: '/nonexistent/psi', // a booted test server never reads the real box's pressure (#1301/#1302): a busy box would pause its indexers and hold its scheduled runs
      CLAUDE_CONFIG_DIR: join(root, 'claude'), COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET,
      // No scheme has id 0, so none is indexed: a test server never calls the box's live embedding service.
      CITADEL_MEMORY_SCHEMES: '0',
      // A CI runner that is itself a systemd service sets INVOCATION_ID, which turns the shared tool server on (#1259):
      // test turns keep their own helpers unless a test asks for the pool.
      TURN_POOL: '0',
      // The background passes (indexers, sweeps) skip while the box's CPU or memory pressure is high (#1301): a test
      // server reads a pressure file that isn't there (no reading, so never starved), or the full suite's own load would
      // hold back the index a test waits on (overlord.test.ts, #1349). A test of the gate passes its own file.
      CITADEL_PSI_CPU: join(root, 'no-psi-cpu'), CITADEL_PSI_MEMORY: join(root, 'no-psi-memory'),
      // GET /api/test/settled, for settled() and stop() below (#1437).
      CITADEL_TEST_SETTLED: '1',
      ...opts.env,
    },
    stdio: ['ignore', 'pipe', err],
  });
  if (typeof err === 'number') closeSync(err);
  let base = '';
  const busy = async (ms = 30_000): Promise<string[]> => {
    const r = await fetch(`${base}/api/test/settled?ms=${ms}`);
    // The route answers before sign-in, so these mean a server without it (CITADEL_TEST_SETTLED unset, or a copy from before it).
    if (r.status === 401 || r.status === 404) return [];
    if (!r.ok) return [`the settled check answered ${r.status}`];
    return (await r.json()).busy;
  };
  const settled = async (ms = 30_000) => {
    const left = await busy(ms);
    if (left.length) throw new Error(`The server was still busy after ${ms} ms: ${left.join(', ')}`);
  };
  const stop = async ({ keepTurns = false } = {}) => {
    // A server killed mid-write leaves its folder half-written; drain first (no maxRetries on the delete standing in for it).
    let left: string[] = [];
    if (base && proc.exitCode === null && proc.signalCode === null) {
      left = await busy().catch((e) => (proc.exitCode === null && proc.signalCode === null ? [`the settled check failed: ${e?.message ?? e}`] : []));
    }
    await stopProcs([proc]);
    if (!keepTurns) await stopTurns(data);
    if (!opts.root) rmSync(root, { recursive: true, force: true });
    if (left.length) throw new Error(`The server was still busy when the test stopped it: ${left.join(', ')}`);
  };
  if (opts.stdout) proc.stdout!.pipe(process.stdout);
  if (opts.log) proc.stdout!.pipe(createWriteStream(opts.log, { flags: 'a' }));
  const port = await listeningPort(proc).catch(async (err) => {
    await stop();
    throw err;
  });
  base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: opts.name ?? 'Cara', password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) {
    await stop();
    throw new Error(`Signing in answered ${login.status} without a cookie`);
  }
  const as = (who: { cookie?: string; token?: string }): Caller => async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(who.cookie ? { Cookie: who.cookie } : {}), ...(who.token ? { Authorization: `Bearer ${who.token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data };
  };
  const call = as({ cookie });
  return { base, port, root, data, proc, cookie, call, as, settled, stop };
}

/** A stand-in systemctl: logs each call to $FAKE_SYSTEMD/calls and keeps units' states as files there (<unit>.failed: its last run failed). */
export function fakeSystemd(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'systemctl');
  writeFileSync(bin, `#!/bin/sh
d="${dir}"; echo "$*" >> "$d/calls"; shift; verb=$1; shift
case $verb in
  show) u=$1; a=inactive; s=dead; e=disabled; l=loaded
    [ -f "$d/$u.active" ] && a=active && s=running; [ -f "$d/$u.enabled" ] && e=enabled; r=success; x=0; t=
    [ -f "$d/$u.failed" ] && a=failed && s=failed && r=exit-code && x=1 && t=@1794380400
    printf 'LoadState=%s\\nActiveState=%s\\nSubState=%s\\nUnitFileState=%s\\nResult=%s\\nExecMainStatus=%s\\nExecMainExitTimestamp=%s\\n' $l $a $s $e $r $x "$t";;
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
  // systemd-run --user --wait for a build step (#847): the unit shows active to the systemctl above while it runs, which
  // runs the command with only the --setenv environment, its output appended to the StandardOutput file.
  const run = join(dir, 'systemd-run');
  writeFileSync(run, `#!/bin/bash
d="${dir}"; echo "run $*" >> "$d/calls"; unit= cwd=. out=/dev/null; envs=()
while [ $# -gt 0 ]; do case $1 in
  --) shift; break;;
  --unit=*) unit=\${1#--unit=};; --working-directory=*) cwd=\${1#--working-directory=};;
  --setenv=*) envs+=("\${1#--setenv=}");; --property=StandardOutput=append:*) out=\${1#--property=StandardOutput=append:};;
esac; shift; done
touch "$d/$unit.active"; trap 'rm -f "$d/$unit.active"' EXIT
(cd "$cwd" && env -i "\${envs[@]}" "$@") >>"$out" 2>&1
`);
  chmodSync(run, 0o755);
  return { bin, journal, run, calls: () => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : []), state: (f: string) => existsSync(join(dir, f)) };
}
