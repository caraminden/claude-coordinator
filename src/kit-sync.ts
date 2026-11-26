/**
 * Kit files sync themselves (#1100, option C of #601's spec on top of option A). Every scheme copies four of the kit's
 * scheme-setup templates: land.sh byte for byte, and guard.sh, pre-push and ponytail.md adapted to the scheme (its
 * protected branch names, ponytail's paths and "In this repo" section). When a deploy changes one, the server makes the
 * sync itself in each scheme whose copy is behind, runs that scheme's quick check on it, and posts one ship card in
 * Citadel's Taskmaster chat; its go ships every green one through that scheme's own tools/land.sh. No sync minions.
 *
 * The sync is a 3-way merge, so a scheme's own edits survive: the base is the kit version the scheme's copy came from
 * (a `Kit-Sync: <kit commit>` trailer on the last commit that touched it, which every sync writes; before the first
 * sync, the past template version closest to the copy), "theirs" the kit's template now, "ours" the scheme's copy.
 * A merge that gives back the scheme's own file is nothing to do; a conflict makes no branch and goes to that scheme's
 * Taskmaster. This file holds the git side; KitSync (below) runs the rounds.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostJobs } from './host-job.ts';
import { outputTail } from './land.ts';
import type { CardQuestion } from './ci-armed.ts';

/** The templates schemes copy, and where a scheme keeps its copy. */
export const KIT_FILES: readonly { template: string; path: string }[] = [
  { template: 'kit/skills/scheme-setup/templates/land.sh', path: 'tools/land.sh' },
  { template: 'kit/skills/scheme-setup/templates/guard.sh', path: 'tools/guard.sh' },
  { template: 'kit/skills/scheme-setup/templates/pre-push', path: '.githooks/pre-push' },
  { template: 'kit/skills/scheme-setup/templates/ponytail.md', path: '.claude/rules/ponytail.md' },
];

/** The trailer a sync commit carries: the kit commit its files were merged from, the next sync's exact base. */
export const TRAILER = 'Kit-Sync';

