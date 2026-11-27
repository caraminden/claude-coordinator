// @ts-check
// A cloud helper's command job, run inside the Claude Code cloud session's VM (#2200, src/cloud-helper.ts). The helper sends
// this file in the session's brief (base64), so it works in any scheme's repo; node is there, as Claude Code runs on it.
// Plain JS on node's built-ins: nothing to install on the VM.
//
//   node cloud-run-vm.mjs <job, base64 JSON>
//
// The session's model runs that in the foreground with a 10-minute timeout, again and again until it prints DONE. The first
// call checks out the minion's commit and starts the job detached; every call waits up to WAIT_MS for it. So the model's
// turn stays open while the job runs (a turn that ends takes its commands with it), and the job never depends on the model:
// the job's own process pushes a progress commit every BEAT_MS to the beat branch, and pushes the result itself when it ends.
// Stop: the helper deletes `ref` when it's stopped, and the next beat that finds it gone kills the job and pushes nothing.
//   job: { ref: the branch with the minion's commit, branch: the result branch, beat: the progress branch, cmd: the command
//   (bash), minutes: its time limit, files: paths it makes that come home (each at most 5 MB, at most 19) }.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const DIR = process.env.CITADEL_RUN_DIR || '/tmp/citadel-run';
const BEAT_MS = Number(process.env.CITADEL_RUN_BEAT_MS) || 120_000;
const WAIT_MS = Number(process.env.CITADEL_RUN_WAIT_MS) || 540_000;
const MAX_BYTES = 5 * 1024 * 1024;
const LOG = join(DIR, 'output.log');
const CODE = join(DIR, 'code');
const SKIP = '[skip ci]';

/** @typedef {{ ref: string, branch: string, beat: string, cmd: string, minutes: number, files: string[] }} VmJob */

/** @param {string[]} args @param {Record<string, string>} [env] */
const git = (args, env = {}) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'citadel', GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'citadel@localhost', GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'citadel', GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'citadel@localhost', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

/** A file's last `bytes`, read without loading the rest (a verbose build's log can outgrow the VM's memory). @param {string} file @param {number} bytes */
function end(file, bytes) {
  const size = statSync(file).size;
  const buf = Buffer.alloc(Math.min(size, bytes));
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, buf.length, size - buf.length);
  } finally {
    closeSync(fd);
  }
  return buf;
}

/** The last `n` lines of the output so far. @param {number} n */
export function tail(n) {
  if (!existsSync(LOG)) return '';
  const buf = end(LOG, 64 * 1024);
  return String(buf)
    .split('\n')
    .slice(-n - 1)
    .join('\n')
    .trim();
}

/** A blob of `body` in the repo's objects. @param {string | Buffer} body */
const blob = (body) => execFileSync('git', ['hash-object', '-w', '--stdin'], { input: body, encoding: 'utf8' }).trim();

/** A commit of these files (path → blob) with no parent, never touching the checkout or its index. @param {Record<string, string>} files @param {string} message */
function commitOf(files, message) {
  const index = join(DIR, 'index');
  const env = { GIT_INDEX_FILE: index };
  git(['read-tree', '--empty'], env);
  for (const [path, sha] of Object.entries(files)) git(['update-index', '--add', '--cacheinfo', `100644,${sha},${path}`], env);
  const tree = git(['write-tree'], env);
  return git(['commit-tree', tree, '-m', message]);
}

/** @param {string} sha @param {string} branch */
const push = (sha, branch) => git(['push', '-q', '-f', 'origin', `${sha}:refs/heads/${branch}`]);

/** The result the helper reads: a reply with the exit code and the output's end, the whole output, and the files asked for. @param {VmJob} job @param {number} code @param {number} minutes */
export function resultFiles(job, code, minutes) {
  /** @type {Record<string, string>} */
  const files = {};
  /** @type {string[]} */
  const listed = [];
  /** @type {string[]} */
  const left = [];
  files['.citadel/out/output.log'] = blob(existsSync(LOG) ? end(LOG, MAX_BYTES) : Buffer.alloc(0));
  listed.push('.citadel/out/output.log');
  for (const f of job.files.slice(0, 19)) {
    const out = `.citadel/out/${basename(f)}`;
    if (!existsSync(f) || statSync(f).size > MAX_BYTES || files[out]) {
      left.push(f);
      continue;
    }
    files[out] = blob(readFileSync(f));
    listed.push(out);
  }
  const why = code === 124 ? `stopped at its ${job.minutes}-minute limit` : `exit ${code}`;
  const reply = [`\`${job.cmd}\`: ${why} after ${minutes} min in the cloud.`, left.length ? `Not found, or over 5 MB: ${left.map((f) => `\`${f}\``).join(', ')}.` : '', `The output's end:\n\n\`\`\`\n${tail(40)}\n\`\`\``].filter(Boolean).join('\n\n');
  files['.citadel/result.json'] = blob(JSON.stringify({ job: job.branch, code, reply, card: null, files: listed }));
  return files;
}

