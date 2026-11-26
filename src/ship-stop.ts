// The ship line panel and "Stop this ship" (#1168, handoffs/platform-line-panel-stop-ship.md; Josh picked it on
// 2026-11-19 from #1093's ideas page): who holds each scheme's ship line, for how long and at which stage, who waits
// behind, and a stop any member can press, so clearing a stuck ship needs nobody's shell (lslocks, pwdx).
// A stop is a SIGTERM to the land.sh its line ticket names (tools/deploy-queue.sh, or the kit template's land-queue):
// its EXIT trap leaves the line, lets go of the lock, drops its ship train and cancels its CI run, as for any refusal,
// and main is untouched until its fast-forward. What it started (a CI poll's sleep, gh, a test run) would outlive it,
// so those get the signal too. Once main has moved (deploying, or the kit's push) it is refused: it ends by itself.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { frozenWords } from './frozen-ships.ts';
import type { App } from './http.ts';
import { landQueue } from './release-readers.ts';
import { CITADEL_TARGET } from './releases.ts';
import { landPhase, ordinal, procAlive, readQueue, readQueueA, type LandTicket } from './waits.ts';

/** One ship in a line, as the Status page's panel shows it. */
export interface ShipRow {
  /** Its line ticket: what the stop names. */
  seq: number;
  /** "#620", or the label of a run that isn't a minion's. */
  name: string;
  ticketId: number | null;
  holds: boolean;
  /** "holds", "next", "2nd". */
  place: string;
  /** When it took the lock (ms), for a holder. */
  heldSince: number | null;
  /** When its ticket last changed (it joined, or its phase moved), ms. */
  since: number;
  /** The track's stage (rebase, test, deploy; line for a waiter) and its words. */
  stage: string;
  text: string;
  /** Why the page can't stop it, or null when it can. */
  noStop: string | null;
}

/**
 * Why a landing can't be stopped, or null when it can. `train` is a rider's verdict from its train file ("riding" while its
 * train is tested, "moving" once the train's front has moved main): ADR 0020 drops a rider stopped while it rides.
 */
export function cantStop(t: Pick<LandTicket, 'label' | 'phase'>, train?: string): string | null {
  if (t.label === 'tools/deploy.sh') return 'A deploy on its own, not a ship: it ends by itself';
  // Citadel's land.sh moved main and runs deploy.sh (which holds the lock too); the kit's has moved main and pushes it.
  if (/^deploying|^pushing /.test(t.phase)) return 'Main has moved and it is going live: stopping it now could leave main and what runs apart, so it ends by itself';
  if (/^riding in /.test(t.phase) && train !== 'riding') return 'Its ship train has moved main and is going live: it ends by itself';
  return null;
}

/** A line's tickets as the panel's rows. `who` turns a label (a branch) into its minion. */
export function shipRows(line: LandTicket[], who: (label: string) => { name: string; ticketId: number | null }): ShipRow[] {
  return line.map((t, i) => {
    const p = t.got > 0 ? landPhase(t.phase) : null;
    return {
      seq: t.seq,
      ...who(t.label),
      holds: t.got > 0,
      place: t.got > 0 ? 'holds' : ordinal(i + (line[0]?.got ? 0 : 1)),
      heldSince: t.got > 0 ? t.got * 1000 : null,
      since: t.mtime,
      stage: p ? p.stage : 'line',
      text: t.frozen ? frozenWords(t.frozen) : p ? t.phase.replace(/ since \d\d:\d\d$/, '') || p.text : 'waiting',
      noStop: cantStop(t),
    };
  });
}