const run = promisify(execFile);
/** git off the server's thread (#2111, #2135): a round runs dozens, and a worktree can be a 1700-file checkout. */
async function git(cwd: string, args: string[]): Promise<string> {
  return (await run('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })).stdout;
}

function tryGit(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch(() => null);
}

/** The blob of `path` at `rev`, or null when it has none there. */
export async function blobAt(dir: string, rev: string, path: string): Promise<string | null> {
  return (await tryGit(dir, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`]))?.trim() || null;
}

/** The kit's four template blobs at `rev` (null for one it has none of), keyed by template path. */
export async function templateBlobs(kitDir: string, rev: string): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(KIT_FILES.map(async (f) => [f.template, await blobAt(kitDir, rev, f.template)] as const)));
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** Every version a template has had up to `rev`, newest first: the commit that made it and its blob. */
export async function templateHistory(kitDir: string, rev: string, template: string): Promise<{ commit: string; blob: string }[]> {
  const out = (await tryGit(kitDir, ['log', '--format=C %H', '--raw', '--no-abbrev', '--no-renames', rev, '--', template])) ?? '';
  const versions: { commit: string; blob: string }[] = [];
  let commit = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('C ')) commit = line.slice(2);
    else if (line.startsWith(':')) {
      // ":<old mode> <new mode> <old blob> <new blob> <status>\t<path>"; a deletion's new blob is all zeros.
      const blob = line.split(/\s+/)[3];
      if (blob && !/^0+$/.test(blob)) versions.push({ commit, blob });
    }
  }
  return versions;
}

/** How many lines two texts don't share, as multisets: a cheap distance for picking the closest past version. */
export function lineDistance(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (const l of a.split('\n')) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const l of b.split('\n')) counts.set(l, (counts.get(l) ?? 0) - 1);
  let d = 0;
  for (const n of counts.values()) d += Math.abs(n);
  return d;
}

export interface Base {
  blob: string;
  /** The kit commit of that version. */
  commit: string;
  /** trailer: the last sync named it; exact: the copy is that version byte for byte; closest: the nearest past version. */
  how: 'trailer' | 'exact' | 'closest';
}

/**
 * The kit version a scheme's copy of `file` came from. `history` is templateHistory's list for its template (it is
 * read once per round, not per scheme).
 */
export async function pickBase(kitDir: string, history: { commit: string; blob: string }[], schemeDir: string, rev: string, file: { template: string; path: string }): Promise<Base | null> {
  // The newest commit touching the file that carries one: an edit of the scheme's own after a sync keeps that base.
  // git reads trailers only from a message's last paragraph, so a `Kit-Sync:` line anywhere else (a hand sync that put
  // it above a blank line and Co-Authored-By) is found by a body grep instead.
  const log = async (args: string[]) => (await tryGit(schemeDir, ['log', '-n', '500', ...args, rev, '--', file.path])) ?? '';
  const sha =
    (await log([`--format=%(trailers:key=${TRAILER},valueonly,separator=%x20)`]))
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean)
      ?.split(/\s+/)[0] ??
    (await log(['-E', `--grep=^${TRAILER}:`, '--format=%B']))
      .split('\n')
      .map((l) => l.match(new RegExp(`^${TRAILER}:\\s*(\\S+)`))?.[1])
      .find(Boolean);
  let trailer: Base | null = null;
  if (sha && /^[0-9a-f]{7,64}$/.test(sha)) {
    const blob = await blobAt(kitDir, sha, file.template);
    if (blob) trailer = { blob, commit: (await tryGit(kitDir, ['rev-parse', sha]))?.trim() ?? sha, how: 'trailer' };
  }
  const own = await blobAt(schemeDir, rev, file.path);
  if (!own || !history.length) return trailer;
  // A byte copy of a kit version is never given an older base than itself. A trailer naming a newer version than the
  // copy still wins: the scheme undid that kit change on purpose after the sync.
  const exactAt = history.findIndex((v) => v.blob === own);
  if (exactAt >= 0) {
    const trailerAt = trailer ? history.findIndex((v) => v.blob === trailer!.blob) : -1;
    if (!trailer || trailerAt < 0 || exactAt <= trailerAt) return { ...history[exactAt], how: 'exact' };
  }
  if (trailer) return trailer;
  const ours = await git(schemeDir, ['cat-file', 'blob', own]);
  let best: { commit: string; blob: string; d: number } | null = null;
  const seen = new Set<string>();
  for (const v of history) {
    if (seen.has(v.blob)) continue;
    seen.add(v.blob);
    const d = lineDistance(ours, await git(kitDir, ['cat-file', 'blob', v.blob]));
    // Newest first, so a tie goes to the older version: a kit change it can't place then shows as a conflict
    // rather than being taken as already in.
    if (!best || d <= best.d) best = { ...v, d };
  }
  return best && { commit: best.commit, blob: best.blob, how: 'closest' };
}

/** `git merge-file -p ours base theirs`: the merged text, and whether any hunk conflicted. */
export async function merge3(ours: string, base: string, theirs: string): Promise<{ text: string; conflict: boolean }> {
  const dir = await mkdtemp(join(tmpdir(), 'kit-sync-'));
  try {
    await Promise.all(
      [
        ['ours', ours],
        ['base', base],
        ['theirs', theirs],
      ].map(([name, text]) => writeFile(join(dir, name), text)),
    );
    try {
      return { text: await git(dir, ['merge-file', '-p', '-L', 'scheme', '-L', 'kit base', '-L', 'kit', 'ours', 'base', 'theirs']), conflict: false };
    } catch (err) {
      // execFile's error: `code` is the exit status, a positive one the number of conflicts, with the merged text on stdout.
      const e = err as { code?: unknown; stdout?: unknown };
      if (typeof e.code === 'number' && e.code > 0 && typeof e.stdout === 'string') return { text: e.stdout, conflict: true };
      throw err;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type FileStatus = 'same' | 'merged' | 'conflict' | 'missing';
export interface FileSync {
  path: string;
  status: FileStatus;
  /** The new text, for a merged file. */
  text?: string;
  base?: Base['how'];
  /** The kit commit of that base, for the by-hand note's diff. */
  baseCommit?: string;
  /** A conflict with no marker: a case label the clean merge left twice in one `case` (bash runs only the first arm). */
  dupes?: string[];
}

/**
 * The case labels that appear more than once in one `case ... esac` of a shell script (#1769: a clean merge of
 * guard.sh left two `files)` arms, and bash ran only the first). A line-based scan: it is run on the merged text and on
 * the scheme's own copy, and only labels the merge made twice count.
 */
export function dupCaseLabels(text: string): string[] {
  const frames: Map<string, number>[] = [];
  const dupes = new Set<string>();
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    if (/^\s*esac\b/.test(line)) {
      frames.pop();
      continue;
    }
    const top = frames[frames.length - 1];
    const arm = top && line.match(/^\s*\(?\s*([A-Za-z0-9_*?.\/\-"'$\[\]]+(?:\s*\|\s*[A-Za-z0-9_*?.\/\-"'$\[\]]+)*)\s*\)(?:\s|$)/);
    if (arm) {
      const label = arm[1].replace(/\s+/g, '');
      const n = (top.get(label) ?? 0) + 1;
      top.set(label, n);
      if (n > 1) dupes.add(label);
    }
    if (/^\s*case\s.*\sin\s*(#.*)?$/.test(line)) frames.push(new Map());
  }
  return [...dupes];
}

/**
 * What the sync of one scheme would change, without touching it: each kit file the scheme has, merged from its base to
 * the kit's template at `kitRev`. `histories` maps each template to templateHistory's list at `kitRev`.
 */
export async function planScheme(kitDir: string, kitRev: string, histories: Record<string, { commit: string; blob: string }[]>, schemeDir: string, rev = 'HEAD'): Promise<FileSync[]> {
  const plan: FileSync[] = [];
  for (const file of KIT_FILES) plan.push(await planFile(kitDir, kitRev, histories, schemeDir, rev, file));
  return plan;
}

async function planFile(kitDir: string, kitRev: string, histories: Record<string, { commit: string; blob: string }[]>, schemeDir: string, rev: string, file: { template: string; path: string }): Promise<FileSync> {
  const own = await blobAt(schemeDir, rev, file.path);
  const kit = await blobAt(kitDir, kitRev, file.template);
  if (!own || !kit) return { path: file.path, status: 'missing' as const };
  if (own === kit) return { path: file.path, status: 'same' as const };
  const theirs = await git(kitDir, ['cat-file', 'blob', kit]);
  const ours = await git(schemeDir, ['cat-file', 'blob', own]);
  const base = await pickBase(kitDir, histories[file.template] ?? [], schemeDir, rev, file);
  // With no base at all (a template with no history), the copy is taken as the base: nothing comes in.
  const baseText = base ? await git(kitDir, ['cat-file', 'blob', base.blob]) : ours;
  const merged = await merge3(ours, baseText, theirs);
  const info = { base: base?.how, baseCommit: base?.commit };
  if (merged.conflict) return { path: file.path, status: 'conflict' as const, ...info };
  if (merged.text === ours) return { path: file.path, status: 'same' as const, ...info };
  // A clean merge of a shell file can still leave one label twice in a case; bash runs only the first arm.
  if (ours.startsWith('#!')) {
    const before = new Set(dupCaseLabels(ours));
    const dupes = dupCaseLabels(merged.text).filter((l) => !before.has(l));
    if (dupes.length) return { path: file.path, status: 'conflict' as const, ...info, dupes };
  }
  return { path: file.path, status: 'merged' as const, text: merged.text, ...info };
}

/** The mail to a scheme's Taskmaster when files clash: what a minion does by hand (#1769). Held mail, so it stays short. */
export function byHandNote(kitDir: string, kit: string, clashes: FileSync[]): string {
  const diffs = clashes.map((f) => {
    const template = KIT_FILES.find((k) => k.path === f.path)!.template;
    return f.baseCommit
      ? `git -C ${kitDir} diff ${short(f.baseCommit)} ${short(kit)} -- ${template}${f.base === 'closest' ? "   (no trailer: this base is Citadel's best guess of the version the copy came from)" : ''}`
      : `${f.path}: no base found, so use the sha in the last "${TRAILER}" trailer of this scheme's sync commit as the first sha of the same diff`;
  });
  const dupes = clashes.filter((f) => f.dupes?.length).map((f) => `${f.path} (${f.dupes!.map((l) => `${l})`).join(', ')})`);
  return (
    `Kit sync (kit ${short(kit)}): ${list(clashes.map((f) => f.path))} clash with this scheme's own edits, so no sync was made here, not even of the files that merge cleanly. A minion has to take the kit's change by hand:\n` +
    `1. See only the kit's change, not this scheme's own edits mixed in: diff the template between the last sync and the kit (the sha is this scheme's last "${TRAILER}" trailer; mind that more than the notices named may have changed):\n${diffs.join('\n')}\n` +
    `2. Apply those hunks by hand, keeping this scheme's lines.${dupes.length ? ` These merged cleanly but left a case label twice in one case, and bash runs only the first arm: ${dupes.join('; ')}. Merge the arms into one.` : ''} Before shipping, check the result for a case label that appears twice in one case.\n` +
    `3. A fresh worktree has no node_modules: run \`npm ci\` before the scheme's tests. \`tools/guard.sh --self-test\` takes about 2 minutes (plain, then nested): run it in the background on its own, not in one call with other checks.\n` +
    `4. Put "${TRAILER}: ${kit}" in the commit's final trailer block (right above Co-Authored-By, no blank line between them) and touch every file named above, so the next sync merges from there.`
  );
}

