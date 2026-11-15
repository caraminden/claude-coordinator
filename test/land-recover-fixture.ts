// The throwaway pipeline land-recover.test.ts and land-boot-check.test.ts share.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { git } from './git.ts';
import { until as waitUntil } from './wait.ts';
export { git };

// A bad commit can't stay on main (#553, the pipeline failure drill): the real land.sh and deploy.sh on a throwaway
// pipeline, with a boot check and a service that fail on request, and a queued restart that really runs
// `deploy.sh restart`. A checkout holding BOOT_BAD fails the boot check; one holding RUN_BAD never comes up.
export const tools = join(import.meta.dirname, '..', 'tools');
const root = mkdtempSync(join(tmpdir(), 'land-recover-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = {
  ...scriptEnv(), COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined, COORDINATOR_TICKET: undefined, COORDINATOR_TOKEN: undefined, COORDINATOR_API: undefined,
  NODE_TEST_CONTEXT: undefined, DEPLOY_TEST_CPU_WEIGHT: '', LAND_CI: '0', LAND_FIX: undefined, LAND_PREFLIGHT: undefined, DEPLOY_REMOTE: '', DEPLOY_NOW: undefined,
  DEPLOY_HEALTHY_WAIT: '2', DEPLOY_SETTLE: '1', DEPLOY_QUEUE_STALL: '120', DEPLOY_QUEUE_POLL: '1', DEPLOY_IDLE_TRIES: '30', DEPLOY_TEST_TIMEOUT: '120', DEPLOY_BACKUPS: '3',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null',
};
export const until = (what: string, cond: () => boolean, ms = 60_000) => waitUntil(what, cond, ms);

let n = 0;
export async function pipe(t: { after: (fn: () => void) => void }, worktrees: number) {
  const dir = join(root, String(++n));
  const source = join(dir, 'repo');
  mkdirSync(join(source, 'tools'), { recursive: true });
  mkdirSync(join(source, 'test'));
  git(source, 'init', '-q', '-b', 'main');
  for (const f of ['land.sh', 'deploy.sh', 'deploy-queue.sh', 'run-tests.sh', 'failed-files-reporter.ts', 'progress-reporter.ts', 'citadel-node', 'citadel-node.cjs']) copyFileSync(join(tools, f), join(source, 'tools', f));
  // TEST_MARK gets a line per run; TEST_GATE holds a run until that file is there; TEST_FAIL makes it red.
  writeFileSync(join(source, 'test', 'ok.test.mjs'), `import { appendFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
const { TEST_MARK: mark, TEST_GATE: gate, TEST_FAIL: fail } = process.env;
test('ok', async () => {
  if (mark) appendFileSync(mark, 'run\\n');
  while (gate && !existsSync(gate)) await new Promise((r) => setTimeout(r, 50));
  if (fail) throw new Error('red');
});
`);
  // BOOT_MARK: say it started (with its parent's pid) and wait for BOOT_GATE, so a test can kill the deploy mid-check.
  writeFileSync(join(source, 'tools', 'boot-check.ts'), `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { BOOT_MARK: mark, BOOT_GATE: gate } = process.env;
if (mark) {
  // deploy.sh's pid: it runs this under timeout(1), which is then the parent.
  const up = (pid: number) => Number(readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').pop()!.split(' ')[1]);
  const parent = process.ppid;
  writeFileSync(mark, String(readFileSync('/proc/' + parent + '/comm', 'utf8').trim() === 'timeout' ? up(parent) : parent));
  while (gate && !existsSync(gate)) await new Promise((r) => setTimeout(r, 50));
}
// BOOT_BROKEN: a file outside every checkout, so the check fails whatever the commit (a broken box, not a bad change).
if (existsSync(join(process.argv[2], 'BOOT_BAD')) || (process.env.BOOT_BROKEN && existsSync(process.env.BOOT_BROKEN))) process.exit(1);
console.log('v1');
`);
  writeFileSync(join(source, 'a.txt'), 'one\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'base');
  const base = git(source, 'rev-parse', 'main');
  const live = join(dir, 'live');
  git(dir, 'clone', '-q', source, live);
  git(live, 'tag', 'last-good');
  const wts = Array.from({ length: worktrees }, (_, i) => {
    const wt = join(dir, `wt${i + 1}`);
    git(source, 'worktree', 'add', '-q', '-b', `ticket/${i + 1}-x`, wt);
    return wt;
  });
  const running = join(dir, 'running'); // the commit the "server" runs; empty when it is down
  writeFileSync(running, base);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
for a; do case $a in
  restart) if [ -e "$DEPLOY_LIVE/RUN_BAD" ]; then : >"$PIPE/running"; else git -C "$DEPLOY_LIVE" rev-parse HEAD >"$PIPE/running"; fi; exit 0 ;;
  show) echo 100; exit 0 ;;
esac; done
exit 0
`, { mode: 0o755 });
  // The queued restart: the real \`deploy.sh restart\`, in the background, with what the unit would be given.
  writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
while [ $# -gt 0 ] && [ "$1" != bash ]; do case $1 in --setenv=*) export "\${1#--setenv=}" ;; esac; shift; done
unset DEPLOY_LOCKED DEPLOY_TESTED DEPLOY_QUEUE_TICKET
("$@" >>"$PIPE/restart.log" 2>&1; echo $? >>"$PIPE/restart.done") 9>&- 7>&- </dev/null >/dev/null 2>&1 &
`, { mode: 0o755 });
  const server = createServer((_, res) => {
    const commit = readFileSync(running, 'utf8').trim();
    if (!commit) { res.statusCode = 503; res.end(); return; }
    // An "interruptible" file: how many running turns a restart would cut off.
    const busy = join(dir, 'interruptible');
    res.end(JSON.stringify({ ok: true, commit, interruptible: existsSync(busy) ? Number(readFileSync(busy, 'utf8')) : 0 }));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const penv = { ...env, PATH: `${bin}:${process.env.PATH}`, PIPE: dir, DEPLOY_LIVE: live, DEPLOY_SOURCE: source, DEPLOY_URL: `http://127.0.0.1:${(server.address() as any).port}`, DEPLOY_DB: join(dir, 'none.db'), DEPLOY_SERVICE: 'citadel-test', DEPLOY_UNIT: 'citadel-test-restart' };
  const state = join(git(live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  return {
    dir, source, live, wts, base, state,
    commit(where: string, file: string, text: string) {
      writeFileSync(join(where, file), text);
      git(where, 'add', '-A');
      git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
      return git(where, 'rev-parse', 'HEAD');
    },
    // Never spawnSync: the stand-in server above answers from this process. In its own process group, so a test can
    // kill the landing alone or with everything it started.
    start(script: string, cwd: string, extra: Record<string, string> = {}) {
      const child = spawn('bash', [script], { cwd, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...penv, ...extra } });
      let stderr = '';
      child.stderr!.on('data', (d) => (stderr += d));
      const done = new Promise<{ status: number | null; stderr: string }>((ok) => child.once('close', (status) => ok({ status, stderr })));
      return { pid: child.pid!, done, stderr: () => stderr };
    },
    run(script: string, cwd: string, extra: Record<string, string> = {}) { return this.start(script, cwd, extra).done; },
    lockFree: () => spawnSync('flock', ['-n', join(state, 'lock'), 'true']).status === 0,
    restartLockFree: () => spawnSync('flock', ['-n', join(state, 'restart.lock'), 'true']).status === 0,
    restartsDone: () => (existsSync(join(dir, 'restart.done')) ? readFileSync(join(dir, 'restart.done'), 'utf8').trim().split('\n').length : 0),
    // Every queued restart runs on after the deploy that queued it: wait for the k-th to end. Its exit codes so far.
    async restarts(k: number) {
      const done = join(dir, 'restart.done');
      const codes = () => (existsSync(done) ? readFileSync(done, 'utf8').trim().split('\n') : []);
      await until(`restart ${k} to end`, () => codes().length >= k);
      return codes();
    },
    restartLog: () => (existsSync(join(dir, 'restart.log')) ? readFileSync(join(dir, 'restart.log'), 'utf8') : ''),
  };
}
export const land = join(tools, 'land.sh');
export const subjects = (dir: string) => git(dir, 'log', '--format=%s', 'main').split('\n');
