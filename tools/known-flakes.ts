// Known flakes (#1419, Cara 2026-11-20: "known flakes that havent been fixed are acceptable and do not block ship trains from
// going live"; she picked "Known flakes only"). tools/land.sh asks this about the files of a CI red whose every failed file
// passed alone; only when each is known does the ship go on without the one fresh run (ADR 0006's amendment).
//
//   known-flakes.ts <branches> <file>...
//
// <branches>: the ship's and its train riders' branches, space-separated: a sighting from a run any of them was in (its
// branch, or a train's `with` riders) doesn't count. A file is known when, in the last 14 days, it passed alone on at
// least one other branch (the scheme's retro log, the lines the Test health tab counts: flake_events rows keep no branch),
// or an open fix minion has it (flake_fixes, read-only from LAND_FLAKE_DB, the scheme taken from COORDINATOR_TICKET).
// "havent been fixed": a file whose fix passed its proof (a held flake_fixes row) counts only sightings since then.
// A broken test is never known (#1487; Cara, 2026-11-21, after #1419: "how much of our "flakes" were actual flakes vs this
// case?"): a file red in BROKEN_SHARE or more of the last BROKEN_MS of test runs, at least BROKEN_REDS reds of BROKEN_RUNS
// runs, every branch's reds counted, the ship's own too. Runs are the retro log's timing lines with a full-suite phase (CI
// or the perigee fallback; a feeder's merge runs only its files), its fresh reruns that ended green or red, each bisect
// run, and the run being judged (its timing line comes later). The brief started at 24 h, where over Oct 29-Nov 21's log
// no file reached 20% (apps peaked at 14%, review-set-api, a real missing busy timeout, at 13%); at 6 h with 3 reds, 20%
// catches 3 of the 57 files with sightings (no-reflow-browser 40%, apps 32%, review-set-api 29%), all three really fixed.
// Prints one line per file, "<file> (<why>)", or "broken test, not a flake: <file> red in N of M runs in the last 6 h",
// and exits 0 only when every file is known. Anything it can't read counts
// as not known: the ship keeps today's rerun.
// Standalone on purpose: a pipeline file imports nothing from src/ (tools/pipeline-files.txt), so the retro log's line
// format is parsed here as src/flakes.ts's parseRetroFlakes does (test/known-flakes.test.ts pins both).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WINDOW_MS = 14 * 24 * 60 * 60_000; // src/flakes.ts's FLAKE_WINDOW_MS
const BROKEN_MS = 6 * 60 * 60_000, BROKEN_SHARE = 0.2, BROKEN_RUNS = 5, BROKEN_REDS = 3;
const [branchList = '', ...files] = process.argv.slice(2);
if (!files.length) {
  console.error('usage: known-flakes.ts <branches> <file>...');
  process.exit(2);
}
const mine = new Set(branchList.split(/\s+/).filter(Boolean));
const now = Date.now();

// file -> its sightings on other branches, from `- 02:45:47Z · flake · test/x.test.ts · load 16.43 · <branch> · in CI` lines
// (a train's run adds `· with <its riders' branches>`: one sighting, of the front's branch).
const sights = new Map<string, { at: number; branch: string }[]>();
const recent = new Map<string, { at: number; branch: string }[]>(); // file -> its reds in the last BROKEN_MS, every branch's
let runs = 1; // the run being judged
const root = process.env.COORDINATOR_SHARED_DIR ? join(process.env.COORDINATOR_SHARED_DIR, 'retro-log') : '';
let days: string[] = [];
try { days = root ? readdirSync(root).filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)) : []; } catch {}
for (const day of days) {
  if (Date.parse(`${day}T23:59:59Z`) < now - WINDOW_MS) continue;
  let md = '';
  try { md = readFileSync(join(root, day, 'land.md'), 'utf8'); } catch { continue; }
  for (const m of md.matchAll(/^- (\d\d:\d\d:\d\d)Z · (timing|flake rerun|bisect run) · (.+)$/gm)) {
    const at = Date.parse(`${day}T${m[1]}Z`);
    if (Number.isNaN(at) || at < now - BROKEN_MS) continue;
    if (m[2] === 'bisect run' || (m[2] === 'flake rerun' ? /· (green|red)$/.test(m[3]) : / · (ci-run|fallback) \d/.test(m[3]))) runs++;
  }
  for (const m of md.matchAll(/^- (\d\d:\d\d:\d\d)Z · flake · (.+)$/gm)) {
    const parts = m[2].split(' · ');
    const at = Date.parse(`${day}T${m[1]}Z`);
    if (parts[1] === 'smoke' || Number.isNaN(at) || at < now - WINDOW_MS) continue; // a smoke line names no branch
    const branch = parts.slice(1).find((x) => x !== 'in CI' && !x.startsWith('load ') && !x.startsWith('with '));
    if (branch && at >= now - BROKEN_MS) recent.set(parts[0], [...(recent.get(parts[0]) ?? []), { at, branch }]);
    const riders = parts.find((x) => x.startsWith('with '))?.slice(5).split(' ') ?? [];
    if (branch && !mine.has(branch) && !riders.some((b) => mine.has(b))) sights.set(parts[0], [...(sights.get(parts[0]) ?? []), { at, branch }]);
  }
}

// file -> the open fix minion's number; file -> when its fix passed its proof.
const fixes = new Map<string, number | null>();
const held = new Map<string, number>();
try {
  const ticket = Number(process.env.COORDINATOR_TICKET);
  if (process.env.LAND_FLAKE_DB && Number.isInteger(ticket) && ticket > 0) {
    const db = new DatabaseSync(process.env.LAND_FLAKE_DB, { readOnly: true });
    try {
      const rows = db.prepare(`SELECT f.file, f.state, f.held_at, t.number, t.status FROM flake_fixes f LEFT JOIN tickets t ON t.id = f.ticket_id
        WHERE f.project_id = (SELECT project_id FROM tickets WHERE id = ?)`).all(ticket) as { file: string; state: string; held_at: number | null; number: number | null; status: string | null }[];
      for (const r of rows) {
        if (r.state === 'open' && r.status && r.status !== 'closed') fixes.set(r.file, r.number);
        else if (r.state === 'held' && r.held_at) held.set(r.file, Math.max(held.get(r.file) ?? 0, r.held_at));
      }
    } finally { db.close(); }
  }
} catch {}

let all = true;
for (const file of files) {
  const fixedAt = held.get(file) ?? 0;
  const reds = new Set((recent.get(file) ?? []).filter((s) => s.at > fixedAt).map((s) => `${s.at} ${s.branch}`)).size;
  if (runs >= BROKEN_RUNS && reds >= BROKEN_REDS && reds >= BROKEN_SHARE * runs) {
    all = false;
    console.log(`broken test, not a flake: ${file} red in ${reds} of ${runs} runs in the last ${BROKEN_MS / 3_600_000} h`);
    continue;
  }
  const branches = new Set((sights.get(file) ?? []).filter((s) => s.at > fixedAt).map((s) => s.branch));
  const why = [
    ...(branches.size ? [`seen on ${branches.size} other branch${branches.size === 1 ? '' : 'es'} in 14 days`] : []),
    ...(fixes.has(file) ? [fixes.get(file) ? `fix #${fixes.get(file)}` : 'a minion is fixing it'] : []),
  ];
  if (!why.length) {
    all = false;
    console.log(`${file} (not seen on another branch in 14 days${fixedAt ? ' since its fix passed its proof' : ''}, and no minion is fixing it)`);
  } else console.log(`${file} (${why.join(', ')})`);
}
process.exit(all ? 0 : 1);