/** The scheme repos a round looks at: <projects>/<n>/repo with git, leaving out any repo holding the templates (Citadel's). */
export async function schemeRepos(projectsDir: string, ids: number[]): Promise<{ project: number; dir: string }[]> {
  const repos: { project: number; dir: string }[] = [];
  for (const project of ids) {
    const dir = join(projectsDir, String(project), 'repo');
    if ((await tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) !== null && !(await blobAt(dir, 'HEAD', KIT_FILES[0].template))) repos.push({ project, dir });
  }
  return repos;
}

// ---- The rounds -------------------------------------------------------------------------------------------------

/**
 * Where one scheme stands in a round. none: nothing to sync; pr: behind, but it ships by pull request (no tools/land.sh),
 * so it is only listed; conflict: a file clashes with the scheme's own edits; checking, green, red: its check;
 * queued, shipping, shipped, failed: after a go; elsewhere: the go's login can't push there, so the scheme has its own
 * card; dropped: Not now, or superseded.
 */
export type SchemeState = 'none' | 'pr' | 'conflict' | 'checking' | 'green' | 'red' | 'queued' | 'shipping' | 'shipped' | 'failed' | 'elsewhere' | 'dropped';
export interface SchemeSync {
  project: number;
  name: string;
  state: SchemeState;
  /** The files the sync changes (merged) or that clash (conflict). */
  files: string[];
  repo: string;
  /** The sync's commit, on branch `kit-sync/<kit short>` in the worktree projects/<n>/kit-sync. */
  commit?: string;
  /** Who said ship it: their GitHub login pushes. */
  by?: { id: number; name: string };
  /** Its own card, when the go's login couldn't push to it. */
  card?: Card;
}
export interface Card {
  ticket: number;
  question: string;
}
export interface Round {
  kit: string;
  blobs: Record<string, string | null>;
  at: number;
  schemes: SchemeSync[];
  /** Citadel's card, once every check ended and one is green. */
  card?: Card;
  /** With nothing green, Citadel's chat was told where each stands instead. */
  told?: true;
}
export interface KitSyncState {
  /** The template blobs the last round started from (or the first look, with nothing behind). */
  blobs: Record<string, string | null>;
  round?: Round;
}

