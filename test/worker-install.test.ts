// The worker's installer and helper (Build 7 T5, tools/worker/) run as root on a person's PC, where nothing can be tried
// before it ships. Here they run for real in a temporary root against a fake Citadel, with root-only commands stubbed
// (as test/runner-linux-scripts.test.ts does); the PowerShell one is checked as text, beside ps1-lint.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempRoot } from './helpers.ts';

const repo = join(import.meta.dirname, '..');
const scripts = join(repo, 'tools', 'worker');
const TOKEN = `ccm_7_${'x'.repeat(43)}`;
const scratch = tempRoot('worker-install-');
const bin = join(scratch.dir, 'bin');
const server = createServer((req, res) => {
  const file = { '/worker-agent.mjs': 'public/worker-agent.mjs', '/worker-setup/citadel-worker': 'tools/worker/citadel-worker' }[req.url ?? ''];
  if (!file) return res.writeHead(404).end();
  res.end(readFileSync(join(repo, file)));
});
let base: string;

function stub(name: string, body: string) {
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
  stub('getconf', '[ "$1" = _NPROCESSORS_ONLN ] && echo 16');
  stub('podman', 'echo "podman $*" >> "$LOG"');
  base = `http://127.0.0.1:${await scratch.serve(server)}`;
});
after(() => scratch.teardown());

