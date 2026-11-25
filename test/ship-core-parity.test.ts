// Citadel's ship pipeline and the kit's core (kit/skills/scheme-setup/templates/land.sh, run as tools/land-core.sh once
// SHIP_CORE is on, #1323) share deploy.sh's line and Citadel's settings: these pin the places the two copies must agree
// (the ship scripts' ultra review, 2026-11-23, fix C).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readQueue } from '../src/waits.ts';
import { scriptEnv } from './script-env.ts';

const env = { ...scriptEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'ship-core-parity-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const template = join(repo, 'kit', 'skills', 'scheme-setup', 'templates', 'land.sh');
const deployQueue = join(repo, 'tools', 'deploy-queue.sh');
const fn = (file: string, name: string) => {
  const m = readFileSync(file, 'utf8').match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
  assert.ok(m, `${name} in ${file}`);
  return m[0];
};
const bash = (script: string, ...args: string[]) => {
  const r = spawnSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n').filter(Boolean);
};

// The three ticket layouts that can sit in deploy.sh's queue/ at once: deploy-queue.sh's (`order` on line 5), the
// core's (`order` on line 8, after its commit, verdict and base) and one from before .order (4 lines, no `order`).
const deployTicket = (label: string) => ['123 456', '0', label, 'waiting', 'order', '', ''].join('\n') + '\n';
const coreTicket = (label: string) => ['123 456', '0', label, 'waiting', '-', '-', '-', 'order'].join('\n') + '\n';
const oldTicket = (label: string) => ['123 456', '0', label, 'waiting'].join('\n') + '\n';

test('the kit core, deploy-queue.sh and the server put a line of deploy.sh, core and old tickets in the same order', () => {
  const q = mkdtempSync(join(root, 'queue-parity-'));
  const tickets: [string, string][] = [
    ['0000000001', deployTicket('deploy-a')],
    ['0000000002', coreTicket('core-b')],
    ['0000000003', deployTicket('deploy-c')],
    ['0000000004', oldTicket('old-d')],
    ['0000000005', coreTicket('core-e')],
    ['0000000006', deployTicket('deploy-f')],
  ];
  for (const [n, text] of tickets) writeFileSync(join(q, n), text);
  // Ranked out of arrival order, so a ticket read as "from before .order" lands somewhere else in the line.
  writeFileSync(join(q, '.order'), '# Cara moved deploy-c\n0000000003\n0000000002\n0000000006\n0000000005\n');

  const core = bash(`${fn(template, 'queue_order')}Q_DIR=$1; queue_order; printf '%s\\n' "\${Q_ORDER[@]}"`, q);
  const deploy = bash(`. "$2"; queue_order "$1"; for t in "$1"/[0-9]*; do t=\${t##*/}; echo "$(queue_key "$t") $t"; done | LC_ALL=C sort | cut -d' ' -f2`, q, deployQueue);
  const server = readQueue(q, 4, () => true).map((t) => String(t.seq).padStart(10, '0'));

  // Old-d waits for every lower ticket; .order ranks the others among themselves on either side of it.
  const want = ['0000000003', '0000000002', '0000000001', '0000000004', '0000000006', '0000000005'];
  assert.deepEqual(deploy, want, 'deploy-queue.sh');
  assert.deepEqual(server, want, 'the server (src/waits.ts)');
  assert.deepEqual(core, want, 'the kit core');
});

// A Regenerate ship (#1827) holds the line: "hold" on deploy-queue.sh's train line (6th), or the core's 9th line,
// puts it first among the waiters, ahead of every .order rank, in all three readers.
test('a ticket that holds the line goes first among the waiters in the core, deploy-queue.sh and the server', () => {
  const q = mkdtempSync(join(root, 'queue-hold-'));
  const held = (text: string, line: number) => {
    const l = text.trimEnd().split('\n');
    while (l.length < line) l.push('');
    l[line - 1] = 'hold';
    return l.join('\n') + '\n';
  };
  writeFileSync(join(q, '0000000001'), deployTicket('deploy-a'));
  writeFileSync(join(q, '0000000002'), coreTicket('core-b'));
  writeFileSync(join(q, '0000000003'), held(deployTicket('deploy-c'), 6));
  writeFileSync(join(q, '0000000004'), held(coreTicket('core-d'), 9));
  writeFileSync(join(q, '.order'), '0000000002\n0000000001\n');
  const core = bash(`${fn(template, 'queue_order')}Q_DIR=$1; queue_order; printf '%s\\n' "\${Q_ORDER[@]}"`, q);
  const deploy = bash(`. "$2"; queue_order "$1"; for t in "$1"/[0-9]*; do t=\${t##*/}; echo "$(queue_key "$t") $t"; done | LC_ALL=C sort | cut -d' ' -f2`, q, deployQueue);
  const server = readQueue(q, 4, () => true).map((t) => String(t.seq).padStart(10, '0'));
  const want = ['0000000003', '0000000004', '0000000002', '0000000001'];
  assert.deepEqual(deploy, want, 'deploy-queue.sh');
  assert.deepEqual(server, want, 'the server (src/waits.ts)');
  assert.deepEqual(core, want, 'the kit core');
});

test("land.local.sh's land_deploy hands deploy.sh the core's place in line", () => {
  const dir = mkdtempSync(join(root, 'land-deploy-ticket-'));
  const tools = join(dir, 'tools');
  const main = join(dir, 'main');
  mkdirSync(tools);
  copyFileSync(join(repo, 'tools', 'land.local.sh'), join(tools, 'land.local.sh'));
  // Stand-ins for the deploy line: no restart ahead, and a deploy.sh that only says which ticket it was given.
  writeFileSync(join(tools, 'deploy-queue.sh'), 'restart_lock() { :; }\ndeploy_unchecked_back() { :; }\ntaken_back() { :; }\n');
  writeFileSync(join(tools, 'deploy.sh'), '#!/usr/bin/env bash\necho "ticket=${DEPLOY_QUEUE_TICKET:-}" >>"$SEEN"\n', { mode: 0o755 });
  const git = (...a: string[]) => spawnSync('git', ['-C', main, ...a], { encoding: 'utf8', env }).stdout.trim();
  mkdirSync(main);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  const old = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'two');
  const to = git('rev-parse', 'HEAD');
  mkdirSync(join(main, '.git', 'land-deploy'));
  writeFileSync(join(main, '.git', 'land-deploy', to), `x x ${old} x\n`);
  const live = join(dir, 'live');
  mkdirSync(join(live, '.git', 'cc-deploy'), { recursive: true });
  const seen = join(dir, 'seen');
  const r = spawnSync('bash', ['-c', `say() { echo "$*" >&2; }; . "$1"; QUEUE_TICKET=$2; land_deploy "$3"`, 'bash', join(tools, 'land.local.sh'), join(dir, 'ticket'), to], {
    cwd: main,
    encoding: 'utf8',
    env: { ...env, DEPLOY_LIVE: live, SEEN: seen },
  });
  assert.equal(readFileSync(seen, 'utf8'), `ticket=${join(dir, 'ticket')}\n`, r.stderr);
});