/** What a round needs from the server, so a test can run one on fixture repos. */
export interface KitSyncDeps {
  /** The live checkout: its HEAD's templates are the kit's. */
  kitDir: string;
  /** <data>/projects: scheme repos are <n>/repo there, and a sync's worktree <n>/kit-sync. */
  projectsDir: string;
  /** Where the checks' and ships' host jobs keep their output. */
  runDir: string;
  jobs: Pick<HostJobs, 'start' | 'look'>;
  load(): KitSyncState | undefined;
  save(state: KitSyncState): void;
  projects(): { id: number; name: string }[];
  /** The scheme whose repo holds the templates (Citadel): its Taskmaster chat gets the card. */
  home(): number | null;
  /** A scheme's Taskmaster chat (made if it has none yet). */
  chat(project: number): Promise<number | null>;
  /** The environment for a job: the host's, plus that person's GitHub login when one is given. */
  env(person: number | null): Record<string, string>;
  /** Whether that environment's GitHub login can push to the repo whose origin is `repo`'s. */
  canPush(repoDir: string, env: Record<string, string>): Promise<boolean>;
  postCard(ticket: number, card: { questions: CardQuestion[]; kind: 'merge'; kitSync: string }): string;
  settle(card: Card, line: string): void;
  /** A line in a chat everyone sees, with no turn. */
  note(ticket: number, text: string): void;
  /** Held mail for a scheme's Taskmaster: in its chat at once, read on its next turn. */
  mail(ticket: number, text: string): void;
}

const short = (sha: string) => sha.slice(0, 7);
const CHECK_TIMEOUT = 900;
export const SHIP = 'Ship it';
export const NOT_NOW = 'Not now';

/**
 * The pre-card check: syntax, the guard's self-test when it changed, then the scheme's quick check (its SMOKE_CMD, else
 * its CHECK, land.sh's default when land.local.sh sets neither), in a fresh worktree, so packages are installed first.
 */
