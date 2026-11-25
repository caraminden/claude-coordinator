// The server's side of a minion's state on a machine (Build 7 T3, shared/project/specs/worker-machines.md section 4). The
// machine's side, the git snapshots and the folder lists are public/machine-sync.mjs, which a machine runs in its worker
// container at the start of a turn and at each checkpoint (public/machine-worker.mjs says when); it asks these for what
// this server has and sends what the turn changed. Every call is the machine's own token's, about a turn placed on it
// that this server still follows.
//
// This server's copy is the record. A worktree snapshot from a machine is applied only over the state that machine
// started from: a worktree with a landing running in it, or one that moved meanwhile, is left as it is and the
// machine's copy is kept in refs/citadel/kept/<ticket>/, which the minion's chat says.
import { createHash } from 'node:crypto';
import { access, readFile, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Changed, Frames, ZERO, cutOff, place, branchesElsewhere, commonDir, complete, frame, git, gitDirOf, inside, listTree, packTo, refsOf, runs, same, snapHead, snapshot, statOf, take, unpack } from '../public/machine-sync.mjs';
import type { Project, Store, Ticket } from './db.ts';
import { HttpError, json, readJson } from './http.ts';
import type { Placed } from './machine-turn.ts';
import { projectSlug, sessionFiles, validSessionId } from './sessions.ts';

/** In a placed turn's `machine` file: what its syncs need beyond the minion itself, which the database has. */
export interface TurnState {
  ticket: number;
  /** Claude's config folder: this server's copy, and the machine's own in its home. */
  config: { here: string; there: string };
}

export interface StateDeps {
  store: Store;
  files: (t: Ticket) => string;
  /** Pictures people pasted in its chat. */
  uploads: (t: Ticket) => string;
  shared: (p: Project) => string;
  /** A landing of the minion's runs: its worktree is land.sh's. */
  landing: (ticketId: number) => boolean;
  note: (ticketId: number, text: string) => unknown;
}

