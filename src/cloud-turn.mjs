// A minion's turn as a Claude Code cloud session (#2153, src/cloud-pool.ts). The turn's wrapper (src/turn-run.mjs) runs this
// in claude's place, on the same login and in the same place a claude turn would run, so the chat, stop and liveness work as
// for any turn: it prints stream-json on stdout and exits when the turn is over. Plain JS, pinned with the turn.
//
//   node cloud-turn.mjs <cloud.json>
//
// cloud.json (written by the runner): `claude` the CLI, `cwd` a checkout whose origin is the scheme's GitHub repo, `branch`
// the session's result branch, `session` (null: start one) and `sha` (the last result read), `text` what to send, `files`
// where result files go, and `limitMs`, `pollMs`, `startMs`.
//
// A start needs a terminal: `claude --cloud` refuses -p (#2147). It runs under util-linux `script` (no native pty in node),
// answering the first-run screens with Enter, until the session's id shows; a follow-up is `claude -p <text> --cloud <id>`.
// Then it polls `cloud/<id>` on origin for a new commit, reads `.citadel/result.json` from it, copies the files it lists,
// posts its card through the same route ask_question uses, and deletes the branch. A session that never pushes (a repo whose
// push hooks refuse on the VM) is read back with `claude --teleport` in a throwaway clone, from the result it prints.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const RESULT = '.citadel/result.json';
export const BEGIN = 'CITADEL-RESULT-BEGIN';
export const END = 'CITADEL-RESULT-END';
/** Result files copied at most, and their size. */
const MAX_FILES = 20;
const MAX_BYTES = 5 * 1024 * 1024;

/** @typedef {{ claude: string, cwd: string, branch: string, last?: string | null, session: string | null, sha: string | null, text: string, files: string | null, limitMs: number, pollMs: number, startMs: number }} CloudJob */
/** @typedef {{ questions: unknown[] }} Card */
/** @typedef {{ reply: string, card: Card | null, files: string[] }} CloudResult */

