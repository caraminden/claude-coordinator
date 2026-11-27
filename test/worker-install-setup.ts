// Shared setup of worker-install.test.ts and its parts (#2208): the file is split so no one test file sets the suite's length.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempRoot } from './helpers.ts';

export const repo = join(import.meta.dirname, '..');

export const scripts = join(repo, 'tools', 'worker');

export const TOKEN = `ccm_7_${'x'.repeat(43)}`;

export const scratch = tempRoot('worker-install-');

export const bin = join(scratch.dir, 'bin');

export const server = createServer((req, res) => {
  const file = { '/worker-agent.mjs': 'public/worker-agent.mjs', '/worker-setup/citadel-worker': 'tools/worker/citadel-worker' }[req.url ?? ''];
  if (!file) return res.writeHead(404).end();
  res.end(readFileSync(join(repo, file)));
});

export let base: string;

export function stub(name: string, body: string) {
  writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

before(async () => {
  mkdirSync(bin);
  stub('id', '[ "$*" = -u ] && { echo 0; exit; }; [ -f "$CITADEL_TEST_ROOT/users" ] || exit 1; echo 1001');
  stub('uname', 'echo "${ARCH:-x86_64}"');
  stub('useradd', 'echo "useradd $*" >> "$LOG"; touch "$CITADEL_TEST_ROOT/users"; mkdir -p "$CITADEL_TEST_ROOT/home/citadel-worker"');
  stub('chown', 'echo "chown $1 ${2##*/}" >> "$LOG"');
  stub('install', 'a=(); while [ $# -gt 0 ]; do case $1 in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; /usr/bin/env -i PATH=/usr/bin:/bin install "${a[@]}"');
  // As the worker's user: the service it starts says it connected, unless the test has it fail.
  stub('runuser', '[ "$1 $2 $3" = "-u citadel-worker --" ] || exit 9; shift 3; echo "as ${*##*/}" >> "$LOG.user"; exec "$@"');
  stub('systemctl', 'echo "systemctl $*" >> "$LOG"; [ "$*" != "--user restart citadel-worker" ] || echo "${SAYS-Connected to http://x as pc}" >> "$CITADEL_TEST_ROOT/home/citadel-worker/worker.log"');
  stub('loginctl', 'echo "loginctl $*" >> "$LOG"');
  stub('apt-get', 'echo "apt-get $*" >> "$LOG"');
  for (const c of ['newuidmap', 'findmnt', 'sudo']) stub(c, 'exit 0');
  stub('visudo', 'echo "visudo $*" >> "$LOG"; exit "${VISUDO:-0}"');
  stub('getconf', '[ "$1" = _NPROCESSORS_ONLN ] && echo "${THREADS:-16}"');
  stub('podman', 'echo "podman $*" >> "$LOG"');
  base = `http://127.0.0.1:${await scratch.serve(server)}`;
});

after(() => scratch.teardown());

export let n = 0;

/** A PC: a plain Linux one, or (wsl) a fresh distro with Windows' drives still there. */
export function pc({ wsl = false } = {}) {
  const r = join(scratch.dir, `pc${n++}`);
  for (const d of ['etc/systemd/system', 'proc/sys/kernel', 'run/systemd/system', 'usr/local/bin', 'usr/lib/systemd/system', 'run/user/1001', ...(wsl ? ['run/WSL'] : [])]) mkdirSync(join(r, d), { recursive: true });
  writeFileSync(join(r, 'proc/sys/kernel/osrelease'), wsl ? '6.6.1-microsoft-standard-WSL2\n' : '6.8.0-generic\n');
  writeFileSync(join(r, 'usr/lib/systemd/system/systemd-timesyncd.service'), '');
  writeFileSync(join(r, 'proc/meminfo'), 'MemTotal:       32819560 kB\nMemFree:         1000 kB\n');
  const log = join(r, 'log');
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string }>((done) => {
      const child = scratch.spawn('bash', [script, ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: r, LOG: log, CITADEL_TEST_ROOT: r, CITADEL_TEST_WAIT: '2', ...env } });
      let out = '';
      for (const s of [child.stdout!, child.stderr!]) s.on('data', (c) => (out += c));
      child.on('close', (code) => done({ code: code ?? -1, out }));
    });
  const read = (f: string) => readFileSync(join(r, f), 'utf8');
  return {
    r,
    run,
    read,
    install: (args: string[] = [], env: Record<string, string> = { CC_MACHINE_TOKEN: TOKEN }) => run(join(scripts, 'install-worker.sh'), [`${base}/`, ...args], env),
    logged: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    mode: (f: string) => (statSync(join(r, f)).mode & 0o777).toString(8),
  };
}