export const CHECK_SCRIPT = `set -u
bash -n tools/land.sh || exit
if [ "\${KIT_SYNC_GUARD:-}" = 1 ]; then
  if ! out="$(tools/guard.sh --self-test 2>&1)"; then
    printf '%s\\n' "$out"
    # The scheme's own section may be the cause: run the same self-test on main's guard (the commit before the sync's).
    if git show HEAD~1:tools/guard.sh > tools/.guard-main.sh 2>/dev/null; then
      chmod +x tools/.guard-main.sh
      mainout="$(bash tools/.guard-main.sh --self-test 2>&1)"; mainrc=$?
      rm -f tools/.guard-main.sh
      if [ "$mainrc" != 0 ]; then
        echo "kit sync: main fails it too, so look at this scheme's own guard section, not the kit. Failing cases on main:"
        printf '%s\\n' "$mainout" | grep '^FAIL' || true
      fi
    fi
    exit 1
  fi
fi
CHECK=true SMOKE_CMD=
eval "$(grep -m1 '^CHECK=' tools/land.sh)"
set +u
[ ! -f tools/land.local.sh ] || . tools/land.local.sh || exit
# shortcut: npm only (every scheme with a package.json has a package-lock.json today); add pnpm or yarn when one needs it.
if [ -f package-lock.json ] && [ ! -d node_modules ]; then
  echo "kit sync: installing packages (npm ci)"
  timeout -k 10 ${CHECK_TIMEOUT} npm ci --no-audit --no-fund --loglevel=error || exit
fi
cmd=\${SMOKE_CMD:-$CHECK}
echo "kit sync: running: $cmd"
timeout -k 10 ${CHECK_TIMEOUT} bash -c "$cmd"`;

export class KitSync {
  private d: KitSyncDeps;
  /** One step at a time: the timer and a card's answer never run a round's steps over each other. */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(deps: KitSyncDeps) {
    this.d = deps;
  }

  /** Run `fn` after whatever step is in flight. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch((err) => console.error('Kit sync:', err));
    return next;
  }

  state(): KitSyncState | undefined {
    return this.d.load();
  }

  /**
   * The timer's step (on boot and every few seconds while a round runs; the template look is cheap): a change of the
   * kit's templates starts a round (once no ship of the last one is running), and running checks and ships move on.
   */
  poll(): Promise<void> {
    return this.serial(async () => {
      // deploy.sh moves the checkout before its tests and boot check, and marks that window; its kit may yet be rolled back.
      // The look runs off the server's thread (#2111): it was 6 blocking gits every 10 minutes, each a process start on a busy box.
      const gitDir = (await git(this.d.kitDir, ['rev-parse', '--absolute-git-dir'])).trim();
      if (await exists(join(gitDir, 'cc-deploy', 'unchecked'))) return;
      let s = this.d.load();
      const head = (await git(this.d.kitDir, ['rev-parse', 'HEAD'])).trim();
      const blobs = await templateBlobs(this.d.kitDir, head);
      // A running check or ship keeps its round: superseding would leave its job writing into the next round's folder.
      const shipping = s?.round?.schemes.some((x) => x.state === 'checking' || x.state === 'queued' || x.state === 'shipping');
      if (JSON.stringify(blobs) !== JSON.stringify(s?.blobs) && !shipping) {
        if (s?.round) await this.supersede(s.round);
        s = { blobs, round: await this.start(head, blobs, s?.blobs ?? {}) };
        this.d.save(s);
      }
      if (s?.round) await this.advance(s);
    });
  }

  /** Whether a round has work running (the server polls faster then). */
  active(): boolean {
    return !!this.d.load()?.round?.schemes.some((x) => ['checking', 'queued', 'shipping'].includes(x.state));
  }

  private worktree(project: number) {
    return join(this.d.projectsDir, String(project), 'kit-sync');
  }
  private jobDir(project: number, what: 'check' | 'ship') {
    return join(this.d.runDir, `${project}-${what}`);
  }