let n = 0;
/** A PC: a plain Linux one, or (wsl) a fresh distro with Windows' drives still there. */
function pc({ wsl = false } = {}) {
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

test('on a Windows PC the clock is turned off before anything else, then Windows is put out of reach, then it stops for a restart', async () => {
  const p = pc({ wsl: true });
  const first = await p.install();
  assert.equal(first.code, 10, first.out);
  assert.equal(p.logged(), 'systemctl mask --now systemd-timesyncd\n', 'nothing at all before it, and nothing more this time');
  assert.match(p.read('etc/wsl.conf'), /\[automount\]\nenabled=false\nmountFsTab=false\n[^]*\[interop\]\nenabled=false\nappendWindowsPath=false/);
  assert.equal(existsSync(join(p.r, 'users')), false);

  // Restarted, but Windows is still there: refused before anything is installed.
  mkdirSync(join(p.r, 'mnt/c/Windows'), { recursive: true });
  const reached = await p.install();
  assert.equal(reached.code, 1);
  assert.match(reached.out, /C: is still mounted/);
  assert.equal(existsSync(join(p.r, 'users')), false);
});

test('a plain Linux PC keeps its clock and its settings, and gets the worker: its user, caps, token and service', async () => {
  const p = pc();
  const done = await p.install(['--workers', '3', '--threads', '4', '--memory', '10', '--disk', '80']);
  assert.equal(done.code, 0, done.out);
  assert.doesNotMatch(p.logged(), /timesyncd/);
  assert.equal(existsSync(join(p.r, 'etc/wsl.conf')), false);
  assert.deepEqual(JSON.parse(p.read('etc/citadel-worker/config.json')), { workers: 3, threads: 4, memory_gb: 10, disk_gb: 80, root: join(p.r, 'home/citadel-worker/worker') });
  assert.match(p.logged(), /systemctl set-property user-1001\.slice CPUQuota=400% MemoryMax=10G MemoryHigh=9216M/);
  assert.equal(p.read('etc/citadel-worker/machine-token'), TOKEN);
  assert.equal(p.mode('etc/citadel-worker/machine-token'), '640');
  assert.equal(p.mode('etc/citadel-worker'), '750');
  assert.equal(p.mode('home/citadel-worker'), '700');
  assert.ok(Math.abs(Number(p.read('etc/citadel-worker/installed')) - Date.now()) < 60_000, 'when it was installed, for which of two PCs has this token');
  assert.match(p.logged(), /chown root:citadel-worker machine-token/);
  const unit = p.read('home/citadel-worker/.config/systemd/user/citadel-worker.service');
  assert.match(unit, /ExecStart=\S+node \S+\/app\/worker-agent\.mjs http:\/\/127\.0\.0\.1:\d+ \S+\/etc\/citadel-worker\/config\.json\n/);
  assert.match(unit, /RestartPreventExitStatus=64\n/);
  assert.match(unit, /KillMode=process\n/, 'a restart of the program leaves running minions be');
  assert.doesNotMatch(unit + done.out + p.logged(), new RegExp(TOKEN), 'the token is in its one file');
  assert.match(p.read('etc/subuid'), /^citadel-worker:524288:65536$/m);
  assert.match(done.out, /The worker is running[^]*sign in to Claude and GitHub/);
});

test("run again, it keeps the owner's own settings and changes the caps given; a worker that cannot connect is said", async () => {
  const p = pc();
  assert.equal((await p.install()).code, 0);
  const cfg = { ...JSON.parse(p.read('etc/citadel-worker/config.json')), image: 'localhost/mine' };
  writeFileSync(join(p.r, 'etc/citadel-worker/config.json'), JSON.stringify(cfg));
  const again = await p.install(['--workers', '2'], { CC_MACHINE_TOKEN: TOKEN, SAYS: "This worker can't start: nope" });
  assert.equal(again.code, 1);
  assert.match(again.out, /can't start: nope[^]*not reached Citadel yet/, 'not the line of the run before');
  assert.deepEqual(JSON.parse(p.read('etc/citadel-worker/config.json')), { ...cfg, workers: 2 });
  assert.equal(p.logged().match(/useradd/g)!.length, 1);
  assert.equal(p.read('etc/subuid').match(/citadel-worker/g)!.length, 1);
});

test("run again, nothing in the worker's home is written as root: a link a minion left there is followed as that user", async () => {
  const p = pc();
  assert.equal((await p.install()).code, 0);
  const script = readFileSync(join(scripts, 'install-worker.sh'), 'utf8') + readFileSync(join(scripts, 'citadel-worker'), 'utf8');
  for (const line of script.split('\n')) if (/\$home\/|"\$log"/.test(line) && !/^(ExecStart|WorkingDirectory|Standard|\s*(echo|#|log=|\[\[ ! -f))/.test(line)) assert.match(line, /\bas (mkdir|tee|cat|tail) |ROOT=/, line);
  assert.match(readFileSync(join(p.r, 'log.user'), 'utf8'), /worker-agent\.mjs$/m);
});

test('a wrong PC, address or token is refused before anything is changed', async () => {
  const p = pc();
  assert.match((await p.install([], { CC_MACHINE_TOKEN: 'ccm_7_short' })).out, /isn't a machine token/);
  assert.match((await p.install([], { CC_MACHINE_TOKEN: TOKEN, ARCH: 'aarch64' })).out, /aarch64/);
  assert.match((await p.run(join(scripts, 'install-worker.sh'), ['http://x/; rm -rf /'])).out, /usage/);
  assert.equal(p.logged(), '');
});

test("citadel-worker: caps are whole numbers, and a sign-in is Claude Code's and gh's own, in the minions' home", async () => {
  const p = pc();
  const helper = join(scripts, 'citadel-worker');
  assert.match((await p.run(helper, ['caps', '--workers', '4'])).out, /No worker is installed here/);
  await p.install();
  assert.match((await p.run(helper, ['signin'])).out, /not built yet/);
  writeFileSync(join(p.r, 'home/citadel-worker/worker/image-tag'), 'localhost/citadel-worker:abc');
  assert.equal((await p.run(helper, ['signin'])).code, 0);
  assert.match(p.logged(), /podman run --rm -it .* -v citadel-worker-home:\/home\/worker:U localhost\/citadel-worker:abc claude \/login\n/);
  assert.equal((await p.run(helper, ['signin-github'])).code, 0);
  assert.match(p.logged(), /localhost\/citadel-worker:abc gh auth login --hostname github\.com/);
  for (const bad of ['1; reboot', '0', '65']) assert.equal((await p.run(helper, ['caps', '--workers', bad])).code, 1, bad);
  for (const [flag, low] of [
    ['--memory', '1'],
    ['--disk', '19'],
    ['--threads', '1025'],
  ])
    assert.match((await p.run(helper, ['caps', flag, low])).out, /a whole number from/);
  const caps = await p.run(helper, ['caps', '--threads', '2', '--disk', '30']);
  assert.match(caps.out, /Caps: 6 minions at once, 2 threads, 24 GB of memory, 30 GB of disk/);
  assert.match(p.logged(), /CPUQuota=200%[^]*systemctl --user restart citadel-worker\n$/);
});

test('the worker may run one root command through sudo, page-caps, with its own PATH; a sudo that refuses the rule leaves it out', async () => {
  const p = pc();
  assert.equal((await p.install()).code, 0);
  const rules = p.read('etc/sudoers.d/citadel-worker');
  const lines = rules.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['Defaults:citadel-worker env_reset, secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"', 'citadel-worker ALL=(root) NOPASSWD: /usr/local/bin/citadel-worker page-caps *']);
  assert.equal(p.mode('etc/sudoers.d/citadel-worker'), '440');
  assert.match(p.logged(), /visudo -cqf \S+\/etc\/sudoers\.d\/citadel-worker\.new\n/, 'checked before it is put where sudo reads it');

  const q = pc();
  const refused = await q.install([], { CC_MACHINE_TOKEN: TOKEN, VISUDO: '1' });
  assert.equal(refused.code, 0, "the worker still installs: only the page's raise is missing");
  assert.equal(existsSync(join(q.r, 'etc/sudoers.d/citadel-worker')), false);
  assert.equal(existsSync(join(q.r, 'etc/sudoers.d/citadel-worker.new')), false);
  // Through sudo, whatever that sudo keeps, the caller's PATH (a bash or node of its own) is never used as root: its bash is
  // the system's, and with SUDO_USER set the stubs on this PATH (an id that says root, a systemctl) aren't run.
  assert.match(readFileSync(join(scripts, 'citadel-worker'), 'utf8'), /^#!\/bin\/bash\n/);
  const said = p.logged();
  const sudoed = await p.run(join(scripts, 'citadel-worker'), ['page-caps', '--threads', '4', '--memory', '8'], { SUDO_USER: 'citadel-worker' });
  assert.equal(sudoed.code, 1, sudoed.out);
  assert.match(sudoed.out, /Run this as root|No worker is installed here/, "the system's id, not the stub's");
  assert.equal(p.logged(), said);
});

test("citadel-worker page-caps: the worker's ask is refused unless it is --threads then --memory, whole numbers within what this PC has, and sets only that user's slice", async () => {
  const p = pc();
  const helper = join(scripts, 'citadel-worker');
  assert.equal((await p.install(['--workers', '3', '--threads', '4', '--memory', '10', '--disk', '80'])).code, 0);
  const before = p.read('etc/citadel-worker/config.json');
  const said = p.logged();
  // This PC: 16 threads (getconf) and 31 GB (meminfo).
  for (const bad of [
    [],
    ['--threads', '4'],
    ['--memory', '8', '--threads', '4'],
    ['--threads', '4', '--memory', '8', '--memory', '8'],
    ['--threads', '4', '--memory', '8', '--no-restart'],
    ['--threads', '4', '--disk', '80'],
    ['--workers', '4', '--memory', '8'],
    ['--image', 'evil', '--memory', '8'],
    ['folder', 'add', '--memory', '8'],
    ['--threads', '0', '--memory', '8'],
    ['--threads', '17', '--memory', '8'],
    ['--threads', '4; reboot', '--memory', '8'],
    ['--threads', '04', '--memory', '8'],
    ['--threads', ' 4', '--memory', '8'],
    ['--threads', '4', '--memory', '32'],
    ['--threads', '4', '--memory', '1'],
    ['--threads', '4', '--memory', '8x'],
  ]) {
    const got = await p.run(helper, ['page-caps', ...bad]);
    assert.equal(got.code, 1, bad.join(' '));
    assert.match(got.out, /Refused/, bad.join(' '));
  }
  assert.equal(p.logged(), said, 'nothing refused touched the slice, nor anything else');

  const raised = await p.run(helper, ['page-caps', '--threads', '16', '--memory', '31']);
  assert.equal(raised.code, 0, raised.out);
  assert.equal(p.read('etc/citadel-worker/config.json'), before, "the PC's own caps stay as its owner set them");
  assert.equal(p.logged().slice(said.length), 'systemctl set-property user-1001.slice CPUQuota=1600% MemoryMax=31G MemoryHigh=28569M\n', 'only the slice, and no restart: the worker that asked holds them');
});

test('the Windows script turns the clock off first, keeps the token off every command line, and touches no other distro', () => {
  const ps = readFileSync(join(scripts, 'install-worker.ps1'), 'utf8');
  const code = ps.slice(ps.indexOf('$ErrorActionPreference'));
  const at = (what: string) => {
    const i = code.indexOf(what);
    assert.ok(i >= 0, what);
    return i;
  };
  // The first thing run inside the distro.
  const first = code.slice(at('& $wsl -d $distro')).split('\n')[0];
  assert.match(first, /ln -sf \/dev\/null \/etc\/systemd\/system\/systemd-timesyncd\.service/);
  assert.ok(at('--install Ubuntu-24.04 --name $distro --no-launch') < at('systemd-timesyncd.service'), 'installed without being started');
  assert.match(code, /\$token \| & \$wsl -d \$distro/, 'on standard input');
  assert.doesNotMatch(code, /--shutdown|--unregister|-d citadel-ci|Restart-Computer/);
  for (const [, d] of code.matchAll(/(?:-d|--terminate) (\S+)/g)) assert.equal(d, '$distro');
});