// Each LAND_CI_* default both files set: land.local.sh ports land.sh's to the core, so a change to one (#1606's 9 min
// wait, #1655's 15 s poll) goes to the other.
test("land.local.sh's CI defaults match land.sh's", () => {
  const defaults = (file: string) => {
    const out = new Map<string, string>();
    for (const m of readFileSync(join(repo, 'tools', file), 'utf8').matchAll(/\$\{(LAND_CI_[A-Z_]+):-([^}]*)\}/g)) {
      const seen = out.get(m[1]);
      assert.ok(seen === undefined || seen === m[2], `${file} gives ${m[1]} two defaults (${seen} and ${m[2]})`);
      out.set(m[1], m[2]);
    }
    return out;
  };
  const land = defaults('land.sh'),
    local = defaults('land.local.sh');
  const shared = [...local.keys()].filter((k) => land.has(k));
  assert.ok(shared.includes('LAND_CI_TIMEOUT') && shared.includes('LAND_CI_POLL'), `shared: ${shared.join(' ')}`);
  for (const k of shared) assert.equal(local.get(k), land.get(k), `${k}: land.local.sh ${local.get(k)}, land.sh ${land.get(k)}`);
});

test("land.local.sh's citadel_retro_log is land.sh's retro_log, header text and all", () => {
  const body = (file: string, name: string) => {
    const m = readFileSync(join(repo, 'tools', file), 'utf8').match(new RegExp(`^${name}\\(\\) \\(\\n[\\s\\S]*?^\\) >/dev/null 2>&1 \\|\\| true\\n`, 'm'));
    assert.ok(m, `${name} in ${file}`);
    return m[0].replace(name, 'retro_log');
  };
  assert.equal(body('land.local.sh', 'citadel_retro_log'), body('land.sh', 'retro_log'));
});

test("the burn-in line parser is the same sed in land.sh's burn_lines and land.local.sh's two copies", () => {
  const parser = (file: string, name: string) => {
    const m = readFileSync(join(repo, 'tools', file), 'utf8').match(new RegExp(`^${name}\\(\\) \\{.*?(sed -n '[^']*burn-in: [^']*').*$`, 'm'));
    assert.ok(m, `${name} in ${file}`);
    return m[1];
  };
  const land = parser('land.sh', 'burn_lines');
  assert.equal(parser('land.local.sh', 'citadel_burn_lines'), land);
  assert.equal(parser('land.local.sh', 'citadel_ci_burn_lines'), land);
});

