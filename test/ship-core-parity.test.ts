// Where Citadel's ship pipeline and the kit's core (kit/skills/scheme-setup/templates/land.sh) must agree: the order of
// a deploy line holding both kinds of ticket, read by the server for every scheme (the ship scripts' ultra review,
// 2026-11-23, fix C); and land.sh's reading of a red CI run against the jq both scripts use.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readQueue, writeOrder } from '../src/waits.ts';
import { scriptEnv } from './script-env.ts';
import { landText } from './land-files.ts';

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

// Person's drag wins (Cara, 2026-11-24): a ship a person placed (.order's "#pin" line, written by the server) stays ahead
// of one that holds the line; the holder goes right behind the last pinned ship still waiting, ahead of the other ranks.
test('a holding ticket goes behind the ships a person placed, ahead of the rest, in the core, deploy-queue.sh and the server', () => {
  const q = mkdtempSync(join(root, 'queue-pin-'));
  writeFileSync(join(q, '0000000001'), deployTicket('deploy-a'));
  writeFileSync(join(q, '0000000002'), coreTicket('core-b'));
  writeFileSync(join(q, '0000000003'), deployTicket('deploy-c'));
  writeFileSync(join(q, '0000000004'), [...deployTicket('deploy-held').trimEnd().split('\n').slice(0, 5), 'hold'].join('\n') + '\n');
  // b and c placed by a person (9 shipped already, so it counts for nothing); a ranked first by a Taskmaster.
  writeFileSync(join(q, '.order'), '# Cara moved core-b\n0000000001\n0000000002\n0000000003\n#pin 2 9\n');
  const core = bash(`${fn(template, 'queue_order')}Q_DIR=$1; queue_order; printf '%s\\n' "\${Q_ORDER[@]}"`, q);
  const deploy = bash(`. "$2"; queue_order "$1"; for t in "$1"/[0-9]*; do t=\${t##*/}; echo "$(queue_key "$t") $t"; done | LC_ALL=C sort | cut -d' ' -f2`, q, deployQueue);
  const server = readQueue(q, 4, () => true).map((t) => String(t.seq).padStart(10, '0'));
  const want = ['0000000001', '0000000002', '0000000004', '0000000003'];
  assert.deepEqual(deploy, want, 'deploy-queue.sh');
  assert.deepEqual(server, want, 'the server (src/waits.ts)');
  assert.deepEqual(core, want, 'the kit core');
  // The server writes the pins it is given, and a reader still finds every rank and who set it.
  const line = readQueue(q, 4, () => true);
  writeOrder(q, line, [2, 1], 'Cara moved core-b', 2, [2]);
  assert.match(readFileSync(join(q, '.order'), 'utf8'), /^# Cara moved core-b\n0000000002\n0000000001\n0000000004\n0000000003\n#pin 2\n$/);
});

// A placed ship that is landing has left the line: it pins nothing, or the holder would wait behind a ship it passed.
test('a pinned ship that is landing no longer keeps a holding ticket behind the waiters it was placed after', () => {
  const q = mkdtempSync(join(root, 'queue-pin-landing-'));
  writeFileSync(join(q, '0000000001'), deployTicket('deploy-a'));
  writeFileSync(join(q, '0000000002'), coreTicket('core-b').replace('\n0\n', '\n1764000000\n')); // it has the lock
  writeFileSync(join(q, '0000000003'), [...deployTicket('deploy-held').trimEnd().split('\n').slice(0, 5), 'hold'].join('\n') + '\n');
  writeFileSync(join(q, '.order'), '0000000001\n0000000002\n#pin 2\n');
  const core = bash(`${fn(template, 'queue_order')}Q_DIR=$1; queue_order; printf '%s\\n' "\${Q_ORDER[@]}"`, q);
  const deploy = bash(`. "$2"; queue_order "$1"; for t in 0000000001 0000000003; do echo "$(queue_key "$t") $t"; done | LC_ALL=C sort | cut -d' ' -f2`, q, deployQueue);
  const server = readQueue(q, 4, () => true).map((t) => String(t.seq).padStart(10, '0'));
  assert.deepEqual(deploy, ['0000000003', '0000000001'], 'deploy-queue.sh');
  assert.deepEqual(
    server.filter((t) => t !== '0000000002'),
    ['0000000003', '0000000001'],
    'the server (src/waits.ts)',
  );
  assert.deepEqual(
    core.filter((t) => t !== '0000000002'),
    ['0000000003', '0000000001'],
    'the kit core',
  );
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

// #1864 (DR1, LB6): GitHub's answers as each script reads them. A lost runner leaves a failed job with no failed
// step, an unanswered call is no answer, and the PC's port check runs after a green suite: none is a red.
const JOBS = {
  suite: { jobs: [{ steps: [{ name: 'the full suite', conclusion: 'failure' }] }] },
  lost: {
    jobs: [
      {
        steps: [
          { name: 'Set up job', conclusion: 'success' },
          { name: 'the full suite', conclusion: null },
        ],
      },
    ],
  },
  unstarted: { jobs: [{ steps: null }] },
  ports: {
    jobs: [
      {
        steps: [
          { name: 'the full suite', conclusion: 'success' },
          { name: 'Windows ports left behind', conclusion: 'failure' },
        ],
      },
    ],
  },
  setup: { jobs: [{ steps: [{ name: "the runner user's systemd", conclusion: 'failure' }] }] },
  none: { jobs: [] },
};
// What both scripts' jq says of each, worked out here: CI's runners have no jq. A change to the expression changes both.
const STEP_JQ = '[.jobs[].steps[]? | select(.conclusion == "failure") | .name][0] // (if (.jobs | length) == 0 then "no jobs" else "no failed step" end)';
const stepOf = (j: { jobs: { steps: { name: string; conclusion: string | null }[] | null }[] }) => j.jobs.flatMap((job) => job.steps ?? []).find((s) => s.conclusion === 'failure')?.name ?? (j.jobs.length === 0 ? 'no jobs' : 'no failed step');
test('what a failed run means in land.sh: 1 only when a step that runs the tests failed', () => {
  const land = landText();
  const cut = (a: string, b: string) => land.slice(land.indexOf(a), land.indexOf(b, land.indexOf(a)));
  const verdict = cut('    failure)\n      # Red only when', '    timed_out) return 1');
  const consts = [...land.matchAll(/^ *CI_(?:CLOCK_|PORTS_)?STEP=.*$/gm)].map((m) => m[0].trim()).join('\n');
  const dir = mkdtempSync(join(root, 'verdict-'));
  // `gh api … --jq <expr>` answers $STEP, what that expression says of the run; `down` answers nothing.
  const gh = `fake() { case "$*" in
    *head_sha*) printf '7\\tcompleted\\tfailure\\thttps://ci/7\\n' ;;
    *"/jobs"*) [ "$STEP" != down ] || return 1; local e; while [ $# -gt 0 ]; do [ "$1" != --jq ] || e=$2; shift; done; [ "$e" = "$STEP_JQ" ] && echo "$STEP" ;;
    *"run view"*) [ "$LOG" != down ] || return 1; printf 'job\\tstep\\t2026-11-24T00:00:00Z %s\\n' "$LOG" ;;
  esac; }`;
  const landRc = (step: string) => {
    const script = `${gh}
say() { :; }; retro_log() { :; }; ci_said() { :; }; ci_down() { :; }; hub() { fake "$@"; }; state=${dir} CI_POLL=0 ci_slug=o/r ci_id=7 ci_url=u short=s branch=b ci_lost='' burn_red='' CI_BURN_STEP='burn in new and changed tests'
${consts}
${fn(join(repo, 'tools', 'land', 'common.sh'), 'ci_fact')}
v() { case failure in
${verdict}
esac; }
rc=0; v || rc=$?; echo "$rc\${ci_lost:+ lost}"`;
    return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...env, STEP_JQ, STEP: step } });
  };
  // Where there is a jq, its own answer is held to the one worked out here.
  if (spawnSync('jq', ['--version']).status === 0) for (const [k, j] of Object.entries(JOBS)) assert.equal(spawnSync('jq', ['-r', STEP_JQ], { encoding: 'utf8', input: JSON.stringify(j) }).stdout.trim(), stepOf(j), k);
  const want: [string, string][] = [
    ['suite', '1'],
    ['lost', '1 lost'],
    ['unstarted', '1 lost'],
    ['ports', '0'],
    ['setup', '2'],
    ['none', '1'],
    ['down', '2'],
  ];
  for (const [k, a] of want) {
    const step = k === 'down' ? 'down' : stepOf(JOBS[k as keyof typeof JOBS]);
    const l = landRc(step);
    assert.equal(l.stdout.trim(), a, `land.sh, ${k}: ${l.stdout}${l.stderr}`);
  }
});