/** @param {object} ev */
const emit = (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`);
/** @param {string} text */
const say = (text) => emit({ type: 'assistant', message: { role: 'assistant', model: 'cloud', content: [{ type: 'text', text }] } });

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are what it strips
const ANSI = /\x1b\[[0-9;?<>]*[a-zA-Z~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>78()][0-9A-Za-z]?/g;
/** A terminal's output as text: escapes gone. @param {string} s */
export const plain = (s) => s.replace(ANSI, '');

/** The session's id (and link) in a start's screen, once it shows. @param {string} screen */
export function sessionIn(screen) {
  const text = plain(screen);
  const m = text.match(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]+)/) ?? text.match(/\b(session_[A-Za-z0-9]{8,})/);
  if (!m) return null;
  return { session: m[1], url: m[0].startsWith('http') ? m[0] : null };
}

/** What to press on a first-run screen: the trust prompt takes the option below the cursor (as #2147's driver did), the rest Enter. @param {string} screen */
export function keyFor(screen) {
  const flat = plain(screen).slice(-3000).replace(/\s+/g, '');
  if (/Itrustthisfolder/i.test(flat)) return '\x1b[B\r';
  if (/Choosethetextstyle|Syntaxtheme|Pressenter|Entertoconfirm|Yes,proceed|Securitynotes|Entertocontinue/i.test(flat)) return '\r';
  return null;
}

/**
 * A result as the session wrote it, checked: it comes from outside, so anything not of its shape is refused.
 * @param {string} text @returns {CloudResult}
 */
export function readResult(text) {
  /** @type {unknown} */
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object') throw new Error('the result is not a JSON object');
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (typeof r.reply !== 'string') throw new Error('the result has no reply');
  const card = r.card && typeof r.card === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (r.card).questions) ? { questions: /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (r.card).questions) } : null;
  const files = Array.isArray(r.files) ? r.files.filter((f) => typeof f === 'string' && /^\.citadel\/out\/[^\0]+$/.test(f) && !f.split('/').includes('..')).slice(0, MAX_FILES) : [];
  return { reply: r.reply, card, files };
}

/** The result a session printed between the markers (the teleport read-back), or null. @param {string} screen */
export function printedResult(screen) {
  const text = plain(screen);
  const at = text.lastIndexOf(BEGIN);
  const end = at < 0 ? -1 : text.indexOf(END, at);
  return end < 0 ? null : text.slice(at + BEGIN.length, end).trim();
}

/**
 * Run a command; its stdout. Rejects on a non-zero exit.
 * @param {string} cmd @param {string[]} args @param {{ cwd?: string, timeout?: number }} [opts]
 * @returns {Promise<string>}
 */
async function run(cmd, args, opts = {}) {
  return String(await runBytes(cmd, args, opts));
}

/** run's stdout as bytes. @param {string} cmd @param {string[]} args @param {{ cwd?: string, timeout?: number }} [opts] @returns {Promise<Buffer>} */
function runBytes(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 120_000, maxBuffer: MAX_BYTES * 2, encoding: 'buffer' }, (err, stdout, stderr) =>
      err
        ? reject(
            new Error(
              `${basename(cmd)} ${args[0]}: ${String(stderr || err.message)
                .trim()
                .slice(0, 500)}`,
            ),
          )
        : resolve(stdout),
    );
  });
}

/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set();

/**
 * Run `claude <flag> <value>` under a pseudo-terminal, pressing through the first-run screens, until `done` finds what it waits for
 * in the screen or `ms` pass. Its process is stopped either way; returns what `done` found, or null.
 * @template T
 * @param {CloudJob} job @param {string} flag @param {string} value @param {string} cwd @param {number} ms @param {(screen: string) => T | null} done
 * @returns {Promise<{ found: T | null, screen: string }>}
 */
async function underPty(job, flag, value, cwd, ms, done) {
  const valueFile = join(mkdtempSync(join(tmpdir(), 'cloud-')), 'value');
  writeFileSync(valueFile, value);
  // stty: a wide screen, so the session's link isn't broken across lines. The value goes by file, never through a shell's quoting.
  const cmd = 'stty cols 200 rows 50 2>/dev/null; exec "$CLOUD_CLAUDE" "$CLOUD_FLAG" "$(cat "$CLOUD_VALUE")"';
  const child = spawn('script', ['-qfec', cmd, '/dev/null'], { cwd, env: { ...process.env, SHELL: '/bin/sh', CLOUD_CLAUDE: job.claude, CLOUD_FLAG: flag, CLOUD_VALUE: valueFile, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  children.add(child);
  let screen = '';
  let lastKey = 0;
  /** @type {T | null} */
  let found = null;
  child.stdin.on('error', () => {});
  child.stdout.on('data', (b) => {
    const chunk = String(b);
    screen = (screen + chunk).slice(-200_000);
    // A cursor-position query waits for an answer.
    if (chunk.includes('\x1b[6n')) child.stdin.write('\x1b[1;1R');
  });
  const exited = new Promise((r) => child.once('exit', r));
  const until = Date.now() + ms;
  let gone = false;
  void exited.then(() => (gone = true));
  while (Date.now() < until && !gone) {
    found = done(screen);
    if (found) break;
    const key = keyFor(screen.slice(-20_000));
    if (key && Date.now() - lastKey > 3000) {
      child.stdin.write(key);
      lastKey = Date.now();
      screen = '';
    }
    await sleep(250);
  }
  found ??= done(screen);
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  } catch {}
  await Promise.race([exited, sleep(3000)]);
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {}
  children.delete(child);
  rmSync(join(valueFile, '..'), { recursive: true, force: true });
  return { found, screen };
}

/** The sha `branch` has on origin, or null while it has none. @param {CloudJob} job */
async function remoteSha(job, branch = job.branch) {
  const out = await run('git', ['-C', job.cwd, 'ls-remote', 'origin', `refs/heads/${branch}`]);
  return out.split(/\s/)[0] || null;
}

/**
 * Read the result at `sha`, copying its files into the minion's files folder, then delete the branch.
 * @param {CloudJob} job @param {string} sha @returns {Promise<CloudResult>}
 */
async function fetchResult(job, sha, branch = job.branch) {
  const ref = `refs/citadel-cloud/${branch}`;
  await run('git', ['-C', job.cwd, 'fetch', '-q', 'origin', `+refs/heads/${branch}:${ref}`]);
  let read = false;
  try {
    const result = readResult(await run('git', ['-C', job.cwd, 'show', `${sha}:${RESULT}`]));
    if (job.files && result.files.length) {
      mkdirSync(job.files, { recursive: true });
      for (const f of result.files) {
        const body = await runBytes('git', ['-C', job.cwd, 'cat-file', 'blob', `${sha}:${f}`]).catch(() => null);
        if (body && body.length <= MAX_BYTES) writeFileSync(join(job.files, basename(f)), body);
      }
    }
    read = true;
    return result;
  } finally {
    await run('git', ['-C', job.cwd, 'update-ref', '-d', ref]).catch(() => {});
    // A result read: its branch goes. One that couldn't be read stays on origin for a look.
    if (read) await run('git', ['-C', job.cwd, 'push', '-q', 'origin', '--delete', branch]).catch((err) => say(`Could not delete the result branch \`${branch}\`: ${err.message}`));
  }
}

/**
 * An answer pushed after its turn ended (a Stop, or the time limit), on the last turn's branch: each turn has a branch of
 * its own, so a late answer is never read as the reply to the next message.
 * @param {CloudJob} job @returns {Promise<CloudResult | null>}
 */
async function lateResult(job) {
  if (!job.last || job.last === job.branch) return null;
  const sha = await remoteSha(job, job.last).catch(() => null);
  if (!sha || sha === job.sha) return null;
  return fetchResult(job, sha, job.last).catch(() => null);
}

