// The host's read-only checks for a turn in a person's container (#621, Cara 2026-11-12: "any scheme member should have
// access to everything they need"): the database (secrets masked, src/db-view.ts), a user unit's journal and status.
// A container can't see the live database or reach the host's systemd user bus, so the host_check tool asks the server.
// judge_replay (#2074) runs the minion's own tools/judge-replay.ts --record in its worktree, on the host, over the live
// database: the replay opens it read-only (tools/judge-replays/store.ts), and only the record reaches the worktree.
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.ts';

export interface HostCheckOptions {
  /** The database file to query. */
  db: string;
  systemctl: string;
  journalctl: string;
  /** For judge_replay: the calling minion's worktree and the environment its host-side tools get (Runner.hostEnv, as a land's). */
  worktree?: { cwd: string; env: Record<string, string> } | null;
}

/** What one check prints, at most: the tail is kept. */
export const MAX_OUTPUT = 60_000;
/** A unit name or a glob of them (`citadel-*`); no shell runs, and it always comes after `--` or `-u`. */
const UNIT = /^[\w@.:*-]{1,120}$/;
const SINCE = /^[\w :+.-]{1,40}$/;
/** A judge id as src/judges.ts names them (any-nudge, ci-hold). */
const JUDGE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** The flake counter's 3 days take about 600 s (#2075). The answer beats past the MCP server's 5-minute fetch (slowJson). */
export const REPLAY_TIMEOUT = 900_000;

const run = (bin: string, args: string[], input: string | null = null, timeout = 30_000, where: { cwd?: string; env?: Record<string, string> } = {}) =>
  new Promise<string>((ok) => {
    const child = execFile(bin, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...where }, (err, out, errText) => {
      const text = `${out}${errText ? `${out ? '\n' : ''}${errText}` : ''}`.trimEnd();
      // 124: coreutils timeout stopped it (judge_replay). A signal from anyone else (a restart) must not read as a whole report.
      const why = err?.killed ? `(stopped after ${timeout / 1000} s)` : bin === 'timeout' && err?.code === 124 ? `(stopped after ${args[2]} s)` : err?.signal ? `(cut off by ${err.signal}, as by a restart of the server: run it again)` : err && !text ? String(err.message) : '';
      const all = [text, why].filter(Boolean).join('\n') || '(no output)';
      ok(all.length > MAX_OUTPUT ? `… (earlier output cut)\n${all.slice(-MAX_OUTPUT)}` : all);
    });
    if (input !== null) child.stdin?.end(input);
  });

/** Run one check from a tool call's arguments; a bad argument is a 400 that says what to send. */
export function hostCheck(opts: HostCheckOptions, body: Record<string, unknown>): Promise<string> {
  const unit = body?.unit === undefined ? null : String(body.unit);
  if (unit !== null && !UNIT.test(unit)) throw new HttpError(400, 'unit must be a systemd unit name, like claude-coordinator.service');
  switch (body?.what) {
    case 'db': {
      if (typeof body.sql !== 'string' || !body.sql.trim() || body.sql.length > 20_000) throw new HttpError(400, 'sql must be one SQL statement (at most 20,000 characters)');
      return run(process.execPath, [join(import.meta.dirname, 'db-view.ts'), opts.db], body.sql);
    }
    case 'journal': {
      const lines = body.lines === undefined ? 100 : Number(body.lines);
      if (!Number.isInteger(lines) || lines < 1 || lines > 5000) throw new HttpError(400, 'lines must be a whole number from 1 to 5000');
      if (body.since !== undefined && (typeof body.since !== 'string' || !SINCE.test(body.since))) throw new HttpError(400, 'since must be a time journalctl reads, like "1 hour ago" or "2026-11-12 18:00"');
      if (body.grep !== undefined && (typeof body.grep !== 'string' || !body.grep || body.grep.length > 200)) throw new HttpError(400, 'grep must be a pattern of at most 200 characters');
      const args = ['--user', '--no-pager', '-o', 'short-iso', '-n', String(lines), ...(unit ? ['-u', unit] : []), ...(body.since ? ['--since', body.since] : []), ...(body.grep ? ['-g', body.grep] : [])];
      return run(opts.journalctl, args);
    }
    case 'status':
      if (!unit) throw new HttpError(400, 'status needs a unit');
      return run(opts.systemctl, ['--user', 'status', '--no-pager', '--lines=20', '--', unit]);
    case 'units':
      return run(opts.systemctl, ['--user', 'list-units', '--no-pager', '--all', '--plain', ...(unit ? ['--', unit] : [])]);
    case 'judge_replay':
      return judgeReplay(opts, body);
    default:
      throw new HttpError(400, 'what must be db, journal, status, units or judge_replay');
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** judge_replay (#2074): the worktree's own judge-replay, with --record, over the live database; a bad argument rejects with a 400. */
async function judgeReplay(opts: HostCheckOptions, body: Record<string, unknown>): Promise<string> {
  const id = body.judge;
  if (typeof id !== 'string' || !JUDGE.test(id)) throw new HttpError(400, 'judge must be a judge id, like any-nudge: node tools/judge-replay.ts --list names them');
  const days = body.days === undefined ? 3 : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new HttpError(400, 'days must be a whole number from 1 to 60');
  const scheme = body.scheme === undefined ? null : Number(body.scheme);
  if (scheme !== null && !(Number.isInteger(scheme) && scheme > 0)) throw new HttpError(400, 'scheme must be a scheme id');
  const wt = opts.worktree;
  if (!wt || !(await exists(join(wt.cwd, 'tools', 'judge-replay.ts')))) throw new HttpError(400, "judge_replay runs this minion's tools/judge-replay.ts, and its worktree has none");
  // Registered judges with a replay have tools/judge-replays/<id>.ts; judge-replay itself refuses one src/judges.ts doesn't register.
  if (!(await exists(join(wt.cwd, 'tools', 'judge-replays', `${id}.ts`)))) throw new HttpError(400, `No replay for a judge ${id} in your worktree: node tools/judge-replay.ts --list names them`);
  const args = [join(wt.cwd, 'tools', 'judge-replay.ts'), id, '--record', '--db', opts.db, '--days', String(days), ...(scheme ? ['--scheme', String(scheme)] : [])];
  // coreutils timeout kills the replay's whole process group (its git and gh too); execFile's own timeout would kill only node.
  return run('timeout', ['-k', '5', String(REPLAY_TIMEOUT / 1000), process.execPath, ...args], null, REPLAY_TIMEOUT + 10_000, { cwd: wt.cwd, env: wt.env });
}