  /** Sync every scheme that is behind: merge, commit on its branch in its worktree, start its check. */
  private async start(kit: string, blobs: Record<string, string | null>, prevBlobs: Record<string, string | null>): Promise<Round> {
    const histories = Object.fromEntries(await Promise.all(KIT_FILES.map(async (f) => [f.template, await templateHistory(this.d.kitDir, kit, f.template)] as const)));
    const names = new Map(this.d.projects().map((p) => [p.id, p.name]));
    const round: Round = { kit, blobs, at: Date.now(), schemes: [] };
    for (const { project, dir } of await schemeRepos(
      this.d.projectsDir,
      [...names.keys()].filter((id) => id !== this.d.home()),
    )) {
      const name = names.get(project)!;
      let plan: FileSync[];
      try {
        plan = await planScheme(this.d.kitDir, kit, histories, dir);
      } catch (err) {
        console.error(`Kit sync: planning ${name}:`, err);
        round.schemes.push({ project, name, state: 'failed', files: [], repo: dir });
        continue;
      }
      const merged = plan.filter((f) => f.status === 'merged');
      const clashPlan = plan.filter((f) => f.status === 'conflict');
      const clashes = clashPlan.map((f) => f.path);
      const sync: SchemeSync = { project, name, state: 'none', files: merged.map((f) => f.path), repo: dir };
      round.schemes.push(sync);
      if (!merged.length && !clashes.length) continue;
      // A scheme with no land.sh ships by pull request: listed only (opening PRs there is out of scope).
      if (!(await blobAt(dir, 'HEAD', KIT_FILES[0].path))) {
        sync.state = 'pr';
        sync.files = [...sync.files, ...clashes];
        continue;
      }
      if (clashes.length) {
        sync.state = 'conflict';
        sync.files = clashes;
        const chat = await this.d.chat(project);
        if (chat) this.d.mail(chat, byHandNote(this.d.kitDir, kit, clashPlan));
        continue;
      }
      try {
        sync.commit = await this.branch(sync, kit, merged);
      } catch (err) {
        console.error(`Kit sync: committing ${name}:`, err);
        sync.state = 'failed';
        continue;
      }
      sync.state = 'checking';
      const guard = merged.some((f) => f.path === KIT_FILES[1].path);
      this.d.jobs.start({
        dir: this.jobDir(project, 'check'),
        cwd: this.worktree(project),
        // In a heavy slot like every other heavy job (#2112): a round with many schemes behind checks a few at a time. CHECK_TIMEOUT
        // is inside the script, so it times the run and not the wait; the card shows 'checking' while it waits. --here: it needs
        // this worktree. A ship isn't wrapped: land.sh refuses under citadel-heavy and takes its own slot for its suite.
        argv: [join(import.meta.dirname, '../tools/citadel-heavy'), '--here', '--heavy', 'bash', '-c', CHECK_SCRIPT],
        env: { ...this.d.env(null), CITADEL_HEAVY_WHO: `kit sync ${name}`, KIT_SYNC_GUARD: guard ? '1' : '0' },
        unit: `citadel-kit-sync-check-${project}-${Date.now()}`,
        description: `Kit sync check for ${name}`,
        ticketId: 0,
      });
      // Saved the moment its check runs, still with the old blobs (the round isn't whole yet): a restart now finds this check in
      // its round and waits for it, instead of starting every check again over the first (ME2).
      this.d.save({ blobs: prevBlobs, round });
    }
    return round;
  }

  /** The sync's branch and commit, in a fresh worktree off the scheme's main. */
  private async branch(sync: SchemeSync, kit: string, merged: FileSync[]): Promise<string> {
    const wt = this.worktree(sync.project);
    const branch = `kit-sync/${short(kit)}`;
    await this.drop(sync);
    await git(sync.repo, ['worktree', 'add', '-q', '-B', branch, wt, 'HEAD']);
    for (const f of merged) await writeFile(join(wt, f.path), f.text!);
    await git(wt, ['add', '--', ...merged.map((f) => f.path)]);
    const msg = `Kit sync: take the kit's ${list(merged.map((f) => f.path.split('/').pop()!))} (Citadel ${short(kit)})\n\nMerged by Citadel's kit sync (#1100) from the kit's templates, keeping this scheme's own edits.\n\n${TRAILER}: ${kit}`;
    await git(wt, ['-c', 'user.name=Citadel', '-c', 'user.email=citadel@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', msg]);
    return (await git(wt, ['rev-parse', 'HEAD'])).trim();
  }