/** The reply as the chat shows it: the card posted, its files linked. @param {CloudJob} job @param {CloudResult} result */
async function shown(job, result) {
  let reply = result.reply;
  if (result.card) {
    const href = await postCard(result.card).catch((err) => err);
    if (href instanceof Error) reply += `\n\nIts card couldn't be posted (${href.message}). It asked:\n${result.card.questions.map((q) => `- ${JSON.stringify(q)}`).join('\n')}`;
  }
  if (result.files.length && job.files) reply += `\n\nFiles: ${result.files.map((f) => `[${basename(f)}](${join(job.files, basename(f))})`).join(', ')}`;
  return reply;
}

/** The result read back through `claude --teleport`, in a throwaway clone so the minion's checkout is never touched. @param {CloudJob} job @param {string} session */
async function teleport(job, session) {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-teleport-'));
  try {
    const url = (await run('git', ['-C', job.cwd, 'remote', 'get-url', 'origin'])).trim();
    await run('git', ['clone', '-q', '--shared', job.cwd, join(dir, 'repo')]);
    await run('git', ['-C', join(dir, 'repo'), 'remote', 'set-url', 'origin', url]);
    const { found } = await underPty(job, '--teleport', session, join(dir, 'repo'), 90_000, printedResult);
    return found ? readResult(found) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Post the result's card on the minion, as ask_question does. @param {Card} card */
async function postCard(card) {
  const api = process.env.COORDINATOR_API ?? 'http://127.0.0.1:8573';
  const res = await fetch(`${api}/api/tickets/${process.env.COORDINATOR_TICKET}/questions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.COORDINATOR_TOKEN ?? ''}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ questions: card.questions }),
  });
  const data = /** @type {{ error?: string, href?: string }} */ (await res.json().catch(() => ({})));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.href ?? null;
}

/** @param {string} text @param {boolean} [error] */
function end(text, error = false) {
  emit({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: error, result: text, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 } });
}

/** @param {CloudJob} job */
export async function cloudTurn(job) {
  const began = Date.now();
  let session = job.session;
  if (!session) {
    const { found, screen } = await underPty(job, '--cloud', job.text, job.cwd, job.startMs, sessionIn);
    if (!found) return end(`The cloud session didn't start within ${Math.round(job.startMs / 1000)} s. Its screen ended:\n\n${plain(screen).trim().slice(-800)}`, true);
    session = found.session;
    emit({ type: 'system', subtype: 'cloud', session, url: found.url, branch: job.branch });
    say(`Started a cloud session${found.url ? `: ${found.url}` : ` (${session})`}. Its result comes back on \`${job.branch}\`.`);
  } else {
    const late = await lateResult(job);
    if (late) say(`Its answer to the last message came in after that turn ended:\n\n${await shown(job, late)}`);
    const out = await run(job.claude, ['-p', job.text, '--cloud', session, '--output-format', 'json'], { cwd: job.cwd }).catch((err) => err);
    if (out instanceof Error) return end(`Could not send this to the cloud session ${session}: ${out.message}`, true);
    emit({ type: 'system', subtype: 'cloud', session, branch: job.branch }); // this turn's branch, kept for the next one's late look
    say(`Sent to the cloud session ${session}; waiting for its next result on \`${job.branch}\`.`);
  }
  /** @type {CloudResult | null} */
  let result = null;
  /** Why the last look at origin or teleport failed, for the message if nothing comes back. */
  let failed = '';
  /** @param {unknown} err */
  const note = (err) => {
    failed = err instanceof Error ? err.message : String(err);
    return null;
  };
  for (;;) {
    const sha = await remoteSha(job).catch(note);
    if (sha && sha !== job.sha) {
      try {
        result = await fetchResult(job, sha);
      } catch (err) {
        emit({ type: 'system', subtype: 'cloud', session, branch: job.branch, sha });
        return end(`The cloud session pushed \`${job.branch}\` (${sha.slice(0, 9)}) but its result couldn't be read: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      emit({ type: 'system', subtype: 'cloud', session, branch: job.branch, sha });
      break;
    }
    if (Date.now() - began >= job.limitMs) {
      result = await teleport(job, session).catch(note);
      if (result) break;
      return end(`No result from the cloud session ${session} after ${Math.round(job.limitMs / 60_000)} minutes, on \`${job.branch}\` or through teleport. A turn waits that long before reading it through teleport.${failed ? `\n\nThe last error: ${failed}` : ''}`, true);
    }
    await sleep(job.pollMs);
  }
  const reply = await shown(job, result);
  say(reply);
  end(reply);
}

/** On a stop the turn ends at once; the cloud session itself goes on, and its next follow-up shows what it pushed (lateResult). */
function stop() {
  for (const c of children)
    try {
      if (c.pid) process.kill(-c.pid, 'SIGKILL');
    } catch {}
  end('Stopped.', true);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.resume(); // the wrapper writes the prompt; this turn's text is in cloud.json
  process.stdin.on('error', () => {});
  /** @type {CloudJob} */
  const job = JSON.parse(readFileSync(String(process.argv[2]), 'utf8'));
  cloudTurn(job).then(
    () => process.exit(0),
    (err) => {
      end(`The cloud turn failed: ${err instanceof Error ? err.message : String(err)}`, true);
      process.exit(0);
    },
  );
}