test('land.local.sh refuses a CI red that skipped a test as land.sh does, whatever flakes it has beside it (#1914)', () => {
  const local = join(repo, 'tools', 'land.local.sh'),
    land = join(repo, 'tools', 'land.sh');
  const raw = join(import.meta.dirname, 'fixtures', 'land-verdicts', '45549200030.log');
  const pre = `set -euo pipefail\n${fn(local, 'citadel_flake_only')}${fn(local, 'citadel_skipped')}${fn(local, 'land_flaky')}citadel_retro_log() { :; }\n`;
  const dir = mkdtempSync(join(root, 'skips-'));
  const strip = readFileSync(join(repo, 'tools', 'land.local.sh'), 'utf8').match(/sed -E (\$'s\/\^\[\^\\t\]\*.*?\/\/')/);
  assert.ok(strip, "citadel_ci_log's sed");
  bash(`${pre}sed -E ${strip[1]} "$1" >"$2/run-7.log"`, raw, dir);
  const theirs = bash(`failed=$(cat "$1")\n${fn(land, 'skipped_tests')}skipped_tests`, raw);
  assert.deepEqual(theirs, ['1', 'every .ts, .js and .mjs file this branch changed is formatted']);
  assert.deepEqual(bash(`${pre}citadel_skipped <"$1/run-7.log"`, dir), theirs);
  const digest = `${fn(local, 'citadel_ci_digest')}citadel_ci_digest "$1/run-7.log" 7 https://ci/7 suite`;
  assert.deepEqual(bash(`${pre}${digest} | citadel_skipped >/dev/null && echo seen`, dir), ['seen'], "land_main_red's log is the digest");
  const flaky = `${pre}citadel_ci_dir() { echo ${JSON.stringify(dir)}; }\ntip=abc\nland_flaky <<<'citadel-ci: run 7 https://ci/7 suite' || echo red`;
  assert.deepEqual(bash(flaky), ['red']);
  writeFileSync(join(dir, 'run-7.log'), readFileSync(join(dir, 'run-7.log'), 'utf8').replace(/^ℹ skipped 1$/m, 'ℹ skipped 0'));
  assert.deepEqual(bash(flaky), ['test/machine-lend-cards.test.ts'], 'no skip: the one fresh run, as before');
  // The status the core asks CI for, with every flake a known one: red on a skip, green without one.
  const status = (skips: number) => {
    writeFileSync(join(dir, 'run-7.log'), readFileSync(join(dir, 'run-7.log'), 'utf8').replace(/^ℹ skipped \d+$/m, `ℹ skipped ${skips}`));
    const names = ['citadel_flake_only', 'citadel_skipped', 'citadel_skipped_said', 'citadel_cut_off', 'citadel_ci_digest', 'citadel_ci_status'];
    const stubs = `citadel_retro_log() { echo "retro: $1"; }\ncitadel_ci_dir() { echo ${JSON.stringify(dir)}; }\ncitadel_slug() { echo o/r; }\ncitadel_hub() { printf '7\\tcompleted\\tfailure\\thttps://ci/7\\n'; }\ncitadel_ci_log() { echo ${JSON.stringify(dir)}/run-7.log; }\ncitadel_ci_known() { echo 'a known flake'; }\ncitadel_ci_rerun_said() { :; }\nCITADEL_CI_WORKFLOW=w CITADEL_CI_CLOCK_STEP=c CITADEL_CI_STEP="$(printf '7\\tcompleted\\tfailure\\thttps://ci/7')" CITADEL_CI_BURN_STEP=b`;
    return bash(`set -euo pipefail\n${names.map((n) => fn(local, n)).join('')}${stubs}\nrc=0; citadel_ci_status 0123456789abcdef || rc=$?; echo "rc $rc"`).filter((l) => /^rc |^land: (a test|only known)/.test(l));
  };
  const [why, rc] = status(1);
  assert.match(why, /^land: a test was skipped in CI \(https:\/\/ci\/7\): every \.ts, /);
  assert.equal(rc, 'rc 1');
  assert.deepEqual(status(0), ['land: only known flakes failed in CI (https://ci/7): a known flake, so this goes on as green, with no fresh run', 'rc 0']);
});

test('tests.yml fails a run that skipped a test, red runs included, and says nothing about skips when node gave no summary (#1914)', () => {
  const yml = readFileSync(join(repo, '.github', 'workflows', 'tests.yml'), 'utf8');
  const step = yml.match(/^ {10}skips=\$\(sed[\s\S]*?^ {10}exit "\$rc"\n/m);
  assert.ok(step, 'the skip check at the end of the full suite step');
  const dir = mkdtempSync(join(root, 'skip-step-'));
  const end = (rc: number, log: string) => {
    writeFileSync(join(dir, 'tests.log'), log);
    const r = spawnSync('bash', ['-e', '-c', `rc=${rc}\n${step[0]}`], { encoding: 'utf8', env: { ...env, RUNNER_TEMP: dir } });
    return [r.status, /tests were skipped on this runner/.test(r.stdout)];
  };
  assert.deepEqual(end(0, 'ℹ skipped 0\n'), [0, false]);
  assert.deepEqual(end(0, 'ℹ skipped 1\n'), [1, true]);
  assert.deepEqual(end(0, ''), [1, true], 'a green run with no summary is no proof nothing was skipped');
  assert.deepEqual(end(1, 'ℹ skipped 0\n'), [1, false]);
  assert.deepEqual(end(1, 'ℹ skipped 2\n'), [1, true], 'a red run says so too');
  assert.deepEqual(end(3, 'ℹ skipped 2\n'), [3, true], "a red run keeps run-tests.sh's code");
  assert.deepEqual(end(1, ''), [1, false], 'cut short: no summary');
});
