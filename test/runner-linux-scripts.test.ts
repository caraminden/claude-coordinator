// The Linux runner scripts (#510, tools/ci-runner/*.sh) run as root inside WSL on Cara's desktop, where nothing can be
// tried before it lands. Here they run for real against a fake Citadel, a fake runner tarball (its config.sh logs what
// it's asked) and stubbed root-only commands (id, useradd, userdel, runuser, chown, systemctl) in a temporary folder.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { tempRoot } from './helpers.ts';

const scripts = join(import.meta.dirname, '..', 'tools', 'ci-runner');
const TOKEN = `ccm_7_${'x'.repeat(43)}`;
const REG = 'AREGISTRATIONTOKEN0123456789AB';
const scratch = tempRoot('linux-runner-');
const tmp = scratch.dir;
let root: string, units: string, log: string, base: string, sha: string;
const USER = `ci-theory-of-crafting-${createHash('sha256').update('caraminden/theory-of-crafting').digest('hex').slice(0, 6)}`;
const asked: any[] = [];
const server = createServer((req, res) => {
  let body = '';
  req
    .on('data', (c) => {
      body += c;
    })
    .on('end', () => {
      if (req.url !== '/api/machines/runner-token' || req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end('{"error":"no"}');
      const ask = JSON.parse(body);
      asked.push(ask);
      if (ask.scheme === 99) return res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"No scheme 99"}');
      res.writeHead(ask.mint ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scheme: 'Theory of Crafting', repo: 'caraminden/theory-of-crafting', label: 'theory-of-crafting-ci', token: ask.mint ? REG : null, expires_at: null }));
    });
});