/** Every process under `pid`, from each process's parent in /proc/<pid>/stat. */
export function descendants(pid: number, procDir = '/proc'): number[] {
  const kids = new Map<number, number[]>();
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return [];
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procDir}/${n}/stat`, 'utf8');
    } catch {
      continue;
    } // gone since the listing
    const ppid = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1]); // the command's name may hold spaces
    kids.set(ppid, [...(kids.get(ppid) ?? []), Number(n)]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const k of kids.get(p) ?? [])
      if (!out.includes(k)) {
        out.push(k);
        walk(k);
      }
  };
  walk(pid);
  return out;
}

/** SIGTERM to `pid` first (land.sh: its EXIT trap runs at once), then to what it started; SIGCONT so a stopped one gets it. */
export function signalTree(pid: number, kill: (pid: number, sig: NodeJS.Signals) => void = process.kill, tree = descendants): void {
  const kids = tree(pid); // before the signal: what the EXIT trap starts (git rebase --abort, the CI cancel) is left to finish
  for (const p of [pid, ...kids]) {
    for (const sig of ['SIGTERM', 'SIGCONT'] as const) {
      try {
        kill(p, sig);
      } catch {
        /* gone already */
      }
    }
  }
}

export class StopRefused extends Error {}

/**
 * Stop the ship holding ticket `seq` of the line in queue folder `q` (`orderAt` as readQueue takes it), checked afresh:
 * still in line, still the process the ticket names, and not past moving main. Returns its ticket; throws StopRefused.
 * `before` runs once it is sure to stop, before the signal (the server notes who stopped it there).
 */
export function stopInLine(q: string, orderAt: number, seq: number, before: (t: LandTicket) => void = () => {}, signal: (pid: number) => void = (pid) => signalTree(pid), alive = procAlive): LandTicket {
  const t = readQueue(q, orderAt, alive).find((x) => x.seq === seq);
  if (!t) throw new StopRefused('That ship is no longer in line');
  const name = String(seq).padStart(10, '0');
  const first = (f: string) => {
    try {
      return readFileSync(f, 'utf8').split(/\s/)[0];
    } catch {
      return undefined;
    }
  };
  const why = cantStop(t, first(join(q, '..', 'train', name))) ?? (orderAt === 7 ? kitMoved(q, name) : null);
  if (why) throw new StopRefused(why);
  before(t);
  signal(Number(t.proc.split(' ')[0]));
  return t;
}

/**
 * The kit's land.sh fast-forwards main before it says "pushing": in that gap main already holds the commit its ticket
 * names (its 5th line), so it is refused as for "pushing". Citadel's own needs no such check: its TERM trap puts main back.
 */
function kitMoved(q: string, name: string): string | null {
  let commit = '';
  try {
    commit = readFileSync(join(q, name), 'utf8').split('\n')[4] ?? '';
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return null;
  try {
    execFileSync('git', ['--git-dir', dirname(q), 'merge-base', '--is-ancestor', commit, 'HEAD'], { stdio: 'ignore' });
    return cantStop({ label: '', phase: 'pushing main' });
  } catch {
    return null; // not on main (exit 1), or git can't say: stoppable as before
  }
}

/** A scheme's ship line: Citadel's own is the deploy queue (orderAt 4); any other scheme's is its copy of the kit's land template (7). */
export function lineFor(app: Pick<App, 'releases' | 'waits' | 'store'>, projectId: number): { q: string; orderAt: number } | null {
  const own = app.releases.view((id) => id === projectId)[0]?.targets.some((t) => t.target.id === CITADEL_TARGET);
  if (own) return app.waits?.queue ? { q: app.waits.queue, orderAt: 4 } : null;
  const repo = app.store.getProject(projectId)?.repo_dir;
  return repo ? { q: landQueue(repo), orderAt: 7 } : null;
}

/** A line ticket's minion in scheme `projectId`, by its label (a branch, or "<scheme> #N"): a branch name is per scheme. */
function minionOf(app: Pick<App, 'waits' | 'store'>, projectId: number, label: string): number | null {
  const id = app.waits ? app.waits.ticketFor(label) : label.includes('/') && label !== 'tools/deploy.sh' ? (app.store.ticketByBranch(label)?.id ?? null) : null;
  return id != null && app.store.getTicket(id)?.project_id === projectId ? id : null;
}

/**
 * Every ship line `visible` lets a person see that has someone in it, read afresh (the panel reads it every 3 s) and off
 * the server's thread (#2111): a blocking read here waited on the disk once per open Status page, every 3 s.
 */
export async function shipLines(app: Pick<App, 'releases' | 'waits' | 'store'>, visible: (projectId: number) => boolean) {
  const lines = await Promise.all(
    app.store
      .listProjects()
      .filter((p) => visible(p.id))
      .map(async (p) => {
        const at = lineFor(app, p.id);
        const line = at ? await readQueueA(at.q, at.orderAt) : [];
        if (!line.length) return [];
        const rows = shipRows(line, (label) => {
          const id = minionOf(app, p.id, label);
          const t = id != null ? app.store.getTicket(id) : undefined;
          return t ? { name: `#${t.number ?? t.id}`, ticketId: t.id } : { name: label.replace(/ \(.*\)$/, ''), ticketId: null };
        });
        return [{ projectId: p.id, scheme: p.name, rows }];
      }),
  );
  return lines.flat();
}

