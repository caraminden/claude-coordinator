// Known flakes (#1419, Cara 2026-11-20: "known flakes that havent been fixed are acceptable and do not block ship trains from
// going live"; she picked "Known flakes only"). tools/land.sh asks this about the files of a CI red whose every failed file
// passed alone; only when each is known does the ship go on without the one fresh run (ADR 0006's amendment).
//
//   known-flakes.ts <base> <branches> <file>...
//
// <base>: main as the ship rebased onto it; <branches>: the ship's and its train riders' branches, space-separated, whose
// own sightings don't count. A file is known when, in the last 14 days and since its newest commit on <base> (an older
// sighting was of the file before a fix), it passed alone on at least one other branch (the scheme's retro log, the lines
// the Test health tab counts: flake_events rows keep no branch), or an open fix minion has it (flake_fixes, read-only
// from LAND_FLAKE_DB, the scheme taken from COORDINATOR_TICKET). Prints one line per file, "<file> (<why>)", and exits 0
// only when every file is known. Anything it can't read counts as not known: the ship keeps today's rerun.
// Standalone on purpose: a pipeline file imports nothing from src/ (tools/pipeline-files.txt), so the retro log's line
// format is parsed here as src/flakes.ts's parseRetroFlakes does (test/known-flakes.test.ts pins both).
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WINDOW_MS = 14 * 24 * 60 * 60_000; // src/flakes.ts's FLAKE_WINDOW_MS
const [base, branchList = '', ...files] = process.argv.slice(2);
if (!base || !files.length) {
  console.error('usage: known-flakes.ts <base> <branches> <file>...');
  process.exit(2);
}
const mine = new Set(branchList.split(/\s+/).filter(Boolean));
const now = Date.now();

// file -> its sightings on other branches, from `- 02:45:47Z · flake · test/x.test.ts · load 16.43 · <branch> · in CI` lines.
const sights = new Map<string, { at: number; branch: string }[]>();
const root = process.env.COORDINATOR_SHARED_DIR ? join(process.env.COORDINATOR_SHARED_DIR, 'retro-log') : '';
let days: string[] = [];
try { days = root ? readdirSync(root).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)) : []; } catch {}
for (const day of days) {
  if (Date.parse(`${day}T23:59:59Z`) < now - WINDOW_MS) continue;
  let md = '';
  try { md = readFileSync(join(root, day, 'land.md'), 'utf8'); } catch { continue; }
  for (const m of md.matchAll(/^- (\d\d:\d\d:\d\d)Z · flake · (.+)$/gm)) {
    const parts = m[2].split(' · ');
    const at = Date.parse(`${day}T${m[1]}Z`);
    if (parts[1] === 'smoke' || Number.isNaN(at) || at < now - WINDOW_MS) continue; // a smoke line names no branch
    const branch = parts.slice(1).find((x) => x !== 'in CI' && !x.startsWith('load '));
    if (branch && !mine.has(branch)) sights.set(parts[0], [...(sights.get(parts[0]) ?? []), { at, branch }]);
  }
}

// file -> the open fix minion's number.
const fixes = new Map<string, number>();
try {
  const ticket = Number(process.env.COORDINATOR_TICKET);
  if (process.env.LAND_FLAKE_DB && Number.isInteger(ticket) && ticket > 0) {
    const db = new DatabaseSync(process.env.LAND_FLAKE_DB, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT f.file, f.ticket_id FROM flake_fixes f JOIN tickets t ON t.id = f.ticket_id
        WHERE f.project_id = (SELECT project_id FROM tickets WHERE id = ?) AND f.state = 'open' AND t.status != 'closed'`).all(ticket) as { file: string; ticket_id: number }[];
      for (const r of rows) fixes.set(r.file, r.ticket_id);
    } finally { db.close(); }
  }
} catch {}

let all = true;
for (const file of files) {
  let changed = 0;
  try { changed = Number(execFileSync('git', ['log', '-1', '--format=%ct', base, '--', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) * 1000 || 0; } catch {}
  const branches = new Set((sights.get(file) ?? []).filter((s) => s.at > changed).map((s) => s.branch));
  const fix = fixes.get(file);
  const why = [
    ...(branches.size ? [`seen on ${branches.size} other branch${branches.size === 1 ? '' : 'es'} in 14 days`] : []),
    ...(fix ? [`fix #${fix}`] : []),
  ];
  if (!why.length) {
    all = false;
    console.log(`${file} (not seen on another branch in 14 days${changed ? ' since it last changed on main' : ''}, and no minion is fixing it)`);
  } else console.log(`${file} (${why.join(', ')})`);
}
process.exit(all ? 0 : 1);