function stub(dir: string, name: string, body: string) {
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

before(async () => {
  root = join(tmp, 'opt');
  units = join(tmp, 'units');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(units, { mode: 0o700 });
  mkdirSync(join(tmp, 'users'));
  log = join(tmp, 'log');
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  stub(bin, 'id', '[ "$1" = -u ] && echo 0 || [ -f "$USERS/$1" ]');
  stub(bin, 'useradd', 'echo "useradd $*" >> "$LOG"; touch "$USERS/${!#}"');
  stub(bin, 'userdel', 'echo "userdel $*" >> "$LOG"; rm "$USERS/$1"');
  // What config.sh is run with: its user, its HOME, the token in its environment, and no machine token.
  stub(bin, 'runuser', '[ "$1 $2 $4" = "-m -u --" ] && [ -f "$USERS/$3" ] || { echo "runuser: unexpected $*" >&2; exit 9; }; u=$3; shift 4; echo "as $u HOME=$HOME token=$ACTIONS_RUNNER_INPUT_TOKEN machine=${CC_MACHINE_TOKEN:-none}: $*" >> "$LOG"; exec "$@"');
  stub(bin, 'chown', 'echo "chown $*" >> "$LOG"');
  stub(bin, 'systemctl', 'echo "systemctl $*" >> "$LOG"; [ "$1" = is-active ] && echo active; true');
  stub(bin, 'curl', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "$FAKE_TARBALL" "$2"; shift; done');
  // The runner tarball: a config.sh that leaves the .runner file the real one does, and bin/runsvc.sh for the unit.
  const pkg = join(tmp, 'pkg');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  stub(join(pkg, 'bin'), 'runsvc.sh', 'exit 0');
  stub(pkg, 'config.sh', 'if [ "$1" = remove ]; then rm -f .runner; else echo "{}" > .runner; fi');
  execFileSync('tar', ['-czf', join(tmp, 'runner.tar.gz'), '-C', pkg, '.']);
  sha = createHash('sha256')
    .update(readFileSync(join(tmp, 'runner.tar.gz')))
    .digest('hex');
  process.env.PATH_FOR_SCRIPTS = `${bin}:${process.env.PATH}`;
  base = `http://127.0.0.1:${await scratch.serve(server)}`;
});
after(() => scratch.teardown());

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = scratch.spawn('bash', [join(scripts, script), ...args], {
      env: { PATH: process.env.PATH_FOR_SCRIPTS!, HOME: tmp, CC_MACHINE_TOKEN: TOKEN, CITADEL_RUNNER_ROOT: root, CITADEL_RUNNER_UNITS: units, USERS: join(tmp, 'users'), RUNNER_SHA256: sha, RUNNER_NAME: 'DESK', CITADEL_RUNNER_SETTLE: '0', FAKE_TARBALL: join(tmp, 'runner.tar.gz'), LOG: log, ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}
const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const marker = (dir: string) => JSON.parse(readFileSync(join(root, dir, '.citadel-runner'), 'utf8'));

const unitOf = (suffix: string) => join(units, `citadel-runner-caraminden-theory-of-crafting${suffix}.service`);

test("add, add again, list, remove: the whole life of a scheme's Linux runners", async () => {
  const add = await run('add-runner.sh', ['7', `${base}/`, '2']);
  assert.equal(add.code, 0, add.out);
  for (const [suffix, name] of [
    ['', 'DESK-linux'],
    ['-2', 'DESK-linux-2'],
  ]) {
    const dir = join(root, `actions-runner-theory-of-crafting${suffix}`);
    assert.deepEqual({ ...marker(`actions-runner-theory-of-crafting${suffix}`), added_at: undefined, unit: undefined }, { repo: 'caraminden/theory-of-crafting', label: 'theory-of-crafting-ci-linux', name, mode: 'linux', added_at: undefined, unit: undefined });
    assert.match(readFileSync(join(dir, '.env'), 'utf8'), new RegExp(`^HOME=${dir}/home$`, 'm'), 'a home of its own');
    assert.equal(statSync(dir).mode & 0o777, 0o700, "other schemes' users can't read it");
    // The registration token only in config.sh's environment: never an argument, and no machine token beside it.
    assert.ok(logged().includes(`as ${USER} HOME=${dir}/home token=${REG} machine=none: ./config.sh --unattended --url https://github.com/caraminden/theory-of-crafting --name ${name} --labels theory-of-crafting-ci-linux${suffix ? ',theory-of-crafting-ci-linux-side' : ''} --work _work\n`), logged());
    // #1240: the second runner also takes the side label, so flake proofs and the nightly leave the first free for ships.
    const unit = readFileSync(unitOf(suffix), 'utf8');
    assert.match(unit, /^# citadel-repo=caraminden\/theory-of-crafting\n/);
    assert.match(unit, new RegExp(`^ExecStart=/bin/bash ${dir}/bin/runsvc.sh\nUser=${USER}\nWorkingDirectory=${dir}\n`, 'm'));
    assert.ok(existsSync(join(dir, 'bin', 'runsvc.sh')), 'the unit runs a file the tarball has');
    assert.ok(logged().includes(`chown -R ${USER}: ${dir}\n`), "the scheme's user owns it");
    assert.ok(logged().includes(`systemctl enable --now citadel-runner-caraminden-theory-of-crafting${suffix}.service\n`), logged());
  }
  assert.doesNotMatch(logged(), /--token|svc\.sh/, "no token on a command line; root never runs the runner's svc.sh");
  assert.equal(logged().match(/^useradd /gm)?.length, 1, 'one user for the scheme');
  assert.deepEqual(
    asked.map((a) => [a.scheme, a.mint, a.kind]),
    [
      [7, false, 'register'],
      [7, true, 'register'],
    ],
    'names first, then one token for both',
  );
  assert.doesNotMatch(add.out, new RegExp(`${REG}|${TOKEN}`), 'no token in what it prints');
  assert.match(add.out, /label {2}theory-of-crafting-ci-linux/);

  asked.length = 0;
  const again = await run('add-runner.sh', ['7', base, '2']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already has 2 Linux runner\(s\) here, so nothing changed/);
  assert.deepEqual(
    asked.map((a) => a.mint),
    [false],
    'nothing to add mints no token',
  );

  // Another repo's runner (repo theory-of-crafting-3's first has the same names as this one's third).
  mkdirSync(join(root, 'actions-runner-theory-of-crafting-3'));
  writeFileSync(unitOf('-3'), `# citadel-repo=caraminden/theory-of-crafting-3\nWorkingDirectory=${root}/actions-runner-theory-of-crafting-3\nUser=ci-theory-of-crafting-3-abcdef\n`);
  const taken = await run('add-runner.sh', ['7', base, '3']);
  assert.equal(taken.code, 1);
  assert.match(taken.out, /not as caraminden\/theory-of-crafting's \(caraminden\/theory-of-crafting-3\)/);
  // A CI job of another scheme can write a folder's marker; remove must not believe it.
  mkdirSync(join(root, 'actions-runner-other'));
  writeFileSync(join(root, 'actions-runner-other', '.citadel-runner'), '{"repo": "caraminden/theory-of-crafting"}');

  const list = await run('list-runners.sh', []);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, new RegExp(`citadel-runner-caraminden-theory-of-crafting\\.service {2}active {2}\\S+actions-runner-theory-of-crafting {2}\\(Citadel's, for caraminden/theory-of-crafting, as ${USER}\\)`));
  assert.match(list.out, /\(no Citadel unit\) {2}- {2}\S+actions-runner-other {2}\(not Citadel's\)/);
  // The whole folder name, not just -3: the temp folder's random name can hold that.
  assert.doesNotMatch(list.out, /no Citadel unit.*actions-runner-theory-of-crafting-3 /, 'a folder with a unit is listed once');

  asked.length = 0;
  writeFileSync(log, '');
  const remove = await run('remove-runner.sh', ['7', base]);
  assert.equal(remove.code, 0, remove.out);
  assert.deepEqual(
    asked.map((a) => [a.mint, a.kind]),
    [
      [false, 'remove'],
      [true, 'remove'],
    ],
  );
  assert.ok(!existsSync(join(root, 'actions-runner-theory-of-crafting')) && !existsSync(join(root, 'actions-runner-theory-of-crafting-2')));
  assert.ok(!existsSync(unitOf('')) && !existsSync(unitOf('-2')));
  assert.ok(existsSync(join(root, 'actions-runner-theory-of-crafting-3')) && existsSync(unitOf('-3')), "another repo's runner stays");
  assert.ok(existsSync(join(root, 'actions-runner-other')), 'a forged marker removes nothing');
  assert.ok(logged().includes('systemctl disable --now citadel-runner-caraminden-theory-of-crafting.service\n'), logged());
  assert.ok(logged().includes(`as ${USER} HOME=${root}/actions-runner-theory-of-crafting/home token=${REG} machine=none: ./config.sh remove\n`), logged());
  assert.match(logged(), new RegExp(`^userdel ${USER}$`, 'm'), 'its user goes with its last runner');
  const none = await run('remove-runner.sh', ['7', base]);
  assert.match(none.out, /No Citadel Linux runner of caraminden\/theory-of-crafting here/);
  rmSync(join(root, 'actions-runner-theory-of-crafting-3'), { recursive: true });
  rmSync(join(root, 'actions-runner-other'), { recursive: true });
  rmSync(unitOf('-3'));
});

test('an add cut off before config.sh leaves a unit remove can find; a unit pointing elsewhere is left alone', async () => {
  // Cut off: its unit and folder, but no .runner, as when the agent ends an add at 15 minutes.
  mkdirSync(join(root, 'actions-runner-theory-of-crafting'));
  writeFileSync(unitOf(''), `# citadel-repo=caraminden/theory-of-crafting\nUser=${USER}\nWorkingDirectory=${root}/actions-runner-theory-of-crafting\n`);
  writeFileSync(join(tmp, 'users', USER), '');
  const add = await run('add-runner.sh', ['7', base, '1']);
  assert.equal(add.code, 1);
  assert.match(add.out, /was never registered \(an add cut off\?\): ci_runners remove, then add again/);
  // A unit naming the repo but another user or a folder outside /opt/actions-runner-*: root's, yet not acted on.
  writeFileSync(unitOf('-2'), `# citadel-repo=caraminden/theory-of-crafting\nUser=root\nWorkingDirectory=${root}/actions-runner-theory-of-crafting-2\n`);
  writeFileSync(unitOf('-3'), `# citadel-repo=caraminden/theory-of-crafting\nUser=${USER}\nWorkingDirectory=${tmp}\n`);
  const remove = await run('remove-runner.sh', ['7', base]);
  assert.equal(remove.code, 1, remove.out);
  assert.ok(!existsSync(join(root, 'actions-runner-theory-of-crafting')) && !existsSync(unitOf('')), 'the cut-off one is cleared');
  assert.ok(existsSync(unitOf('-2')) && existsSync(unitOf('-3')) && existsSync(tmp), 'the odd ones stay');
  assert.match(remove.out, /2 runner\(s\) weren't removed/);
  rmSync(unitOf('-2'));
  rmSync(unitOf('-3'));
  rmSync(join(tmp, 'users', USER), { force: true });
});

test("a download whose SHA-256 is wrong installs nothing; Citadel's refusal and bad arguments stop it before anything", async () => {
  const bad = await run('add-runner.sh', ['7', base, '1'], { RUNNER_SHA256: '0'.repeat(64) });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /SHA-256 is [0-9a-f]{64}, not 0{64}/);
  assert.ok(!existsSync(join(root, 'actions-runner-theory-of-crafting')));
  const refused = await run('add-runner.sh', ['99', base, '1']);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /Citadel refused: No scheme 99/);
  assert.match((await run('add-runner.sh', ['7', base, '5'])).out, /count must be 1 to 4/);
  assert.match((await run('add-runner.sh', ['7', base, '1'], { CC_MACHINE_TOKEN: '' })).out, /No machine token/);
});

test('remove refuses a units folder others can write to, where a unit proves nothing', async () => {
  chmodSync(units, 0o777);
  try {
    const r = await run('remove-runner.sh', ['7', base]);
    assert.equal(r.code, 1);
    assert.match(r.out, /is not root's alone/);
  } finally {
    chmodSync(units, 0o700);
  }
});

/** The installer (#1933) against a fake root: what it wrote, and what it said. `kernel` is the running kernel's name. */
function install(kernel: string, opts: { wslDir?: boolean; systemd?: boolean } = {}) {
  const fake = join(tmp, `root-${kernel}-${!!opts.wslDir}-${opts.systemd ?? true}`);
  for (const d of ['proc/sys/kernel', 'etc/systemd/system', 'var/log', 'home/pal', ...(opts.systemd === false ? [] : ['run/systemd/system']), ...(opts.wslDir ? ['run/WSL'] : [])]) mkdirSync(join(fake, d), { recursive: true });
  writeFileSync(join(fake, 'proc/sys/kernel/osrelease'), `${kernel}\n`);
  chmodSync(join(fake, 'home/pal'), 0o755);
  const bin = join(fake, 'bin');
  mkdirSync(bin, { recursive: true });
  stub(bin, 'install', 'mkdir -p "${!#}"');
  // The agent's log says it connected once its service is started.
  stub(bin, 'systemctl', `echo "systemctl $*" >> "$LOG"; [ "$1" = enable ] && echo 'Connected to citadel as "x"' >> ${join(fake, 'var/log/citadel-runner-agent.log')}; true`);
  stub(bin, 'apt-get', 'echo "apt-get $*" >> "$LOG"');
  stub(bin, 'ldconfig', 'echo libicuuc.so.72');
  return { fake, run: () => run('install-runner-agent.sh', [base], { CITADEL_TEST_ROOT: fake, PATH: `${bin}:${process.env.PATH_FOR_SCRIPTS}` }) };
}

test('on plain Linux the install touches no WSL setting, caps all CI in a slice, and says what is left to do (#1933)', async () => {
  const { fake, run: go } = install('6.1.0-52-amd64');
  const r = await go();
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(fake, 'etc/wsl.conf')), false, 'no WSL file');
  assert.doesNotMatch(r.out, /wsl|WSL|PowerShell/, 'no Windows step');
  const cores = Number(execFileSync('nproc').toString());
  const sliceFile = readFileSync(join(fake, 'etc/systemd/system/citadel-runners.slice'), 'utf8');
  assert.match(sliceFile, new RegExp(`^CPUQuota=${cores * 75}%$`, 'm'));
  assert.match(readFileSync(join(fake, 'etc/systemd/system/citadel-runner-.service.d/yield.conf'), 'utf8'), /^Slice=citadel-runners\.slice$/m);
  assert.match(readFileSync(join(fake, 'etc/systemd/system/citadel-runner-agent.service'), 'utf8'), /runner-agent\.mjs/);
  assert.match(r.out, /open its line and pick the schemes/);
  // A CI job's user reads what anyone may: the owner hears which home is open.
  assert.match(r.out, /home\/pal can be read by every user here/);
});

test('in WSL the install still walls the distro off, caps nothing in it, and changes nothing once walled (#1933)', async () => {
  for (const [kernel, wslDir] of [
    ['6.6.87.2-microsoft-standard-WSL2', false],
    ['6.6.0-custom', true],
  ] as const) {
    const { fake, run: go } = install(kernel, { wslDir });
    const first = await go();
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /Restart the distro/);
    const conf = readFileSync(join(fake, 'etc/wsl.conf'), 'utf8');
    assert.match(conf, /^\[interop\]\nenabled=false$/m);
    assert.equal(existsSync(join(fake, 'etc/systemd/system/citadel-runner-agent.service')), false, 'it stops there');
    const second = await go();
    assert.equal(second.code, 0, second.out);
    assert.equal(existsSync(join(fake, 'etc/systemd/system/citadel-runners.slice')), false, '.wslconfig caps that VM');
    assert.doesNotMatch(readFileSync(join(fake, 'etc/systemd/system/citadel-runner-.service.d/yield.conf'), 'utf8'), /Slice=/);
    assert.match(second.out, /keep-wsl-up\.ps1/);
  }
});

test('plain Linux without systemd is refused before anything is written', async () => {
  const { fake, run: go } = install('6.1.0-52-amd64', { systemd: false });
  const r = await go();
  assert.equal(r.code, 1);
  assert.match(r.out, /systemd is not running here/);
  assert.equal(existsSync(join(fake, 'opt')), false);
});
