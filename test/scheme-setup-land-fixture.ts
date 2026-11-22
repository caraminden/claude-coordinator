// The throwaway repos and helpers scheme-setup-land.test.ts and scheme-setup-land-ci.test.ts share.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { git } from './git.ts';
import { until } from './wait.ts';
export { git };

// The scheme-setup kit skill's land.sh template, on throwaway repos: a scheme repo on main with the
// template's pre-push hook active, a bare origin, and a minion worktree that lands through it.
const templates = join(import.meta.dirname, '..', 'kit', 'skills', 'scheme-setup', 'templates');
export const root = mkdtempSync(join(tmpdir(), 'scheme-land-'));
after(() => rmSync(root, { recursive: true, force: true }));
// COORDINATOR_CONTAINER: the template refuses in a container turn (#577), and these tests run there too.
// COORDINATOR_SHARED_DIR: a turn's real shared folder, where the timing line would go (the retro log); unset, it goes in .git.
export const env = { ...scriptEnv({ COORDINATOR_CONTAINER: undefined, COORDINATOR_SHARED_DIR: undefined }), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };

// The timing lines in a log folder (#1320), every day's land.md: a run may cross midnight UTC.
export const timingLines = (dir: string) =>
  readdirSync(dir).sort().flatMap((day) => readFileSync(join(dir, day, 'land.md'), 'utf8').split('\n')).filter((l) => l.includes(' · timing · '));

export let n = 0;
// local: the scheme's tools/land.local.sh, which the template sources (none: no such file).
export function setup(check = 'test ! -e red', config: Record<string, string> = {}, local?: string) {
  const dir = join(root, String(++n));
  const main = join(dir, 'repo');
  mkdirSync(join(main, 'tools'), { recursive: true });
  mkdirSync(join(main, '.githooks'));
  git(main, 'init', '-q', '-b', 'main');
  copyFileSync(join(templates, 'land.sh'), join(main, 'tools', 'land.sh'));
  copyFileSync(join(templates, 'pre-push'), join(main, '.githooks', 'pre-push'));
  chmodSync(join(main, 'tools', 'land.sh'), 0o755);
  chmodSync(join(main, '.githooks', 'pre-push'), 0o755);
  // The check (by default red while a file named "red" exists).
  const landSh = join(main, 'tools', 'land.sh');
  let script = readFileSync(landSh, 'utf8').replace(/^CHECK=.*$/m, () => `CHECK='${check}'`);
  // The early check (#1177) off unless a test turns it on: the tests here gate or count the check in line, and the early
  // one would run it first, before the line. Its own tests are in scheme-setup-land-early.test.ts.
  for (const [key, value] of Object.entries({ EARLY_CHECK: '0', ...config })) script = script.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}='${value}'`);
  writeFileSync(landSh, script);
  if (local !== undefined) writeFileSync(join(main, 'tools', 'land.local.sh'), local);
  writeFileSync(join(main, 'a.txt'), 'one\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'base');
  git(main, 'config', 'core.hooksPath', '.githooks');
  const origin = join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', main, origin);
  git(main, 'remote', 'add', 'origin', origin);
  const wt = join(dir, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'ticket/1-x', wt);
  const commit = (where: string, file: string, text: string) => {
    mkdirSync(dirname(join(where, file)), { recursive: true });
    writeFileSync(join(where, file), text);
    git(where, 'add', '-A');
    git(where, 'commit', '-qm', `${file}: ${text.trim()}`);
  };
  const run = (extra: Record<string, string> = {}) => spawnSync('bash', [join(wt, 'tools', 'land.sh')], { cwd: join(wt, 'tools'), encoding: 'utf8', timeout: 90_000, env: { ...env, ...extra } });
  return { dir, main, origin, wt, commit, run };
}

export const landLockFree = (r: ReturnType<typeof setup>) =>
  spawnSync('flock', ['-n', join(git(r.main, 'rev-parse', '--absolute-git-dir'), 'land.lock'), 'true']).status === 0;
// The line for the land lock (the queue_* functions in the template, from Citadel's tools/deploy-queue.sh,
// #502). The kernel grants a flock in no order, so several landings waiting on it at once (2026-11-10)
// meant some lost every round and timed out. Fake work: the check waits for a file named in $GATE.
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
export { until };
const gated = 'until [ -e "$GATE" ]; do sleep 0.05; done';
export function queueSetup(branches: number, check = gated, config: Record<string, string> = {}, files = (i: number) => `f${i}.txt`, local?: string) {
  const r = setup(check, config, local);
  const state = git(r.main, 'rev-parse', '--absolute-git-dir');
  const gate = join(r.dir, 'gate');
  const wts = [r.wt];
  for (let i = 2; i <= branches; i++) git(r.main, 'worktree', 'add', '-q', '-b', `ticket/${i}-x`, wts[wts.push(join(r.dir, `wt${i}`)) - 1]);
  wts.forEach((wt, i) => r.commit(wt, files(i + 1), `${i + 1}\n`));
  const tickets = () => (existsSync(join(state, 'land-queue')) ? readdirSync(join(state, 'land-queue')).filter((f) => /^\d+$/.test(f)).sort() : []);
  const issued = () => (existsSync(join(state, 'land-queue', '.seq')) ? Number(readFileSync(join(state, 'land-queue', '.seq'), 'utf8')) : 0);
  const phase = (ticket: string) => { try { return readFileSync(join(state, 'land-queue', ticket), 'utf8').split('\n')[3]; } catch { return ''; } };
  // Landing i (from 1), started and left running.
  const land = (i: number, extra: Record<string, string> = {}) => {
    const child = spawn('bash', [join(wts[i - 1], 'tools', 'land.sh')], { cwd: wts[i - 1], stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, GATE: gate, LAND_QUEUE_POLL: '0.05', ...extra } });
    let stderr = '';
    child.stderr!.on('data', (d) => (stderr += d));
    // A landing that never ends fails its test by name instead of hanging the whole run (#560).
    const exit = new Promise<number | null>((ok, no) => {
      const late = setTimeout(() => no(new Error(`land.sh was still running after 60 s:\n${stderr}`)), 60_000);
      child.on('close', (code) => { clearTimeout(late); ok(code); });
    });
    exit.catch(() => {}); // for a test that had already failed on something else
    return { child, exit, stderr: () => stderr };
  };
  const open = () => writeFileSync(gate, '');
  const landed = () => git(r.main, 'log', '--reverse', '--format=%s', 'main').split('\n').slice(1);
  return { ...r, state, wts, tickets, issued, phase, land, open, landed };
}

// land_rebased (Peek's ask, 2026-11-20): a file generated from the whole tree, rebuilt on the branch once it sits on
// today's main, before its check. It logs each call and commits rebased.txt naming the base it was given.
export const rebasedHook = `land_rebased() {
  echo "$1 $2" >>"$(git rev-parse --path-format=absolute --git-common-dir)/rebased.log"
  echo "$1" >rebased.txt
  git add rebased.txt
  git commit -qm "rebased on $1"
}
`;
export const rebasedCalls = (main: string) => { try { return readFileSync(join(git(main, 'rev-parse', '--absolute-git-dir'), 'rebased.log'), 'utf8').trim().split('\n'); } catch { return []; } };
