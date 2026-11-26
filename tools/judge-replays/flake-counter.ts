// The flake counter and same-flake alarm (src/flake-fixes.ts) over the window, a pass every 15 minutes (the server: 5):
// each pass sees the land-recorded flakes and retro-log lines up to its time, and the minions as they were then
// (open or closed by that time; the ones it would start stay open). Its alarms and starts are set beside the real
// "Same-flake alarm" wakes and the minions the flaky-test rule really started.
import { execFileSync } from 'node:child_process';
import { FlakeFixes } from '../../src/flake-fixes.ts';
import type { Project, Ticket } from '../../src/db.ts';
import { projectSharedDir } from '../../src/workspace.ts';
import { minionsAsOf, replayStore } from './store.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';
import { dirname } from 'node:path';

// The server passes every 5 minutes; 15 keeps a 3-day replay near a minute and is still inside the alarm's 30-minute window.
const PASS_MS = 15 * 60_000;
const COLS = 'project_id, file, at, commit_sha, ticket_id, source, detail, test_name, message, class';
/** Rows land.sh's output made (recordFlakes); the rest came from the retro log, which ingest reads itself. */
const FROM_LANDS = 'NOT (ticket_id IS NULL AND commit_sha IS NULL)';

/** A flaky test's file or title, as one key: its file's name with no folder and no .test.ts, else the title's first word after "flaky (test)". */
export function flakeKey(title: string): string {
  const file = /([\w.-]+?)(?:\.test)?\.ts\b/.exec(title);
  return file ? file[1] : title.replace(/^(fix )?(flaky)?( test)?:? */i, '').split(' ')[0];
}

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const dataDir = dirname(ctx.db);
  const store = replayStore(ctx.db, ['settings', 'flake_events', 'flake_fixes'], { flake_fixes: `started_at < ${start}` });
  store.db.exec(`INSERT INTO temp.flake_events (${COLS}) SELECT ${COLS} FROM main.flake_events WHERE at < ${start}`);
  // A held fix reopened inside the window shows only its reopen (reopen overwrites started_at): it goes in held as of the
  // window's start, so its first sighting reopens it, as the real one did.
  store.db.exec(`INSERT INTO temp.flake_fixes (id, project_id, file, ticket_id, state, started_at, clean_runs, held_at, reopened, proof_run)
    SELECT id, project_id, file, NULL, 'held', ${start - 1}, 0, ${start - 1}, reopened - 1, NULL FROM main.flake_fixes WHERE started_at >= ${start} AND reopened > 0`);
  const projects = store.listProjects().filter((p) => p.repo_dir && (ctx.scheme == null || p.id === ctx.scheme));
  let now = start;
  let warm = true;
  // The minions it starts get negative ids and stay open.
  const started: Ticket[] = [];
  const ids = projects.map((p) => p.id);
  const realStarts = (
    store.db.prepare("SELECT e.created_at AS at, t.id, t.title, t.project_id FROM events e JOIN tickets t ON t.id = e.ticket_id WHERE e.id >= ? AND e.kind = 'note' AND e.data LIKE '{\"text\":\"Started by the flaky-test rule%'").all(store.eventIdAt(start)) as {
      at: number;
      id: number;
      title: string;
      project_id: number;
    }[]
  ).filter((r) => r.at >= start && ids.includes(r.project_id));
  // The fix minions the rule really started in the window would block the replay's own starts for their files: its own stand in.
  minionsAsOf(store, () => now, started, new Set(realStarts.map((r) => r.id)));
  const hits: Act[] = [];
  const history = new Map<number, Map<string, number[]>>();
  const commitsOf = (p: Project) => {
    if (!history.has(p.id)) history.set(p.id, fileCommits(p.repo_dir!));
    return history.get(p.id)!;
  };
  const fixes = new FlakeFixes({
    store,
    now: () => now,
    sharedDir: (id) => projectSharedDir(dataDir, id),
    start: async (p, brief) => {
      const id = -1 - started.length;
      started.push({
        id,
        project_id: p.id,
        title: brief.title,
        status: 'new',
        kind: 'ticket',
        created_at: now,
        updated_at: now,
        number: null,
        state: null,
        note: null,
        replies: null,
        build: null,
        parent: null,
        session_id: null,
        cwd: '',
        branch: null,
        permission_mode: '',
        model: null,
        effort: null,
        last_model: null,
        last_effort: null,
        picked_because: null,
        workflow: 0,
        plugin_dirs: '',
        last_activity: null,
        closed_at: null,
        person_id: null,
        coordinator_of: null,
        created_by: '',
      });
      if (!warm) hits.push({ at: now, key: `start:${flakeKey(brief.title)}`, text: brief.title });
      return { id };
    },
    wake: (_p, text) => {
      const file = /^Same-flake alarm: (\S+)/.exec(text)?.[1] ?? '?';
      if (!warm) hits.push({ at: now, key: `alarm:${flakeKey(file)}`, text: text.slice(0, 200) });
      return true;
    },
    // The file's newest commit on main as of `now`, from one git log of the scheme's main.
    changedAt: async (p, file) =>
      commitsOf(p)
        .get(file)
        ?.find((t) => t <= now) ?? null,
    suspect: async () => null,
    runs: async () => null,
    jobs: async () => null,
  });
  const copy = store.db.prepare(`INSERT INTO temp.flake_events (${COLS}) SELECT ${COLS} FROM main.flake_events WHERE project_id = ? AND at > ? AND at <= ? AND ${FROM_LANDS}`);
  // One pass at the window's start primes the alarm's quiet marks and the fixes already open; what it does isn't counted.
  for (let t = start, last = start; t <= ctx.now; last = t, t += PASS_MS) {
    now = t;
    for (const p of projects) {
      copy.run(p.id, last, t);
      await fixes.ingest(p, t);
      await fixes.alarm(p, t);
      await fixes.escalate(p, t);
    }
    warm = false;
  }
  const real: Act[] = [
    ...realStarts.map((r) => ({ at: r.at, key: `start:${flakeKey(r.title)}`, text: r.title })),
    ...(
      store.db.prepare('SELECT e.created_at AS at, e.data, t.project_id FROM events e JOIN tickets t ON t.id = e.ticket_id WHERE e.id >= ? AND e.kind = \'user_message\' AND e.data LIKE \'{"author":"Citadel","text":"Same-flake alarm:%\'').all(store.eventIdAt(start)) as { at: number; data: string; project_id: number }[]
    )
      .filter((r) => ids.includes(r.project_id))
      .map((r) => {
        const text = String(JSON.parse(r.data).text);
        return { at: r.at, key: `alarm:${flakeKey(/^Same-flake alarm: (\S+)/.exec(text)?.[1] ?? '?')}`, text: text.slice(0, 200) };
      }),
  ].sort((a, b) => a.at - b.at);
  return {
    inputs: `${Math.round((ctx.now - start) / PASS_MS)} passes over ${projects.length} schemes: their retro logs, land-recorded flakes and minions`,
    hits,
    real,
    limits: [
      "a fix's proof runs (GitHub's flake-proof results) aren't replayed, so a fix that went held inside the window stays open in the replay",
      'fixes started before the window are seeded as they are now, not as they were then',
      'a fix reopened inside the window is seeded held at its start, though it may have been made inside the window too',
      'real starts are matched by the title the flaky-test rule gave them',
    ],
  };
}

/** Each file's commit times on main (ms), newest first. */
function fileCommits(repo: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let log = '';
  try {
    log = execFileSync('git', ['log', '--format=@%ct', '--name-only', 'main'], { cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 256 << 20 });
  } catch {
    return out;
  }
  let at = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('@')) at = Number(line.slice(1)) * 1000;
    else if (line) out.set(line, [...(out.get(line) ?? []), at]);
  }
  return out;
}