  /** Remove a scheme's sync worktree and any sync branch. */
  private async drop(sync: { project: number; repo: string }) {
    const wt = this.worktree(sync.project);
    // Gone before git's remove, which would walk an installed node_modules file by file on the event loop's thread pool.
    await rm(wt, { recursive: true, force: true });
    try {
      await git(sync.repo, ['worktree', 'prune']);
      for (const b of (await git(sync.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/kit-sync/'])).split('\n').filter(Boolean)) await git(sync.repo, ['branch', '-q', '-D', b]);
    } catch (err) {
      console.error('Kit sync: removing old sync branches:', err);
    }
  }

  /** A newer kit change replaces this round: its cards settle and its branches go. */
  private async supersede(round: Round) {
    if (round.card) this.d.settle(round.card, `Superseded by a newer kit change: a new sync round started`);
    for (const x of round.schemes) {
      if (x.card) this.d.settle(x.card, `Superseded by a newer kit change`);
      if (x.commit) await this.drop(x);
    }
  }

  /** Move checks and ships on, post the card once every check ended, and start the next ship in line. */
  private async advance(s: KitSyncState) {
    const round = s.round!;
    let changed = false;
    for (const x of round.schemes) {
      if (x.state !== 'checking' && x.state !== 'shipping') continue;
      const what = x.state === 'checking' ? 'check' : 'ship';
      const job = await this.d.jobs.look(this.jobDir(x.project, what), 6000);
      if (!job || job.code === null) continue;
      changed = true;
      const tail = outputTail(job.output);
      if (what === 'check') {
        x.state = job.code === 0 ? 'green' : 'red';
        if (x.state === 'red') {
          const chat = await this.d.chat(x.project);
          if (chat)
            this.d.mail(
              chat,
              `Kit sync (kit ${short(round.kit)}): the sync of ${list(x.files)} fails this scheme's check (exit ${job.code}), so it won't ship. The branch is ${branchOf(round)} in ${this.worktree(x.project)}. A minion can fix it there and ship it; the next kit change replaces it. Its last lines:\n\`\`\`\n${tail}\n\`\`\``,
            );
        }
        continue;
      }
      x.state = job.code === 0 ? 'shipped' : 'failed';
      const home = this.d.home();
      const homeChat = home === null ? null : await this.d.chat(home);
      const line = x.state === 'shipped' ? `Kit sync: ${x.name} shipped ${list(x.files)}, pushed as ${x.by?.name}.` : `Kit sync: ${x.name}'s ship failed (land.sh exit ${job.code}${job.code === 75 ? ': CI gave no verdict' : ''}).`;
      if (homeChat) this.d.note(homeChat, line);
      if (x.card) this.d.note(x.card.ticket, line);
      const chat = await this.d.chat(x.project);
      if (x.state === 'failed' && chat) this.d.mail(chat, `Kit sync (kit ${short(round.kit)}): ${x.by?.name}'s go to ship the sync of ${list(x.files)} here failed in tools/land.sh (exit ${job.code}). The branch is ${branchOf(round)} in ${this.worktree(x.project)}. Its last lines:\n\`\`\`\n${tail}\n\`\`\``);
      if (x.state === 'shipped') await this.drop(x);
    }
    if (round.schemes.every((x) => x.state !== 'checking') && !round.card && round.schemes.some((x) => x.state === 'green')) {
      const home = this.d.home();
      const chat = home === null ? null : await this.d.chat(home);
      if (chat) {
        round.card = { ticket: chat, question: this.d.postCard(chat, { questions: [cardQuestion(round)], kind: 'merge', kitSync: round.kit }) };
        changed = true;
      }
    } else if (round.schemes.every((x) => x.state !== 'checking') && !round.card && !round.schemes.every((x) => x.state === 'none') && !round.told) {
      // Nothing green: no card, one line in Citadel's chat saying where each stands.
      const home = this.d.home();
      const chat = home === null ? null : await this.d.chat(home);
      if (chat) this.d.note(chat, `${cardQuestion(round).question}\nNothing is ready to ship, so there is no card.`);
      round.told = true;
      changed = true;
    }
    if (!round.schemes.some((x) => x.state === 'shipping')) {
      const next = round.schemes.find((x) => x.state === 'queued');
      if (next) {
        await this.ship(round, next);
        changed = true;
      }
    }
    if (changed) this.d.save(s);
  }

  /** Start one scheme's ship as the person who said go, or hand it to its own card when their login can't push there. */
  private async ship(round: Round, x: SchemeSync) {
    const env = this.d.env(x.by!.id);
    if (!(await this.d.canPush(x.repo, env))) {
      x.state = 'elsewhere';
      const chat = await this.d.chat(x.project);
      if (!chat) return;
      // Its own card's go couldn't push either: the card goes up again for a member whose login can.
      if (x.card) this.d.note(chat, `Kit sync: ${x.by!.name}'s GitHub login can't push to this repo either, so nothing shipped. The card is up again for a member whose login can.`);
      else
        this.d.mail(
          chat,
          `Kit sync (kit ${short(round.kit)}): the sync of ${list(x.files)} is ready and its check passed. Citadel's go (${x.by!.name}) couldn't push to this repo, so it waits on this scheme's own card: any member can ship it, and the push goes out as them. Nothing for you to do but point a member at it.`,
        );
      x.card = { ticket: chat, question: this.d.postCard(chat, { questions: [schemeQuestion(round, x)], kind: 'merge', kitSync: round.kit }) };
      return;
    }
    x.state = 'shipping';
    this.d.jobs.start({
      dir: this.jobDir(x.project, 'ship'),
      cwd: this.worktree(x.project),
      argv: [join(this.worktree(x.project), 'tools/land.sh')],
      env,
      unit: `citadel-kit-sync-ship-${x.project}-${Date.now()}`,
      description: `Kit sync ship for ${x.name}`,
      ticketId: 0,
    });
  }

  /**
   * A person's answer to a kit sync card (Citadel's, or a scheme's own): Ship it queues every green scheme on it, Not now
   * drops their branches. Returns the line for the chat, or throws when the card is no longer live.
   */
  decide(card: Card, choice: string, by: { id: number; name: string }): Promise<string> {
    return this.serial(async () => {
      const s = this.d.load();
      const round = s?.round;
      const isHome = round?.card?.ticket === card.ticket && round.card.question === card.question;
      const mine = isHome ? round!.schemes.filter((x) => x.state === 'green') : (round?.schemes.filter((x) => x.card?.question === card.question && x.state === 'elsewhere') ?? []);
      if (!round || !mine.length) throw new Error('This kit sync is no longer waiting: a newer kit change replaced it, or it already shipped');
      for (const x of mine) {
        if (choice === SHIP) Object.assign(x, { state: 'queued', by });
        else {
          x.state = 'dropped';
          await this.drop(x);
        }
      }
      this.d.save(s!);
      if (choice === SHIP) await this.advance(s!);
      return choice === SHIP ? `Shipping the kit sync in ${list(mine.map((x) => x.name))}, one after another, as ${by.name}` : `Dropped the kit sync in ${list(mine.map((x) => x.name))}`;
    });
  }
}

const branchOf = (round: Round) => `kit-sync/${short(round.kit)}`;
function list(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Where each scheme stands, as the card groups them (people read it: no paths or hashes).
const STANDING: [SchemeState, string][] = [
  ['green', 'Ready'],
  ['red', 'Check failed (its Taskmaster has the output)'],
  ['conflict', "Clashes with the scheme's own edits (its Taskmaster has a note)"],
  ['pr', 'Ships by pull request, so not synced here'],
  ['failed', 'The sync could not be made (see the server log)'],
];

/** Citadel's card: every scheme that is behind and where it stands. */
export function cardQuestion(round: Round) {
  const groups = STANDING.map(([state, label]) => [label, round.schemes.filter((x) => x.state === state).map((x) => x.name)] as const)
    .filter(([, names]) => names.length)
    .map(([label, names]) => `${label}: ${names.join(', ')}.`);
  const green = round.schemes.filter((x) => x.state === 'green').length;
  return {
    header: 'Kit sync',
    question: `The kit's shared scheme files changed. The server merged the change into every scheme that was behind, keeping each one's own edits, and ran its quick check. ${groups.join(' ')} Ship the ${green} ready one${green === 1 ? '' : 's'}, pushed as you?`,
    options: [
      { label: SHIP, description: "Ships each ready scheme through its own land script, one after another; one you can't push to gets a card of its own", recommended: true },
      { label: NOT_NOW, description: 'Drops the sync branches; the next kit change makes new ones' },
    ],
  };
}

/** A scheme's own card, when Citadel's go couldn't push there. */
export function schemeQuestion(round: Round, x: SchemeSync) {
  return {
    header: 'Kit sync',
    question: `Citadel's kit changed its shared scheme files, and the server merged the change into this scheme's copies (${list(x.files.map((f) => f.split('/').pop()!))}), keeping this scheme's own edits. Its quick check passed. Citadel's go couldn't push to this repo, so it waits on yours. Ship it, pushed as you?`,
    options: [
      { label: SHIP, description: "Ships the sync through this scheme's land script", recommended: true },
      { label: NOT_NOW, description: 'Drops the sync branch; the next kit change makes a new one' },
    ],
  };
}
