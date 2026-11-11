// The Linux runner scripts (#510, tools/ci-runner/*.sh) run as root inside WSL on Cara's desktop, where nothing can be
// tried before it lands. Here they run for real against a fake Citadel, a fake runner tarball (its config.sh and svc.sh
// log what they're asked) and stubbed root-only commands (id, runuser, chown, systemctl) in a temporary root folder.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const scripts = join(import.meta.dirname, '..', 'tools', 'ci-runner');
const TOKEN = `ccm_7_${'x'.repeat(43)}`;
const REG = 'AREGISTRATIONTOKEN0123456789AB';
let tmp: string, root: string, log: string, base: string, sha: string;
const asked: any[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; }).on('end', () => {
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
  tmp = mkdtempSync(join(tmpdir(), 'linux-runner-'));
  root = join(tmp, 'opt');
  mkdirSync(root, { mode: 0o700 });
  log = join(tmp, 'log');
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  stub(bin, 'id', '[ "$1" = -u ] && echo 0 || exit 0');
  stub(bin, 'runuser', '[ "$1 $2 $3" = "-u citadel-ci --" ] || { echo "runuser: unexpected $*" >&2; exit 9; }; shift 3; echo "as citadel-ci: $*" >> "$LOG"; exec "$@"');
  stub(bin, 'chown', 'echo "chown $*" >> "$LOG"');
  stub(bin, 'systemctl', '[ "$1" = is-active ] && echo active');
  stub(bin, 'curl', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && cp "$FAKE_TARBALL" "$2"; shift; done');
  // The runner tarball: config.sh and svc.sh that log their arguments and leave the files the real ones do.
  const pkg = join(tmp, 'pkg');
  mkdirSync(pkg);
  stub(pkg, 'config.sh', 'echo "config.sh $*" >> "$LOG"; if [ "$1" = remove ]; then [ -f .service ] && { echo "Uninstall service first" >&2; exit 1; }; rm -f .runner; else echo "{}" > .runner; fi');
  stub(pkg, 'svc.sh', 'echo "svc.sh $* in $(basename "$PWD")" >> "$LOG"; case $1 in install) echo "actions.runner.$(basename "$PWD").service" > .service;; uninstall) rm -f .service;; esac');
  execFileSync('tar', ['-czf', join(tmp, 'runner.tar.gz'), '-C', pkg, '.']);
  sha = createHash('sha256').update(readFileSync(join(tmp, 'runner.tar.gz'))).digest('hex');
  process.env.PATH_FOR_SCRIPTS = `${bin}:${process.env.PATH}`;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [join(scripts, script), ...args], {
      env: { PATH: process.env.PATH_FOR_SCRIPTS!, HOME: tmp, CC_MACHINE_TOKEN: TOKEN, CITADEL_RUNNER_ROOT: root, RUNNER_SHA256: sha, RUNNER_NAME: 'DESK', FAKE_TARBALL: join(tmp, 'runner.tar.gz'), LOG: log, ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}
const logged = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
const marker = (dir: string) => JSON.parse(readFileSync(join(root, dir, '.citadel-runner'), 'utf8'));

test('add, add again, list, remove: the whole life of a scheme\'s Linux runners', async () => {
  const add = await run('add-runner.sh', ['7', `${base}/`, '2']);
  assert.equal(add.code, 0, add.out);
  for (const [dir, name] of [['actions-runner-theory-of-crafting', 'DESK-linux'], ['actions-runner-theory-of-crafting-2', 'DESK-linux-2']]) {
    assert.deepEqual({ ...marker(dir), added_at: undefined }, { repo: 'caraminden/theory-of-crafting', label: 'theory-of-crafting-ci-linux', name, mode: 'linux', added_at: undefined });
    assert.match(readFileSync(join(root, dir, '.env'), 'utf8'), new RegExp(`^HOME=${root}/${dir}/home$`, 'm'), 'a home of its own');
    assert.ok(logged().includes(`as citadel-ci: ./config.sh --unattended --url https://github.com/caraminden/theory-of-crafting --token ${REG} --name ${name} --labels theory-of-crafting-ci-linux --work _work`), logged());
    assert.ok(logged().includes(`svc.sh install citadel-ci in ${dir}\n`) && logged().includes(`svc.sh start in ${dir}\n`), logged());
  }
  assert.deepEqual(asked.map((a) => [a.scheme, a.mint, a.kind]), [[7, false, 'register'], [7, true, 'register']], 'names first, then one token for both');
  assert.doesNotMatch(add.out, new RegExp(`${REG}|${TOKEN}`), 'no token in what it prints');
  assert.match(add.out, /label {2}theory-of-crafting-ci-linux/);

  asked.length = 0;
  const again = await run('add-runner.sh', ['7', base, '2']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already has 2 Linux runner\(s\) here, so nothing changed/);
  assert.deepEqual(asked.map((a) => a.mint), [false], 'nothing to add mints no token');

  // Another repo's runner (repo theory-of-crafting-3's first folder looks like this one's third).
  mkdirSync(join(root, 'actions-runner-theory-of-crafting-3'));
  writeFileSync(join(root, 'actions-runner-theory-of-crafting-3', '.citadel-runner'), '{"repo": "caraminden/theory-of-crafting-3"}');
  const taken = await run('add-runner.sh', ['7', base, '3']);
  assert.equal(taken.code, 1);
  assert.match(taken.out, /already holds a runner for caraminden\/theory-of-crafting-3/);

  const list = await run('list-runners.sh', []);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /actions\.runner\.actions-runner-theory-of-crafting\.service {2}active {2}\S+actions-runner-theory-of-crafting {2}\(Citadel's, for caraminden\/theory-of-crafting\)/);
  assert.match(list.out, /\(no service\) {2}no service {2}\S+-3 {2}\(Citadel's, for caraminden\/theory-of-crafting-3\)/);

  asked.length = 0;
  writeFileSync(log, '');
  const remove = await run('remove-runner.sh', ['7', base]);
  assert.equal(remove.code, 0, remove.out);
  assert.deepEqual(asked.map((a) => [a.mint, a.kind]), [[false, 'remove'], [true, 'remove']]);
  assert.ok(!existsSync(join(root, 'actions-runner-theory-of-crafting')) && !existsSync(join(root, 'actions-runner-theory-of-crafting-2')));
  assert.ok(existsSync(join(root, 'actions-runner-theory-of-crafting-3')), 'another repo\'s folder stays');
  assert.match(logged(), /svc\.sh stop in actions-runner-theory-of-crafting\nsvc\.sh uninstall in actions-runner-theory-of-crafting\n/);
  assert.ok(logged().includes(`as citadel-ci: ./config.sh remove --token ${REG}`), logged());
  const none = await run('remove-runner.sh', ['7', base]);
  assert.match(none.out, /No Citadel Linux runner of caraminden\/theory-of-crafting here/);
  rmSync(join(root, 'actions-runner-theory-of-crafting-3'), { recursive: true });
});

test('a download whose SHA-256 is wrong installs nothing; Citadel\'s refusal and bad arguments stop it before anything', async () => {
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

test('remove refuses a runner folder others can write to, where a marker proves nothing', async () => {
  chmodSync(root, 0o777);
  try {
    const r = await run('remove-runner.sh', ['7', base]);
    assert.equal(r.code, 1);
    assert.match(r.out, /is not root's alone/);
  } finally {
    chmodSync(root, 0o700);
  }
});