/**
 * Stop line ticket `seq` of a scheme's line for `who` (a person's name), `via` saying how ("from the Status page"). A
 * minion's handed-off landing is marked stopped first, so its report says who stopped it rather than "fix the cause";
 * its chat gets a note either way.
 */
export function stopShip(app: Pick<App, 'releases' | 'waits' | 'store' | 'landings' | 'runner'>, projectId: number, seq: number, who: string, signal?: (pid: number) => void, via = 'from the Status page'): { name: string } {
  const at = lineFor(app, projectId);
  if (!at) throw new StopRefused('This scheme has no ship line here');
  let name = '';
  stopInLine(
    at.q,
    at.orderAt,
    seq,
    (t) => {
      const id = minionOf(app, projectId, t.label);
      const m = id != null ? app.store.getTicket(id) : undefined;
      name = m ? `#${m.number ?? m.id}` : t.label;
      if (!m) return;
      // As the hand-off poll last read it (each 5 s), or a hand-off too new for a read yet: its report then says who stopped it.
      const run = app.landings.lastLook(m.id);
      if (run === undefined ? app.landings.hasHandoff(m.id) : run?.code === null) app.landings.markStopped(m.id, who, Date.now(), via);
      app.runner.emit(m.id, 'note', { text: `${who} stopped this ship ${via}: it leaves the line and main stays as it was.` });
    },
    signal,
  );
  console.log(`Ship line: ${who} stopped ${name} (line ticket ${seq}) in scheme ${projectId}`);
  return { name };
}

/**
 * A minion stopped (its chat's Stop, or stop_ticket) stops its running ship too: in line, as the panel's stop does;
 * before it joined the line, its land.sh directly. Says what happened, or why it keeps running.
 */
export async function stopMinionShip(app: Pick<App, 'releases' | 'waits' | 'store' | 'landings' | 'runner'>, ticketId: number, who: string, signal: (pid: number) => void = (pid) => signalTree(pid)): Promise<string | null> {
  const run = await app.landings.look(ticketId);
  if (run?.code !== null) return null;
  const t = app.store.getTicket(ticketId);
  const at = t ? lineFor(app, t.project_id) : null;
  const via = 'by stopping its minion';
  const mine = at ? readQueue(at.q, at.orderAt).find((x) => minionOf(app, t!.project_id, x.label) === ticketId) : undefined;
  if (mine && at) {
    try {
      stopShip(app, t!.project_id, mine.seq, who, signal, via);
      return 'Its ship was stopped too: it left the line and main stays as it was.';
    } catch (err) {
      if (err instanceof StopRefused) return `Its ship keeps running: ${err.message}.`;
      throw err;
    }
  }
  const pid = await app.landings.landPid(ticketId);
  if (!pid) return null;
  // Out of the line is before it joined, or after main moved: deploy.sh leaves the line to wait for live, and a rider
  // whose train moved waits outside it. Both say so in its output.
  if (/ is now at [0-9a-f]{7}|waiting outside the line/.test((await app.landings.look(ticketId))?.output ?? '')) return 'Its ship keeps running: main has moved and it is going live, so it ends by itself.';
  app.landings.markStopped(ticketId, who, Date.now(), via);
  signal(pid);
  return 'Its ship was stopped too, before it joined the line: nothing landed.';
}