/** The job's own process: run the command, beat while it runs, push the result. @param {VmJob} job */
async function child(job) {
  const began = Date.now();
  const out = openSync(LOG, 'a');
  const p = spawn('bash', ['-c', job.cmd], { stdio: ['ignore', out, out], detached: true });
  const minutes = () => Math.round((Date.now() - began) / 60_000);
  let timedOut = false;
  /** @type {Promise<number>} */
  const ended = new Promise((r) => p.once('exit', (c, sig) => r(c ?? (sig ? 128 + (constants.signals[sig] ?? 15) : 1))));
  const limit = setTimeout(() => {
    timedOut = true;
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {}
  }, job.minutes * 60_000);
  let stopped = false;
  const gone = () => spawnSync('git', ['ls-remote', '--exit-code', 'origin', `refs/heads/${job.ref}`], { stdio: 'ignore' }).status === 2;
  const stop = () => {
    stopped = true;
    try {
      if (p.pid) process.kill(-p.pid, 'SIGKILL');
    } catch {}
  };
  const beat = async () => {
    // ls-remote's exit 2: the branch is gone, so the helper was stopped (a network error is 128, and the job goes on).
    if (gone()) return stop();
    try {
      const last = tail(3).split('\n').at(-1)?.slice(0, 300) ?? '';
      push(commitOf({}, `${SKIP} ${minutes()} min${last ? `: ${last}` : ''}`), job.beat);
    } catch (err) {
      writeFileSync(join(DIR, 'beat-error'), String(err));
      return;
    }
    // The helper's Stop deletes the source, then the beat branch: a Stop between the check above and this push would
    // leave the beat branch on origin for good, so look again and delete it ourselves (#2230).
    if (gone()) {
      spawnSync('git', ['push', '-q', 'origin', '--delete', job.beat], { stdio: 'ignore' });
      stop();
    }
  };
  await beat();
  const timer = setInterval(beat, BEAT_MS);
  const c = await ended;
  clearTimeout(limit);
  clearInterval(timer);
  const final = timedOut ? 124 : c;
  if (stopped) return writeFileSync(CODE, 'stopped');
  // The result is pushed before `code` is written: DONE means it went (or its push failed, said in `push-error`).
  for (let i = 0; i < 3; i++) {
    try {
      push(commitOf(resultFiles(job, final, minutes()), `${SKIP} result`), job.branch);
      writeFileSync(join(DIR, 'pushed'), '');
      break;
    } catch (err) {
      writeFileSync(join(DIR, 'push-error'), String(err));
      await sleep(5000);
    }
  }
  writeFileSync(CODE, String(final));
}

/** Each call of the model's: start the job once, then wait for it up to WAIT_MS. @param {VmJob} job */
async function waiter(job) {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(join(DIR, 'started'))) {
    git(['fetch', '-q', '--depth=1', 'origin', job.ref]);
    git(['checkout', '-q', '--detach', 'FETCH_HEAD']);
    writeFileSync(join(DIR, 'started'), String(Date.now()));
    spawn(process.execPath, [process.argv[1], '--child', process.argv[2]], { detached: true, stdio: 'ignore' }).unref();
  }
  const until = Date.now() + WAIT_MS;
  while (!existsSync(CODE) && Date.now() < until) await sleep(5000);
  const mins = Math.round((Date.now() - Number(readFileSync(join(DIR, 'started'), 'utf8'))) / 60_000);
  if (!existsSync(CODE)) return console.log(`STILL RUNNING after ${mins} min. Run the same command again, in the foreground.\n${tail(3)}`);
  if (readFileSync(CODE, 'utf8') === 'stopped') return console.log('STOPPED: Citadel stopped this job. Stop now.');
  const err = existsSync(join(DIR, 'push-error')) && !existsSync(join(DIR, 'pushed')) ? readFileSync(join(DIR, 'push-error'), 'utf8') : '';
  console.log(`DONE: exit ${readFileSync(CODE, 'utf8')} after ${mins} min. Its result is pushed to ${job.branch}${err ? ` (the last push failed: ${err.slice(0, 300)})` : ''}. Stop now.`);
}

if (import.meta.url === pathToFileURL(String(process.argv[1])).href) {
  const child_ = process.argv[2] === '--child';
  /** @type {VmJob} */
  const job = JSON.parse(Buffer.from(String(process.argv[child_ ? 3 : 2]), 'base64').toString('utf8'));
  (child_ ? child(job) : waiter(job)).catch((err) => {
    console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
