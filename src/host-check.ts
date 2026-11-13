// The host's read-only checks for a turn in a person's container (#621, Cara 2026-11-12: "any scheme member should have
// access to everything they need"): the database (secrets masked, src/db-view.ts), a user unit's journal and status.
// A container can't see the live database or reach the host's systemd user bus, so the host_check tool asks the server.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { HttpError } from './http.ts';

export interface HostCheckOptions {
  /** The database file to query. */
  db: string;
  systemctl: string;
  journalctl: string;
}

/** What one check prints, at most: the tail is kept. */
export const MAX_OUTPUT = 60_000;
/** A unit name or a glob of them (`citadel-*`); no shell runs, and it always comes after `--` or `-u`. */
const UNIT = /^[\w@.:*-]{1,120}$/;
const SINCE = /^[\w :+.-]{1,40}$/;

const run = (bin: string, args: string[], input: string | null = null, timeout = 30_000) => new Promise<string>((ok) => {
  const child = execFile(bin, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }, (err: any, out, errText) => {
    const text = `${out}${errText ? `${out ? '\n' : ''}${errText}` : ''}`.trimEnd();
    const why = err?.killed ? `(stopped after ${timeout / 1000} s)` : err && !text ? String(err.message) : '';
    const all = [text, why].filter(Boolean).join('\n') || '(no output)';
    ok(all.length > MAX_OUTPUT ? `… (earlier output cut)\n${all.slice(-MAX_OUTPUT)}` : all);
  });
  if (input !== null) child.stdin?.end(input);
});

/** Run one check from a tool call's arguments; a bad argument is a 400 that says what to send. */
export function hostCheck(opts: HostCheckOptions, body: any): Promise<string> {
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
      const args = ['--user', '--no-pager', '-o', 'short-iso', '-n', String(lines), ...(unit ? ['-u', unit] : []),
        ...(body.since ? ['--since', body.since] : []), ...(body.grep ? ['-g', body.grep] : [])];
      return run(opts.journalctl, args);
    }
    case 'status':
      if (!unit) throw new HttpError(400, 'status needs a unit');
      return run(opts.systemctl, ['--user', 'status', '--no-pager', '--lines=20', '--', unit]);
    case 'units':
      return run(opts.systemctl, ['--user', 'list-units', '--no-pager', '--all', '--plain', ...(unit ? ['--', unit] : [])]);
    default:
      throw new HttpError(400, 'what must be db, journal, status or units');
  }
}