const SCRIPT = join(import.meta.dirname, '..', 'public', 'machine-sync.mjs');
let script: { text: string; hash: string } | null = null;
/** What the machine runs, and its id: a machine with another one fetches it. */
export async function syncScript() {
  if (!script) {
    const text = await readFile(SCRIPT, 'utf8');
    script = { text, hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
  }
  return script;
}

const there = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const SHA = /^[0-9a-f]{40}$/;
const isSha = (s: unknown): s is string => typeof s === 'string' && SHA.test(s);
const mark = (ticket: number) => `refs/citadel/machine/${ticket}`;
/** A snapshot being applied: one cut off by a restart is finished from here before anything else is read. */
const next = (ticket: number) => `refs/citadel/machine/${ticket}-next`;

/** A minion's git calls, one at a time: two checkpoints, or one and a look, must not see each other half done. */
const queue = new Map<number, Promise<unknown>>();
function alone<T>(ticket: number, run: () => Promise<T>): Promise<T> {
  const p = (queue.get(ticket) ?? Promise.resolve()).then(run);
  const done = p.catch(() => {});
  queue.set(ticket, done);
  void done.then(() => queue.get(ticket) === done && queue.delete(ticket));
  return p;
}

interface Work {
  cwd: string;
  repo: string;
  gitDir: string;
  common: string;
}

/** The minion's worktree, or null: a scheme without a repo, whose minion works in a plain folder (synced as one). */
async function worktree(t: Ticket, p: Project): Promise<Work | null> {
  if (!p.repo_dir || t.cwd === p.repo_dir || !(await there(join(t.cwd, '.git')))) return null;
  const gitDir = await gitDirOf(t.cwd);
  return { cwd: t.cwd, repo: p.repo_dir, gitDir, common: await commonDir(gitDir) };
}

const refAt = async (common: string, ref: string): Promise<string | null> => (await git(['--git-dir', common, 'rev-parse', '--verify', '--quiet', ref], { ok: [1] })).trim() || null;
const setRef = (common: string, ref: string, sha: string) => git(['--git-dir', common, 'update-ref', ref, sha]);

/** Its own snapshot as the last checkpoint left it: while it still is that, nothing was done here since. */
const left = (ticket: number) => `refs/citadel/machine/${ticket}-home`;
const lines = (...l: string[]) => ({ input: `${l.join('\n')}\n` });

/** Make the worktree, which is `from`, hold `snap`. Its branch goes along unless another worktree here has it. Throws Changed, and has changed nothing, when it no longer is. */
async function apply(d: StateDeps, w: Work, ticket: number, snap: string, from: string, refs: string[] = []) {
  const { branch, head } = await snapHead(w.common, snap);
  const ours = !!branch && !(await branchesElsewhere(w.common, w.gitDir)).has(branch) && ((await refAt(w.common, branch)) === head || refs.some((r) => r.startsWith(`update ${branch} ${head} `)));
  const aside = (dir: string, paths: string[]) => d.note(ticket, `${paths.join(', ')}: files here that git ignores were in the way of the turn's own, and are in ${dir} now.`);
  await place(w.common, w.cwd, mark(ticket), snap, { asBranch: ours, why: 'citadel: from its machine', from, refs, aside });
  await settle(w, ticket, snap);
}

async function settle(w: Work, ticket: number, snap: string) {
  const now = await snapshot(w.cwd);
  // Files saved here in that moment are a change of here's: the next checkpoint keeps them.
  const asLeft = now.tree === (await refAt(w.common, `${snap}:work`)) ? now.sha : snap;
  await git(['--git-dir', w.common, 'update-ref', '--stdin'], lines(`update ${mark(ticket)} ${snap}`, `update ${left(ticket)} ${asLeft}`, `delete ${next(ticket)}`, `delete ${mark(ticket)}-from`));
}

async function keep(w: Work, ticket: number, dir: string, name: string, sha: string) {
  const ref = `refs/citadel/kept/${ticket}/${basename(dir)}/${name}`;
  await setRef(w.common, ref, sha);
  return ref;
}

/** An apply a restart cut off is finished, unless work was done here since. */
async function finish(d: StateDeps, dir: string, at: string, w: Work, ticket: number) {
  const cut = await cutOff(w.common, w.cwd, mark(ticket));
  if (!cut) return;
  if (cut.now.sha === cut.snap) return settle(w, ticket, cut.snap);
  try {
    if (!cut.pure) throw new Changed('work was done in it since');
    await apply(d, w, ticket, cut.snap, cut.now.sha, cut.refs);
  } catch (err) {
    if (!(err instanceof Changed)) throw err;
    const ref = await keep(w, ticket, dir, 'work', cut.snap);
    await git(['--git-dir', w.common, 'update-ref', '--stdin'], lines(`delete ${next(ticket)}`, `delete ${mark(ticket)}-from`));
    once(d, dir, ticket, 'cut', `Putting the turn's files from ${at} in place here was cut off by a restart (${err.message}), so the worktree may hold some of them; all of them are in ${ref} (its work/ folder).`);
  }
}

interface StateRoot {
  id: string;
  /** Here, and on the machine. */
  home: string;
  path: string;
  partial?: boolean;
  session?: boolean;
}

function rootsOf(d: StateDeps, s: TurnState, t: Ticket, p: Project): StateRoot[] {
  const roots: StateRoot[] = [];
  const add = (id: string, home: string, path = home, more: Partial<StateRoot> = {}) => roots.push({ id, home, path, ...more });
  add('files', d.files(t));
  add('uploads', d.uploads(t));
  add('shared', d.shared(p));
  if (p.repo_dir) add('memory', join(s.config.here, 'projects', projectSlug(p.repo_dir), 'memory'), join(s.config.there, 'projects', projectSlug(p.repo_dir), 'memory'));
  else add('work', t.cwd);
  const own = { partial: true, session: true };
  add('session', join(s.config.here, 'projects', projectSlug(t.cwd)), join(s.config.there, 'projects', projectSlug(t.cwd)), own);
  if (validSessionId(t.session_id)) add('tasks', join(s.config.here, 'tasks', t.session_id!), join(s.config.there, 'tasks', t.session_id!), own);
  return roots;
}

/** Settings a minion's git needs there, and no more: a remote's address without its login, none of this machine's helpers. */
async function gitConfig(common: string): Promise<[string, string][]> {
  const keep = /^(remote\.[^\n]+\.(url|fetch)|core\.hookspath|user\.(name|email)|branch\.[^\n]+)$/i;
  const all = (await git(['--git-dir', common, 'config', '--local', '--list', '-z'])).split('\0').filter((l) => l.includes('\n'));
  return all
    .map((l): [string, string] => [l.slice(0, l.indexOf('\n')), l.slice(l.indexOf('\n') + 1)])
    .filter(([k]) => keep.test(k))
    .map(([k, v]) => [k, k.endsWith('.url') ? v.replace(/^(\w+:\/\/)[^/@]+@/, '$1') : v]);
}

async function look(d: StateDeps, dir: string, at: string, s: TurnState, t: Ticket, p: Project, body: { start?: unknown; git?: unknown; roots?: unknown }) {
  const start = body.start === true;
  const only = Array.isArray(body.roots) ? body.roots : null;
  const roots = [];
  for (const { home, ...r } of rootsOf(d, s, t, p)) {
    if (only && !only.includes(r.id)) continue;
    let files = [...(await listTree(home))];
    if (start && r.id === 'session') {
      // Its own conversation, not those of sessions before it.
      const own = new Set((await sessionFiles(t, p, s.config.here)).map((f) => join(s.config.here, f)));
      files = files.filter(([f]) => own.has(join(home, f)));
    }
    roots.push({ ...r, files: files.map(([f, [size, mtime]]) => [f, size, mtime]) });
  }
  const w = body.git === false ? null : await worktree(t, p);
  return { now: Date.now(), ticket: t.id, git: w && (await alone(t.id, () => lookGit(d, dir, at, t, w, start))), roots };
}

async function lookGit(d: StateDeps, dir: string, at: string, t: Ticket, w: Work, start: boolean) {
  const shipping = d.landing(t.id);
  if (!shipping) await finish(d, dir, at, w, t.id);
  const last = await refAt(w.common, mark(t.id));
  const base = { repo: w.repo, cwd: w.cwd, name: basename(w.gitDir), last };
  // Mid-landing its worktree is half way between two states: the machine keeps what it has.
  if (!start && last && shipping) return { ...base, snap: last, moved: false };
  const { sha: snap, branch } = await snapshot(w.cwd);
  if (!start) return { ...base, snap, branch, moved: snap !== (await refAt(w.common, left(t.id))) };
  await git(['--git-dir', w.common, 'update-ref', '--stdin'], lines(`update ${mark(t.id)} ${snap}`, `update ${left(t.id)} ${snap}`));
  const head = await refAt(w.common, 'HEAD');
  const onBranch = /^ref: (.+)$/m.exec(await readFile(join(w.common, 'HEAD'), 'utf8'))?.[1] ?? null;
  return {
    ...base,
    config: await gitConfig(w.common),
    exclude: await readFile(join(w.common, 'info', 'exclude'), 'utf8').catch(() => ''),
    main: head ? { head, branch: onBranch } : null,
    refs: await refsOf(w.common, ['refs/heads', 'refs/remotes', 'refs/tags', `refs/citadel/kept/${t.id}`]),
    snap,
  };
}

/** The last notes said, by turn: a machine offers the same again at every checkpoint. */
const told = new Set<string>();
function once(d: StateDeps, dir: string, ticket: number, kind: string, text: string) {
  const key = `${dir}\n${kind}`;
  if (told.has(key)) return;
  told.add(key);
  if (told.size > 200) told.delete(told.values().next().value!);
  d.note(ticket, text);
}

interface Commit {
  snap?: unknown;
  prev?: unknown;
  refs?: unknown;
  nested?: unknown;
}

async function commit(d: StateDeps, dir: string, at: string, t: Ticket, w: Work, body: Commit) {
  const { snap, prev } = body;
  const refs = (Array.isArray(body.refs) ? body.refs : []) as { name: string; old: string | null; sent: string[]; sha: string }[];
  const bad = (r: (typeof refs)[number]) => !isSha(r?.sha) || !(r.old === null || isSha(r.old)) || !Array.isArray(r.sent) || !r.sent.every(isSha) || typeof r.name !== 'string' || !/^refs\/(heads|tags|stash)\/[^\s~^:?*[\\\x00-\x1f]+$/.test(r.name) || r.name.includes('..');
  if (!isSha(snap) || !isSha(prev) || refs.some(bad)) throw new HttpError(400, 'Not a checkpoint');
  if (!d.landing(t.id)) await finish(d, dir, at, w, t.id);
  if (!(await complete(w.common, [snap, ...refs.map((r) => r.sha)]))) return { need: true };
  const incoming = await snapHead(w.common, snap);
  const elsewhere = await branchesElsewhere(w.common, w.gitDir);
  const nested = Array.isArray(body.nested) ? body.nested.filter((n): n is string => typeof n === 'string' && !!n) : [];
  if (nested.length) once(d, dir, t.id, 'nested', `${nested.join(', ')}: git repos of their own inside the worktree on ${at}, so they stay there and don't come here.`);
  // Where the machine left it, or put it in a call whose answer it never had.
  const from = (r: (typeof refs)[number], here: string | null) => here === r.old || here === r.sha || (!!here && r.sent.includes(here));
  const accepted: string[] = [];
  let cur = await snapshot(w.cwd);
  let kept: string | null = null;
  let applied = false;
  const aside = async (kind: string, what: string) => {
    const ref = await keep(w, t.id, dir, 'work', snap);
    kept = `the worktree here ${what} while the turn worked on ${at}, so what the turn changed there is kept in ${ref} (its files are that commit's work/ folder) and not put over it. A new turn starts from the worktree here, with that ref beside it`;
    once(d, dir, t.id, kind, `${kept[0].toUpperCase()}${kept.slice(1)}.`);
  };
  for (let tries = 1; ; tries++, cur = await snapshot(w.cwd)) {
    if (cur.sha === snap) {
      await settle(w, t.id, snap);
      applied = true;
      break;
    }
    if (d.landing(t.id)) {
      await aside('shipping', 'is being shipped');
      break;
    }
    const asLeft = await refAt(w.common, left(t.id));
    if (cur.sha !== asLeft && cur.sha !== prev) {
      // Nothing new on the machine: it takes what is here at its next look.
      if (snap === prev) break;
      const known = await Promise.all([prev, ...(asLeft ? [asLeft] : [])].map((s) => snapHead(w.common, s).catch(() => null)));
      const at0 = (h: { head: string; branch: string | null } | null) => h?.head === cur.head && h.branch === cur.branch;
      if (![incoming, ...known].some(at0)) {
        await aside('moved', 'moved');
        break;
      }
      const ref = await keep(w, t.id, dir, `before-${cur.sha.slice(0, 12)}`, cur.sha);
      once(d, dir, t.id, 'files', `Files in the worktree here changed while the turn worked on ${at}. The turn's copy is in place now; the one from here is kept in ${ref} (its work/ folder).`);
    } else if (nested.length && (await git(['--git-dir', w.common, 'diff-tree', '-r', '--name-only', '--no-renames', '--diff-filter=D', cur.sha, snap, '--', ...nested.map((n) => `:(literal)work/${n}`)])).trim()) {
      const ref = await keep(w, t.id, dir, `before-${cur.sha.slice(0, 12)}`, cur.sha);
      once(d, dir, t.id, 'nested-files', `The files of ${nested.join(', ')} that were here are kept in ${ref} (its work/ folder).`);
    }
    const own: string[] = [];
    const moves: string[] = [];
    for (const r of refs) {
      if ((r.name !== cur.branch && r.name !== incoming.branch) || elsewhere.has(r.name)) continue;
      const here = await refAt(w.common, r.name);
      if (!from(r, here)) continue;
      own.push(r.name);
      if (here !== r.sha) moves.push(`update ${r.name} ${r.sha} ${here ?? ZERO}`);
    }
    try {
      await apply(d, w, t.id, snap, cur.sha, moves);
      accepted.push(...own);
      applied = true;
      break;
    } catch (err) {
      if (!(err instanceof Changed)) throw err;
      if (tries < 3) continue;
      await aside('busy', `could not be changed (${err.message})`);
      break;
    }
  }
  for (const r of refs) {
    if (accepted.includes(r.name)) continue;
    if (r.name.startsWith('refs/stash/')) {
      const ref = await keep(w, t.id, dir, `stash-${r.sha.slice(0, 12)}`, r.sha);
      accepted.push(r.name);
      once(d, dir, t.id, r.name, `A git stash made on ${at} is kept in ${ref} (git stash apply takes it).`);
      continue;
    }
    if (!applied && (r.name === cur.branch || r.name === incoming.branch)) continue;
    const here = await refAt(w.common, r.name);
    const moved =
      !elsewhere.has(r.name) &&
      from(r, here) &&
      (await git(['--git-dir', w.common, 'update-ref', '-m', `citadel: from ${at}`, r.name, r.sha, here ?? ZERO]).then(
        () => true,
        () => false,
      ));
    if (moved || (await refAt(w.common, r.name)) === r.sha) accepted.push(r.name);
    else once(d, dir, t.id, r.name, `${r.name.replace(/^refs\/(heads|tags)\//, '')} moved here and on ${at} both; the one from ${at} is kept in ${await keep(w, t.id, dir, r.name.slice('refs/'.length), r.sha)}.`);
  }
  return { applied, refs: accepted, kept };
}

/** A file's time here: never at or before the copy it replaces, or the session's save (sessions.ts) would take it for an older one. */
const timeHere = (skew: number) => (f: { mtime: number }, here: [number, number] | null) => Math.max(Math.round(f.mtime + skew), (here?.[1] ?? 0) + 1);

/** A machine's call about a turn's state: `op` is the path past /api/machines/state/. */
export async function stateCall(d: StateDeps, op: string, dir: string, at: Placed, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const s = at.state;
  const t = s ? d.store.getTicket(s.ticket) : null;
  const p = t ? d.store.getProject(t.project_id) : null;
  if (!s || !t || !p) throw new HttpError(410, 'This turn has no state to sync');
  // Ended here (killed while its machine was away): nothing more of it is taken in.
  if (await there(join(dir, 'exit.json'))) throw new HttpError(410, 'This turn has ended');
  const work = async () => {
    const w = await worktree(t, p);
    if (!w) throw new HttpError(409, 'This minion has no worktree');
    return w;
  };
  const rootAt = (id: unknown) => rootsOf(d, s, t, p).find((r) => r.id === id) ?? null;
  if (op === 'look') return json(res, 200, await look(d, dir, at.name, s, t, p, await readJson(req)));
  if (op === 'pack') {
    const { want, have, snaps = [] } = await readJson(req, 5_000_000);
    if (!Array.isArray(want) || !Array.isArray(have) || !Array.isArray(snaps) || !want.length || ![...want, ...have, ...snaps].every(isSha)) throw new HttpError(400, 'want and have must be commit ids');
    const pack = await packTo((await work()).common, want, have, snaps);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return pipeline(pack, res);
  }
  if (op === 'unpack') {
    const { common } = await work();
    // A pack against something this repo no longer has does not resolve: the machine then sends everything.
    return json(
      res,
      200,
      await unpack(common, req).then(
        () => ({}),
        (err: Error) => ({ need: err.message }),
      ),
    );
  }
  if (op === 'commit') {
    const body = await readJson(req, 5_000_000);
    const w = await work();
    return json(res, 200, await alone(t.id, () => commit(d, dir, at.name, t, w, body)));
  }
  if (op === 'get') {
    const { files } = await readJson(req);
    const out: { file: string; root: string; rel: string; size: number; mtime: number; x: boolean }[] = [];
    for (const f of Array.isArray(files) ? files.slice(0, 1000) : []) {
      const root = rootAt(f?.root);
      const file = root && (await inside(root.home, f.rel));
      const st = file ? await statOf(file) : null;
      if (file && st) out.push({ file, root: f.root, rel: f.rel, size: st[0], mtime: st[1], x: await runs(file) });
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return pipeline(Readable.from(frame({ files: out.map(({ file: _, ...f }) => f) }, out)), res);
  }
  if (op === 'put') {
    const frames = new Frames(req);
    const head = await frames.json();
    const skew = Number.isFinite(head?.now) ? Date.now() - head.now : 0;
    const files = Array.isArray(head?.files) ? head.files : [];
    const place = async (f: { root: string; rel: string }) => {
      const root = rootAt(f.root);
      return root && (await inside(root.home, f.rel)) ? { root: root.home, file: join(root.home, f.rel) } : null;
    };
    return json(res, 200, { files: await take(frames, files, place, timeHere(skew)) });
  }
  if (op === 'drop') {
    const body = await readJson(req);
    const root = rootAt(body.root);
    const dropped: string[] = [];
    for (const f of root && Array.isArray(body.files) ? body.files : []) {
      const file = await inside(root!.home, f?.rel);
      const st = file && (await statOf(file));
      if (!st || !same(st, f.expect)) continue;
      await unlink(file);
      dropped.push(f.rel);
    }
    return json(res, 200, { dropped });
  }
  if (op === 'failed') {
    const { error, files } = await readJson(req);
    const names = Array.isArray(files) ? files.map(String) : null;
    const why = names ? `${names.slice(0, 5).join(', ').slice(0, 300)}${names.length > 5 ? ` and ${names.length - 5} more` : ''} could not be written here` : String(error ?? '').slice(0, 300);
    once(d, dir, t.id, `failed ${why}`, `${at.name} could not send this turn's latest files home: ${why}. They are still on ${at.name}.`);
    return json(res, 200, {});
  }
  throw new HttpError(404, 'No such call');
}

/** Where a machine keeps what both sides had when they were last the same, and its copy of the script: under the turns' root, so inside its container. */
export const syncDir = (dir: string) => join(dirname(dir), '.sync');

const MUST = /^api\/tickets\/\d+\/(land|land\/handoff|preview|mark-image)$/;
const DISK = /^api\/(tickets\/\d+\/(openrouter|questions|jobs|learned|wake|memory-proposal(\/apply)?)|projects\/\d+\/(tickets|desktop\/publish|releases\/publish|reviews\/.+)|contraptions\/[^/]+\/deploy)$/;
/**
 * A tool call (its path, no leading slash) that reads or writes the minion's worktree or folders here. What the turn
 * changed on its machine comes home before one (src/routes/machines.ts, turnCall); what one wrote goes back after it.
 * 'must': it would work on stale files, so it waits for them or is refused. 'may': it goes on without (a question asked
 * from a machine whose sync is broken still reaches its person).
 */
export const readsDisk = (path: string): 'must' | 'may' | null => (MUST.test(path) ? 'must' : DISK.test(path) ? 'may' : null);
