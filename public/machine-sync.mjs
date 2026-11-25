// A minion's state between this server and a machine its turn runs on (Build 7 T3, shared/project/specs/worker-machines.md
// section 4). The server (src/machine-sync.ts) imports it; on the machine the worker agent (machine-worker.mjs) runs it as
// a program INSIDE the worker container, where every path is the server's and nothing a minion put in a git config can
// run outside the container. This server's copy is the record; the machine's is a working copy.
//
// A worktree travels as one commit that holds all of it (snapshot): the files as they are, the index, what git keeps of a
// merge or rebase under way, and which branch it is on. It is made the same way on both sides with a fixed author and
// date, so two copies hold the same state exactly when their snapshots have the same id. Folders (files, shared, memory,
// session) travel by file list: what changed on one side since both were last the same goes to the other.
//
// As a program: `node machine-sync.mjs <base64 JSON>` with { app, dir, state, start?, git?, roots? }. It prints one line of JSON:
// { ok } or { gone } (the server no longer follows the turn) or { error, offline }.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// ---- git ----

const QUIET = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'advice.addEmbeddedRepo=false', '-c', 'core.quotePath=false'];
// On the machine LFS files stay the pointers git holds: their content isn't in git, and a smudge there would fail the checkout.
const NO_LFS = ['-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false'];
const IDENT = { GIT_AUTHOR_NAME: 'citadel', GIT_AUTHOR_EMAIL: 'citadel@localhost', GIT_AUTHOR_DATE: '1000000000 +0000', GIT_COMMITTER_NAME: 'citadel', GIT_COMMITTER_EMAIL: 'citadel@localhost', GIT_COMMITTER_DATE: '1000000000 +0000' };
/** The machine's side, set by its program below. */
let onMachine = false;

/**
 * @typedef {{ input?: string | Buffer | NodeJS.ReadableStream, env?: Record<string, string>, cwd?: string, ok?: number[] }} GitOpts
 * @typedef {{ sha: string, tree: string, head: string, branch: string | null, nested: string[] }} Snap nested: folders left out for being git repos of their own
 */

/** Git's stdout as text. @param {string[]} args @param {GitOpts} [o] */
export const git = async (args, o) => (await gitBytes(args, o)).toString('utf8');

/** Git's stdout. @param {string[]} args @param {GitOpts} [o] @returns {Promise<Buffer>} */
function gitBytes(args, o = {}) {
  return new Promise((done, fail) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...o.env };
    // A turn's own GIT_DIR and the like must not move these calls to another repo.
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', ...(o.env?.GIT_INDEX_FILE ? [] : ['GIT_INDEX_FILE'])]) delete env[k];
    const p = spawn('git', [...QUIET, ...(onMachine ? NO_LFS : []), ...args], { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    /** @type {Buffer[]} */
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    p.on('error', fail);
    p.on('close', (code) =>
      code === 0 || o.ok?.includes(code ?? -1)
        ? done(Buffer.concat(out))
        : fail(
            new Error(
              `git ${args
                .filter((a, i) => !/^--(git-dir|work-tree)$/.test(a) && !/^--(git-dir|work-tree)$/.test(args[i - 1]))
                .slice(0, 2)
                .join(' ')}: ${err.trim() || `exit ${code}`}`,
            ),
          ),
    );
    p.stdin.on('error', () => {});
    if (o.input && typeof o.input === 'object' && 'pipe' in o.input) {
      o.input.on('error', () => p.kill());
      o.input.pipe(p.stdin);
    } else p.stdin.end(/** @type {string | Buffer | undefined} */ (o.input));
  });
}

/** A worktree's own git folder, from its `.git` file (or its .git folder, when it is a whole repo). @param {string} work */
export async function gitDirOf(work) {
  const at = join(work, '.git');
  if ((await lstat(at)).isDirectory()) return at;
  const to = /^gitdir: (.+)$/m.exec(await readFile(at, 'utf8'))?.[1].trim();
  if (!to) throw new Error(`${at} names no git folder`);
  return isAbsolute(to) ? to : join(work, to);
}

/** The repo a git folder belongs to. @param {string} gitDir */
export async function commonDir(gitDir) {
  const to = (await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  return !to ? gitDir : isAbsolute(to) ? to : join(gitDir, to);
}

/** Never synced: an untracked key or env file (the list tools/heavy-ci.ts keeps off GitHub). A tracked one is the repo's own. */
const SECRETS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.jks', '*.keystore', 'id_rsa*', 'id_ed25519*'];
const SECRET_NAME = new RegExp(`^(${SECRETS.map((g) => g.replaceAll('.', '\\.').replaceAll('*', '.*')).join('|')})$`);
/** What git keeps in a worktree's own folder of a merge, rebase or pick under way. */
const STATE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'SQUASH_MSG', 'AUTO_MERGE'];
const STATE_DIRS = ['rebase-merge', 'rebase-apply', 'sequencer'];
export const ZERO = '0'.repeat(40);

/** The state files present, by path in the worktree's git folder. @param {string} gitDir */
async function stateFiles(gitDir) {
  /** @type {string[]} */
  const found = [];
  for (const f of STATE_FILES) if (existsSync(join(gitDir, f))) found.push(f);
  for (const d of STATE_DIRS) {
    if (!existsSync(join(gitDir, d))) continue;
    for (const e of await readdir(join(gitDir, d), { recursive: true, withFileTypes: true })) if (e.isFile()) found.push(relative(gitDir, join(e.parentPath, e.name)));
  }
  return found.sort();
}

/**
 * A commit that holds the whole state of a worktree, whose index, branch and files it leaves alone. `use` gets it and the
 * index file that matches the files (restore needs it); both are only good inside `use`.
 * Its tree: work/ (the files: tracked, and untracked that git doesn't ignore), index/ (the index), meta/ (the branch, a
 * merge or rebase under way). Its parents: HEAD, then the commits that state needs.
 * @template T @param {string} work @param {(s: Snap, index: string, g: (args: string[], o?: GitOpts) => Promise<string>) => Promise<T>} use @returns {Promise<T>}
 */
export async function withSnapshot(work, use) {
  const gitDir = await gitDirOf(work);
  const tmp = await mkdtemp(join(tmpdir(), 'citadel-state-'));
  try {
    const index = join(tmp, 'index');
    const real = join(gitDir, 'index');
    /** With its time: git looks again at a file written in the same moment as its index, and a copy's newer time would hide that. @param {string} to */
    const copyIndex = async (to) => {
      const st = await stat(real).catch(() => null);
      if (!st) return;
      await copyFile(real, to);
      await utimes(to, st.atime, st.mtime);
    };
    await copyIndex(index);
    const at = ['--git-dir', gitDir, '--work-tree', work];
    /** @param {string[]} args @param {GitOpts} [o] */
    const g = (args, o = {}) => git([...at, ...args], { cwd: work, ...o, env: { ...IDENT, GIT_INDEX_FILE: index, ...o.env } });
    // The index as it is, without unmerged entries (no tree can hold them): they go by as text.
    const unmerged = await g(['ls-files', '-u', '-z']);
    const staged = { GIT_INDEX_FILE: join(tmp, 'staged') };
    await copyIndex(staged.GIT_INDEX_FILE);
    if (unmerged) {
      const paths = [
        ...new Set(
          unmerged
            .split('\0')
            .filter(Boolean)
            .map((l) => l.slice(l.indexOf('\t') + 1)),
        ),
      ];
      await g(['update-index', '-z', '--index-info'], { env: staged, input: paths.map((p) => `0 ${ZERO}\t${p}\0`).join('') });
    }
    const indexTree = (await g(['write-tree'], { env: staged })).trim();
    const links = async () =>
      new Set(
        (await g(['ls-files', '-s', '-z']))
          .split('\0')
          .filter((l) => l.startsWith('160000 '))
          .map((l) => l.slice(l.indexOf('\t') + 1)),
      );
    const submodules = await links();
    await g(['add', '-u', '--', ':/']);
    /** @type {string[]} */
    const repos = [];
    /** @type {string[]} */
    const skip = SECRETS.map((s) => `:(top,exclude,glob)**/${s}`);
    for (let tries = 0; ; tries++) {
      try {
        await g(['add', '-A', '--', ':/', ...skip]);
        break;
      } catch (err) {
        // A git repo of its own inside the worktree, with no commit yet: not part of this one.
        const empty = /'(.+?)\/?' does not have a commit checked out/.exec(err.message)?.[1];
        if (!empty || tries > 20) throw err;
        repos.push(empty);
        skip.push(`:(top,exclude,literal)${empty}`);
      }
    }
    // Nor is one with commits: git would hold only its id, and its files would be lost on the other side.
    const nested = [...(await links())].filter((p) => !submodules.has(p));
    const nestedDirs = [...nested, ...repos];
    if (nested.length) await g(['update-index', '-z', '--force-remove', '--stdin'], { input: nested.map((p) => `${p}\0`).join('') });
    const tree = (await g(['write-tree'])).trim();

    const headText = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    const branch = /^ref: (.+)$/.exec(headText)?.[1] ?? null;
    const head = (await g(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { ok: [1] })).trim();
    const meta = { GIT_INDEX_FILE: join(tmp, 'meta') };
    /** @type {string[]} */
    const rows = [];
    /** @param {string} path @param {string | Buffer} data */
    const put = async (path, data) => void rows.push(`100644 ${(await g(['hash-object', '-w', '--stdin', '--no-filters'], { input: data })).trim()}\t${path}`);
    await put('HEAD', `${branch ?? 'detached'}\n${head}\n`);
    if (unmerged) {
      await put('unmerged', unmerged);
      for (const [mode, sha] of unmerged
        .split('\0')
        .filter(Boolean)
        .map((l) => l.split(' ')))
        if (mode !== '160000') rows.push(`100644 ${sha}\tblob/${sha}`);
    }
    /** @type {string[]} */
    const parents = head ? [head] : [];
    for (const f of await stateFiles(gitDir)) {
      const data = await readFile(join(gitDir, f));
      await put(`state/${f}`, data);
      // The commits it names have to come along; a todo list's are reached from these.
      if (data.length < 4000 && /(_HEAD|AUTO_MERGE|\/(orig-head|onto|autostash|stopped-sha|abort-safety|head))$/.test(f)) for (const sha of data.toString().match(/\b[0-9a-f]{40}\b/g) ?? []) if ((await g(['cat-file', '-t', sha], { ok: [1, 128] })).trim() === 'commit' && !parents.includes(sha)) parents.push(sha);
    }
    await g(['update-index', '--add', '--index-info'], { env: meta, input: `${rows.join('\n')}\n` });
    const metaTree = (await g(['write-tree'], { env: meta })).trim();
    const all = (await g(['mktree'], { input: `040000 tree ${indexTree}\tindex\n040000 tree ${metaTree}\tmeta\n040000 tree ${tree}\twork\n` })).trim();
    const sha = (await g(['commit-tree', all, ...parents.flatMap((p) => ['-p', p]), '-m', 'citadel worktree state'])).trim();
    return await use({ sha, tree, head, branch, nested: nestedDirs.sort() }, index, g);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** @param {string} work @returns {Promise<Snap>} */
export const snapshot = (work) => withSnapshot(work, async (s) => s);

/** What a snapshot says of its branch and commit. @param {string} repo @param {string} sha */
export async function snapHead(repo, sha) {
  const [branch, head] = (await git(['--git-dir', repo, 'cat-file', 'blob', `${sha}:meta/HEAD`])).split('\n');
  return { branch: branch === 'detached' ? null : branch, head };
}

/** The worktree is not as it was read, so nothing was put over it. */
export class Changed extends Error {}

/**
 * Hold a worktree's index lock, the way git does, so no commit, checkout or add of anyone's happens meanwhile. `use` may
 * rename it into place (`ready`, then `put`). The lock is a hard link of a file of ours: one a killed restore left is known
 * by that. `hold`: one that fails between the two leaves it too, for the next to take over.
 * @template T @param {string} gitDir @param {boolean} hold @param {(lock: { ready: (index: string) => Promise<void>, put: () => Promise<void> }) => Promise<T>} use @returns {Promise<T>}
 */
async function locked(gitDir, hold, use) {
  const lock = join(gitDir, 'index.lock');
  const mine = join(gitDir, 'citadel-index');
  const ino = (/** @type {string} */ f) =>
    stat(f).then(
      (st) => st.ino,
      () => null,
    );
  const ours = await ino(mine);
  const taken = ours !== null && ours === (await ino(lock));
  if (!taken) {
    await rm(mine, { force: true });
    await writeFile(mine, '');
  }
  for (let i = 0; !taken; i++) {
    try {
      await link(mine, lock);
      break;
    } catch (err) {
      if (err.code === 'EEXIST' && i < 50) {
        await sleep(100);
        continue;
      }
      await unlink(mine);
      throw err.code === 'EEXIST' ? new Changed(`${lock} is held`) : err;
    }
  }
  let held = true;
  let kept = taken && hold;
  try {
    return await use({
      // The lock is the index to be.
      ready: async (index) => {
        await copyFile(index, mine);
        kept = hold;
      },
      put: async () => {
        await rename(lock, join(gitDir, 'index'));
        held = kept = false;
      },
    });
  } finally {
    if (held && !kept) await unlink(lock).catch(() => {});
    if (!kept) await unlink(mine).catch(() => {});
  }
}

/** Of `paths`, those the files of `sha` make git ignore, and key files: on the other side they may well still be there, only not sent. @param {Snap & { gitDir: string, tmp: string }} s @param {string} sha @param {string[]} paths @param {(args: string[], o?: GitOpts) => Promise<string>} g */
async function unsent(s, sha, paths, g) {
  const work = join(s.tmp, 'ignores');
  await mkdir(work);
  const env = { GIT_INDEX_FILE: join(s.tmp, 'ignore-index') };
  await g(['read-tree', `${sha}:work`], { env });
  const rules = (await g(['ls-files', '-z', '--', ':(top,glob)**/.gitignore'], { env })).split('\0').filter(Boolean);
  const at = ['--git-dir', s.gitDir, '--work-tree', work];
  await git([...at, 'checkout-index', '-q', '-f', '-z', '--stdin'], { cwd: work, env, input: rules.map((r) => `${r}\0`).join('') });
  const ignored = await git([...at, 'check-ignore', '--no-index', '-z', '--stdin'], { cwd: work, env, ok: [1], input: paths.map((p) => `${p}\0`).join('') });
  return [...new Set([...ignored.split('\0').filter(Boolean), ...paths.filter((p) => SECRET_NAME.test(basename(p)))])];
}

/** @param {string} from @param {string} to */
const move = (from, to) =>
  rename(from, to).catch(async (err) => {
    // The repo is on another disk than the worktree.
    if (err.code !== 'EXDEV') throw err;
    await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await rm(from, { recursive: true });
  });

/**
 * The files git is about to write over that no snapshot holds (git takes an ignored one for nobody's): the same one, for
 * the index to know; another, moved out of the way. @param {string} work @param {string} gitDir
 * @param {string[]} adds diff-tree's rows: what, then where @param {(args: string[], o?: GitOpts) => Promise<string>} g
 * @param {((dir: string, paths: string[]) => void) | undefined} aside
 */
async function clear(work, gitDir, adds, g, aside) {
  /** @type {string[]} */
  const same = [];
  /** @type {Set<string>} */
  const inWay = new Set();
  for (let i = 0; i + 1 < adds.length; i += 2) {
    const parts = adds[i + 1].split('/');
    for (let n = 1; n <= parts.length; n++) {
      const p = parts.slice(0, n).join('/');
      const st = await lstat(join(work, p)).catch(() => null);
      if (!st) break;
      const [, mode, , id] = adds[i].split(' ');
      if (st.isDirectory() && (n < parts.length || mode === '160000')) continue;
      const known = (await g(['ls-files', '-z', '--', `:(literal)${p}`])).split('\0').filter(Boolean);
      if (st.isDirectory()) {
        // A folder where a file goes: what of it git does not know.
        if (!known.length) inWay.add(p);
        else for (const o of (await g(['ls-files', '-o', '-z', '--', `:(literal)${p}/`])).split('\0').filter(Boolean)) inWay.add(o.replace(/\/$/, ''));
        break;
      }
      // In the index: git's own to replace.
      if (known.includes(p)) break;
      if (n === parts.length && st.isFile() && mode.startsWith('100') && (await g(['hash-object', '--path', p, '--', p])).trim() === id && !!(st.mode & 0o100) === (mode === '100755')) same.push(p);
      else inWay.add(p);
      break;
    }
  }
  if (inWay.size) {
    const dir = join(gitDir, 'citadel-aside', String(Date.now()));
    for (const p of inWay) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await move(join(work, p), join(dir, p));
    }
    aside?.(dir, [...inWay]);
  }
  return same;
}

/**
 * Make a worktree hold what snapshot `sha` holds: its files (only those that differ are touched; ignored ones stay), its
 * branch, its index, and a merge or rebase under way. `asBranch` false leaves HEAD detached at the snapshot's commit.
 * `refs`: lines for git update-ref, done with it. Run again after a crash part way, it ends in the same place.
 * A file no snapshot holds (an ignored one, a key) that is in the way goes to a folder outside the worktree, and `aside`
 * is told. With `from`, only over a worktree that is still that snapshot, file by file: else it throws Changed, and has
 * changed none of them. `before` runs once that is sure.
 * `hold`: failing once the branch may have moved, it leaves git's lock, so nothing is committed there until it is finished.
 * @param {string} work @param {string} sha @param {{ asBranch?: boolean, why?: string, from?: string, refs?: string[], before?: () => Promise<unknown>, aside?: (dir: string, paths: string[]) => void, hold?: boolean }} [o]
 */
export async function restore(work, sha, o = {}) {
  const gitDir = await gitDirOf(work);
  const { branch, head } = await snapHead(gitDir, sha);
  await locked(gitDir, !!o.hold, (lock) =>
    withSnapshot(work, async (s, index, g) => {
      if (o.from && s.sha !== o.from) throw new Changed('the worktree changed meanwhile');
      const drops = (await g(['diff-tree', '-r', '-z', '--name-only', '--no-renames', '--diff-filter=D', s.tree, `${sha}:work`])).split('\0').filter(Boolean);
      const stay = drops.length ? await unsent({ ...s, gitDir, tmp: dirname(index) }, sha, drops, g) : [];
      if (stay.length) await g(['update-index', '-z', '--force-remove', '--stdin'], { input: stay.map((p) => `${p}\0`).join('') });
      // The two-tree form touches no file that isn't what the index says.
      const adds = (await g(['diff-tree', '-r', '-z', '--no-renames', '--diff-filter=A', s.tree, `${sha}:work`])).split('\0').filter(Boolean);
      const same = adds.length ? await clear(work, gitDir, adds, g, o.aside) : [];
      if (same.length) await g(['update-index', '-z', '--add', '--stdin'], { input: same.map((p) => `${p}\0`).join('') });
      const has = stay.length || same.length ? (await g(['write-tree'])).trim() : s.tree;
      const put = o.from ? ['read-tree', '-m', '-u', has, `${sha}:work`] : ['read-tree', '--reset', '-u', `${sha}:work`];
      const or = (/** @type {Error} */ err) => {
        throw new Changed(err.message);
      };
      if (o.from) await g([...put.slice(0, 2), '-n', ...put.slice(2)]).catch(or);
      const refs = (/** @type {string} */ lines) => g(['update-ref', '--no-deref', '-m', o.why ?? 'citadel: state sync', '--stdin'], { input: lines });
      if (o.refs?.length) await refs(['start', ...o.refs, 'prepare', 'abort', ''].join('\n')).catch(or);
      await o.before?.();
      // Files, then the index made ready, the branch, and the index in place: cut off in between, git's lock is still there
      // or the branch has not moved (with `hold`, for an error too), so no commit can take the old files as a change to the new ones.
      await g(put);
      let unmerged = '';
      /** @type {[string, string][]} */
      const state = [];
      for (const row of (await g(['ls-tree', '-r', '-z', `${sha}:meta`])).split('\0').filter(Boolean)) {
        const path = row.slice(row.indexOf('\t') + 1);
        const blob = row.split(/[ \t]/)[2];
        if (path === 'unmerged') unmerged = await g(['cat-file', 'blob', blob]);
        const f = normalize(path.slice(6));
        // Only names the snapshot itself would take.
        if (path.startsWith('state/') && (STATE_FILES.includes(f) || STATE_DIRS.some((d) => f.startsWith(`${d}${sep}`)))) state.push([f, blob]);
      }
      await g(['read-tree', '--reset', `${sha}:index`]);
      if (unmerged) {
        const paths = [
          ...new Set(
            unmerged
              .split('\0')
              .filter(Boolean)
              .map((l) => l.slice(l.indexOf('\t') + 1)),
          ),
        ];
        await g(['update-index', '-z', '--index-info'], { input: paths.map((p) => `0 ${ZERO}\t${p}\0`).join('') + unmerged });
      }
      await g(['update-index', '-q', '--refresh'], { ok: [1] });
      await lock.ready(index);
      if (o.refs?.length) await refs(`${o.refs.join('\n')}\n`);
      if (branch && o.asBranch !== false) await g(['symbolic-ref', '-m', o.why ?? 'citadel: state sync', 'HEAD', branch]);
      else if (head) await g(['update-ref', '--no-deref', '-m', o.why ?? 'citadel: state sync', 'HEAD', head]);
      for (const f of STATE_FILES) await rm(join(gitDir, f), { force: true });
      for (const d of STATE_DIRS) await rm(join(gitDir, d), { recursive: true, force: true });
      for (const [f, blob] of state) {
        await mkdir(dirname(join(gitDir, f)), { recursive: true });
        await writeFile(join(gitDir, f), await gitBytes(['--git-dir', gitDir, 'cat-file', 'blob', blob]));
      }
      await lock.put();
    }),
  );
}

/** A restore with a record beside `mark` (what, over what) that outlives it, for one cut off part way. @param {string} common @param {string} work @param {string} mark @param {string} snap @param {{ from: string, refs?: string[], asBranch?: boolean, why?: string, aside?: (dir: string, paths: string[]) => void, hold?: boolean }} o */
export async function place(common, work, mark, snap, o) {
  const update = (/** @type {string[]} */ lines) => git(['--git-dir', common, 'update-ref', '--stdin'], { input: `${lines.join('\n')}\n` });
  try {
    await restore(work, snap, { ...o, before: () => update([`update ${mark}-next ${snap}`, `update ${mark}-from ${o.from}`]) });
  } catch (err) {
    if (err instanceof Changed) await update([`delete ${mark}-next`, `delete ${mark}-from`]);
    throw err;
  }
}

/**
 * One cut off part way: what it was putting in place, the worktree now, and how to go on from there. `pure`: each file is
 * as it was before or as it was to be, so nobody has worked in it since.
 * @param {string} common @param {string} work @param {string} mark
 */
export async function cutOff(common, work, mark) {
  const refs = await refsOf(common, [`${mark}-next`, `${mark}-from`]);
  const snap = refs[`${mark}-next`];
  const from = refs[`${mark}-from`];
  if (!snap || !from) return null;
  const now = await snapshot(work);
  const diff = async (/** @type {string} */ to) => (await git(['--git-dir', common, 'diff-tree', '-r', '-z', '--name-only', '--no-renames', now.tree, `${to}:work`])).split('\0').filter(Boolean);
  const [was, is] = [await snapHead(common, from), await snapHead(common, snap)];
  const old = new Set(await diff(from));
  const pure = (now.head === was.head || now.head === is.head) && !(await diff(snap)).some((p) => old.has(p));
  // Its branch, when the cut came before that moved.
  const moves = is.branch && is.branch === was.branch && (await refsOf(common, [is.branch]))[is.branch] === was.head && was.head !== is.head;
  return { snap, from, now, pure, refs: moves ? [`update ${is.branch} ${is.head} ${was.head}`] : [] };
}

/**
 * Go on with one cut off part way, in a worktree someone has maybe worked in since: each file that is still as it was
 * before gets what it was to be, and one worked on stays. `back`: its commit was not there yet and other work is, so the
 * files it did put there are taken out again. Cut off again or Changed, the record stands for the next go.
 * `old`: where a branch was before. @param {string} common @param {string} work @param {string} mark @param {(branch: string) => string | undefined} old @returns {Promise<{ snap: string, back: boolean } | null>}
 */
export async function resume(common, work, mark, old) {
  const cut = await cutOff(common, work, mark);
  if (!cut) return null;
  const { snap, from, now } = cut;
  const g = (/** @type {string[]} */ args, /** @type {GitOpts} */ o = {}) => git(['--git-dir', common, ...args], o);
  const names = async (/** @type {string} */ a, /** @type {string} */ b) => (await g(['diff-tree', '-r', '-z', '--no-renames', '--name-only', a, b])).split('\0').filter(Boolean);
  // Its branch, commit, and a merge or rebase under way.
  const meta = async (/** @type {string} */ sha) => ({ ...(await snapHead(common, sha)), state: await g(['ls-tree', '-r', `${sha}:meta`, 'state', 'unmerged']) });
  const [was, is, here] = [await meta(from), await meta(snap), await meta(now.sha)];
  const at = is.branch && (await refsOf(common, [is.branch]))[is.branch];
  const moves = !!is.branch && at !== is.head && at === old(is.branch);
  const own = (!!is.branch && at !== is.head && !moves) || ![was, is].some((m) => m.head === here.head && m.branch === here.branch) || ![was, is].some((m) => m.state === here.state);
  const back = own && !!is.head && !!(await g(['rev-list', '-1', is.head, ...(here.head ? [`^${here.head}`] : [])])).trim();
  const [base, to] = back ? [snap, from] : [from, snap];
  const tmp = await mkdtemp(join(tmpdir(), 'citadel-state-'));
  const env = { ...IDENT, GIT_INDEX_FILE: join(tmp, 'index') };
  /** `ours`, with what `part` of `base` became in `to` where ours was not worked on. @param {string} ours @param {string} part */
  const carry = async (ours, part) => {
    const still = new Set(await names(`${to}:${part}`, ours));
    const edited = new Set((await names(`${base}:${part}`, ours)).filter((p) => still.has(p)));
    const held = (await g(['ls-tree', '-r', '-z', '--name-only', ours])).split('\0').filter((p) => edited.has(p));
    const up = (/** @type {string} */ p) => p.split('/').map((_, i, all) => all.slice(0, i + 1).join('/'));
    // Nor a folder where it has a file now, or a file where it has a folder.
    const inWay = new Set(held.flatMap(up));
    const rows = (await g(['diff-tree', '-r', '-z', '--no-renames', `${base}:${part}`, `${to}:${part}`])).split('\0').filter(Boolean);
    let input = '';
    for (let i = 0; i + 1 < rows.length; i += 2) {
      const [, mode, , id] = rows[i].split(' ');
      const p = rows[i + 1];
      if (edited.has(p) || inWay.has(p) || up(p).some((q) => held.includes(q))) continue;
      input += `${mode} ${id}\t${p}\0`;
    }
    await g(['read-tree', ours], { env });
    await g(['update-index', '-z', '--index-info'], { env, input });
    return (await g(['write-tree'], { env })).trim();
  };
  try {
    const tree = await carry(now.tree, 'work');
    const index = await carry((await g(['rev-parse', `${now.sha}:index`])).trim(), 'index');
    const rest = own ? now.sha : snap;
    const info = (await g(['rev-parse', `${rest}:meta`])).trim();
    const all = (await g(['mktree'], { input: `040000 tree ${index}\tindex\n040000 tree ${info}\tmeta\n040000 tree ${tree}\twork\n` })).trim();
    const parents = (await g(['rev-list', '--parents', '-1', rest])).trim().split(' ').slice(1);
    const sha = (await g(['commit-tree', all, ...parents.flatMap((c) => ['-p', c]), '-m', 'citadel'], { env })).trim();
    await restore(work, sha, { from: now.sha, refs: moves && !back ? [`update ${is.branch} ${is.head} ${at ?? ZERO}`] : [], hold: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { snap, back };
}

/**
 * The objects `want` needs past `have`, as a pack on a stream. Haves this repo lacks are passed over. `snaps`: those of
 * them that are snapshots, which no later one is made from, so git leaves out what they hold only when told by tree.
 * @param {string} repo @param {string[]} want @param {string[]} have @param {string[]} [snaps]
 */
export async function packTo(repo, want, have, snaps = []) {
  for (const s of [...want, ...have]) if (!/^[0-9a-f]{40}$/.test(s)) throw new Error('not a commit id');
  const held = have.length
    ? (await git(['--git-dir', repo, 'cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: `${[...new Set(have)].join('\n')}\n` }))
        .split('\n')
        .filter((l) => / (commit|tag)$/.test(l))
        .map((l) => l.split(' ')[0])
    : [];
  const p = spawn('git', [...QUIET, '--git-dir', repo, 'pack-objects', '--revs', '--stdout', '--thin', '--delta-base-offset', '-q'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  // A pack cut short must not end as a whole one: the stream fails, so the other side's index-pack does.
  p.on('error', (e) => p.stdout.destroy(e));
  p.on('close', (code) => code && p.stdout.destroy(new Error(`git pack-objects: ${err.trim() || `exit ${code}`}`)));
  p.stdin.on('error', () => {});
  p.stdin.end(`${[...new Set(want)].join('\n')}\n${held.length ? `--not\n${[...held, ...snaps.filter((s) => held.includes(s)).map((s) => `${s}^{tree}`)].join('\n')}\n` : ''}`);
  return p.stdout;
}

/** Take in a pack. @param {string} repo @param {NodeJS.ReadableStream} from */
export const unpack = (repo, from) => git(['--git-dir', repo, 'index-pack', '--stdin', '--fix-thin'], { input: from });

/** Whether everything `shas` reach is in the repo. @param {string} repo @param {string[]} shas */
export async function complete(repo, shas) {
  try {
    await git(['--git-dir', repo, 'rev-list', '--objects', '--quiet', '--stdin', '--not', '--all'], { input: `${shas.join('\n')}\n` });
    return true;
  } catch {
    return false;
  }
}

/** Refs by name, under the given prefixes. @param {string} repo @param {string[]} under @returns {Promise<Record<string, string>>} */
export async function refsOf(repo, under) {
  /** @type {Record<string, string>} */
  const refs = {};
  // A symbolic ref (origin/HEAD) follows the one it names.
  for (const l of (await git(['--git-dir', repo, 'for-each-ref', '--format=%(objectname) %(refname) %(symref)', ...under])).split('\n').filter(Boolean)) {
    const [sha, name, sym] = l.split(' ');
    if (!sym) refs[name] = sha;
  }
  return refs;
}

/** The branches a repo's worktrees are on, other than `work`'s: never moved from under them. @param {string} repo @param {string} gitDir the worktree's own git folder */
export async function branchesElsewhere(repo, gitDir) {
  /** @type {Set<string>} */
  const on = new Set();
  const dirs = [repo];
  for (const n of await readdir(join(repo, 'worktrees')).catch(() => [])) dirs.push(join(repo, 'worktrees', n));
  for (const d of dirs) {
    if (d === gitDir) continue;
    const b = /^ref: (.+)$/m.exec(await readFile(join(d, 'HEAD'), 'utf8').catch(() => ''))?.[1];
    if (b) on.add(b);
    // A rebase under way has its branch off HEAD until it ends.
    for (const s of ['rebase-merge', 'rebase-apply']) {
      const r = (await readFile(join(d, s, 'head-name'), 'utf8').catch(() => '')).trim();
      if (r.startsWith('refs/')) on.add(r);
    }
  }
  return on;
}

// ---- folders ----

/** @typedef {[size: number, mtime: number]} Stat a file's size and time (ms) */
/** @typedef {{ id: string, path: string, partial?: boolean, session?: boolean }} Root a folder on the machine. partial: the server lists only some of its own; session: the server's copy is the record before a turn, and transcripts only grow */

const STAGING = '.citadel-sync';

/** @param {{ size: number, mtimeMs: number }} st @returns {Stat} */
const asStat = (st) => [st.size, Math.round(st.mtimeMs)];
/** @param {string} file @returns {Promise<Stat | null>} */
export const statOf = (file) =>
  lstat(file).then(
    (st) => (st.isFile() ? asStat(st) : null),
    () => null,
  );
/** Whether a file may be run. @param {string} file */
export const runs = (file) =>
  lstat(file).then(
    (st) => (st.mode & 0o100) !== 0,
    () => false,
  );
/** @param {Stat | null | undefined} a @param {Stat | null | undefined} b */
export const same = (a, b) => (!a && !b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

/** Every plain file under a folder, by path in it; links are not followed or listed, nor key and env files. @param {string} root @returns {Promise<Map<string, Stat>>} */
export async function listTree(root) {
  /** @type {Map<string, Stat>} */
  const files = new Map();
  /** @type {string[]} */
  const names = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && !SECRET_NAME.test(e.name)) names.push(relative(root, join(e.parentPath, e.name)));
  for (let i = 0; i < names.length; i += 64) {
    await Promise.all(
      names.slice(i, i + 64).map(async (n) => {
        if (n.split(sep).includes(STAGING)) return;
        const st = await statOf(join(root, n));
        if (st) files.set(n, st);
      }),
    );
  }
  return files;
}

/** A path from the other side, as a file under `root`: plain, inside it, and reached through no link. Null when it isn't. @param {string} root @param {unknown} rel */
export async function inside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || isAbsolute(rel) || normalize(rel) !== rel || rel === '.' || rel.split(sep)[0] === '..') return null;
  // The nearest folder there already: every folder past it is made by us.
  let up = dirname(join(root, rel));
  while (!existsSync(up) && up.length > root.length) up = dirname(up);
  if (!existsSync(up)) return join(root, rel);
  const [real, base] = [await realpath(up), await realpath(root)];
  return real === base || real.startsWith(base + sep) ? join(root, rel) : null;
}

/** @param {string} file @param {number} upTo @returns {Promise<string>} */
async function sha256(file, upTo) {
  const h = createHash('sha256');
  if (upTo > 0) for await (const chunk of createReadStream(file, { end: upTo - 1 })) h.update(chunk);
  return h.digest('hex');
}

/** @typedef {{ root: string, rel: string, size: number, mtime: number, x?: boolean, from?: number, hash?: string, expect?: Stat | null }} FileHead a file in a transfer: `size` bytes, or those past `from` with the whole's hash */

/**
 * Files as one stream: a header (4 bytes of length, then JSON), each file's bytes, a trailer. A file that changes while it
 * is read is sent at the size it had (short ones padded) and named in the trailer, so the other side drops it.
 * @param {Record<string, unknown>} head @param {{ file: string, size: number, mtime: number, from?: number }[]} files
 */
export async function* frame(head, files) {
  const block = (/** @type {unknown} */ o) => {
    const b = Buffer.from(JSON.stringify(o));
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  yield block(head);
  /** @type {number[]} */
  const bad = [];
  for (const [i, f] of files.entries()) {
    let left = f.size - (f.from ?? 0);
    const fd = await open(f.file, 'r').catch(() => null);
    if (fd) {
      try {
        if (left > 0)
          for await (const chunk of fd.createReadStream({ start: f.from ?? 0, end: f.size - 1, autoClose: false })) {
            left -= chunk.length;
            yield chunk;
          }
        if (!same(asStat(await fd.stat()), [f.size, f.mtime]) && !f.from) bad.push(i);
      } finally {
        await fd.close();
      }
    }
    if (left > 0) {
      if (!bad.includes(i)) bad.push(i);
      for (; left > 0; left -= 65536) yield Buffer.alloc(Math.min(left, 65536));
    }
  }
  yield block({ bad });
}

/** Reads a frame. */
export class Frames {
  /** @param {AsyncIterable<Buffer>} from */
  constructor(from) {
    this.it = from[Symbol.asyncIterator]();
    /** @type {Buffer} */
    this.buf = Buffer.alloc(0);
  }
  async more() {
    const { value, done } = await this.it.next();
    if (done) throw new Error('the transfer was cut short');
    this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
  }
  /** @returns {Promise<any>} */
  async json() {
    while (this.buf.length < 4) await this.more();
    const n = this.buf.readUInt32BE(0);
    if (n > 64_000_000) throw new Error('not a transfer');
    while (this.buf.length < 4 + n) await this.more();
    const o = JSON.parse(this.buf.subarray(4, 4 + n).toString('utf8'));
    this.buf = this.buf.subarray(4 + n);
    return o;
  }
  /** The next `n` bytes, in pieces. @param {number} n */
  async *bytes(n) {
    while (n > 0) {
      if (!this.buf.length) await this.more();
      const part = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(part.length);
      n -= part.length;
      yield part;
    }
  }
}

/**
 * Take in a frame's files, each written aside and renamed into place, whole, only while the copy here is still `expect`
 * (what the sender thought it was). Returns what became of each: its size and time here now, or why it was left.
 * @param {Frames} frames @param {FileHead[]} files @param {(f: FileHead) => Promise<{ root: string, file: string } | null>} place
 * @param {(f: FileHead, here: Stat | null) => number} mtime its time here @returns {Promise<({ ok: Stat } | { left: 'changed' | 'whole' | 'refused' })[]>}
 */
export async function take(frames, files, place, mtime) {
  /** @type {{ f: FileHead, to: { root: string, file: string } | null, part: string | null }[]} */
  const parts = [];
  /** @type {Set<string>} */
  const made = new Set();
  try {
    for (const f of files) {
      const to = await place(f);
      const n = f.size - (f.from ?? 0);
      if (!to || !(n >= 0)) {
        for await (const _ of frames.bytes(n)) void _;
        parts.push({ f, to: null, part: null });
        continue;
      }
      // Beside the root, so on its filesystem and never in what is listed or saved from it.
      const staging = join(dirname(to.root), STAGING);
      if (!made.has(staging)) await mkdir(staging, { recursive: true });
      made.add(staging);
      const part = join(await mkdtemp(join(staging, 'part-')), 'file');
      parts.push({ f, to, part });
      if (f.from) await pipeline(createReadStream(to.file, { end: f.from - 1 }), createWriteStream(part, { mode: 0o600 })).catch(() => {});
      await pipeline(Readable.from(frames.bytes(n)), createWriteStream(part, { flags: 'a', mode: f.root === 'shared' || f.root === 'files' ? 0o664 : 0o600 }));
    }
    const bad = new Set((await frames.json()).bad);
    /** @type {({ ok: Stat } | { left: 'changed' | 'whole' | 'refused' })[]} */
    const said = [];
    for (const [i, { f, to, part }] of parts.entries()) {
      if (!to || !part) said.push({ left: 'refused' });
      else if (bad.has(i)) said.push({ left: 'changed' });
      else if (f.from && (await sha256(part, f.size)) !== f.hash) said.push({ left: 'whole' });
      else {
        const here = await statOf(to.file);
        if (!same(here, f.expect)) {
          said.push({ left: 'changed' });
          continue;
        }
        try {
          await mkdir(dirname(to.file), { recursive: true });
          const at = new Date(mtime(f, here));
          if (f.x) await chmod(part, f.root === 'shared' || f.root === 'files' ? 0o775 : 0o700);
          await utimes(part, at, at);
          await rename(part, to.file);
          said.push({ ok: /** @type {Stat} */ (await statOf(to.file)) });
        } catch {
          // A folder where the file should go, say: the other copy stays where it is.
          said.push({ left: 'refused' });
        }
      }
    }
    return said;
  } finally {
    for (const { part } of parts) if (part) await rm(dirname(part), { recursive: true, force: true });
  }
}

/** @typedef {Record<string, { l: Stat | null, r: Stat | null }>} Base the last time both sides were the same: each file as it was here and there */

/**
 * What to do for each file of a root, from the copy here (`local`), the server's (`remote`), and what both were when last
 * the same. A change on one side goes to the other. Changed on both: the newest write wins, and a write beats a delete.
 * `mirror` (a session before its turn): the server's copy is the record and wins.
 * @param {Map<string, Stat>} local @param {Map<string, Stat>} remote @param {Base} base
 * @param {{ partial?: boolean, mirror?: boolean, skew?: number }} [o] skew: the server's clock less this one's
 */
export function reconcile(local, remote, base, o = {}) {
  /** @type {{ push: string[], pull: string[], dropHere: string[], dropThere: string[], same: string[] }} */
  const plan = { push: [], pull: [], dropHere: [], dropThere: [], same: [] };
  // A side that lost its whole folder deleted nothing: start over from what there is.
  if ((!local.size || (!remote.size && !o.partial)) && Object.keys(base).length) base = {};
  for (const p of new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])) {
    const l = local.get(p) ?? null;
    const r = remote.get(p) ?? null;
    const b = base[p];
    const here = !same(l, b?.l);
    const there = !same(r, b?.r) && !(o.partial && !r);
    if (o.mirror && r) {
      if (here || there) plan.pull.push(p);
    } else if (!here && !there) continue;
    else if (here && !there) {
      if (l) plan.push.push(p);
      else if (r) plan.dropThere.push(p);
      else plan.same.push(p);
    } else if (there && !here) {
      if (r) plan.pull.push(p);
      else if (l) plan.dropHere.push(p);
      else plan.same.push(p);
    } else if (!l && !r) plan.same.push(p);
    else if (!l) plan.pull.push(p);
    else if (!r) plan.push.push(p);
    else if (!b && same(l, r)) plan.same.push(p);
    else if (l[1] + (o.skew ?? 0) > r[1]) plan.push.push(p);
    else plan.pull.push(p);
  }
  return plan;
}

// ---- the machine's side ----

/**
 * @typedef {{ repo: string, cwd: string, name: string, config: [string, string][], exclude: string, main: { head: string, branch: string | null } | null, refs: Record<string, string> | null, snap: string, last: string | null, moved?: boolean, branch?: string | null }} GitLook
 * @typedef {{ now: number, ticket: number, git: GitLook | null, roots: (Root & { files: [string, number, number][] })[], mkdirs: string[] }} Look
 */

/** A connection with nothing on it for so long is a dead one. */
const CALL_MS = 5 * 60_000;

class Gone extends Error {}
class Offline extends Error {}

export class Machine {
  /** @param {{ app: string, dir: string, state: string, prefix?: string }} o `state`: a folder of this program's own; `prefix`: where the server's paths are, in a test */
  constructor(o) {
    this.app = o.app;
    this.dir = o.dir;
    this.prefix = o.prefix ?? '';
    this.state = this.at(o.state);
  }

  /** Where a path of the server's is here. @param {string} p */
  at(p) {
    return this.prefix + p;
  }

  /** @param {string} op @param {unknown} [body] JSON, or a stream @returns {Promise<import('node:http').IncomingMessage>} */
  call(op, body) {
    const stream = body && typeof body === 'object' && Symbol.asyncIterator in body ? /** @type {AsyncIterable<Buffer>} */ (body) : null;
    return new Promise((done, fail) => {
      // A connection of its own: a kept one may be closed under it just as it is sent.
      const req = request(new URL(`/_state/${op}?dir=${encodeURIComponent(this.dir)}`, this.app), { agent: false, method: 'POST', headers: { 'Content-Type': stream ? 'application/octet-stream' : 'application/json' } }, async (res) => {
        if (res.statusCode === 200) return done(res);
        let text = '';
        for await (const d of res) text += d;
        let said = text.slice(0, 500);
        try {
          said = JSON.parse(text).error ?? said;
        } catch {}
        fail(res.statusCode === 410 ? new Gone(said) : res.statusCode === 502 || res.statusCode === 503 ? new Offline(said) : new Error(`the app answered ${res.statusCode} to ${op}: ${said}`));
      });
      req.setTimeout(CALL_MS, () => req.destroy(new Error('the app did not answer')));
      req.on('error', (err) => fail(new Offline(err.message)));
      if (stream) pipeline(stream, req).catch((err) => fail(err));
      else req.end(JSON.stringify(body ?? {}));
    });
  }

  /** @param {string} op @param {unknown} [body] @returns {Promise<any>} */
  async json(op, body) {
    let text = '';
    for await (const d of await this.call(op, body)) text += d;
    return JSON.parse(text);
  }

  /**
   * Bring this machine's copy and the server's together: before a turn the server's state comes here (`start`), after
   * that what the turn changed goes home. `kept`: why the worktree did not go over the one at home.
   * `final`: nothing may be left for the next one.
   * @param {{ start?: boolean, git?: boolean, roots?: string[], final?: boolean }} o @returns {Promise<{ kept: string | null }>}
   */
  async sync(o) {
    const asked = Date.now();
    /** @type {Look} */
    const look = await this.json('look', { start: !!o.start, git: o.git !== false, roots: o.roots ?? null });
    const skew = look.now - Math.round((asked + Date.now()) / 2);
    for (const d of look.mkdirs) await mkdir(this.at(d), { recursive: true });
    // Files first: what a commit's turn was shown is home before its commit says it is.
    const left = await this.folders(look, skew, !!o.start);
    for (let tries = 1; o.final && left.size && tries < 3; tries++) {
      const again = await this.json('look', { git: false, roots: [...left.keys()] });
      left.clear();
      for (const [id, names] of await this.folders(again, skew, false)) left.set(id, names);
    }
    if (o.final && left.size) await this.json('failed', { files: [...left.values()].flat() });
    if (!look.git) return { kept: null };
    if (!o.start) return { kept: await this.checkpoint(look.git, look.ticket) };
    await this.seed(look.git, look.ticket);
    return { kept: null };
  }

  /** Each folder of a look; the files that did not go home, by folder. @param {Look} look @param {number} skew @param {boolean} start */
  async folders(look, skew, start) {
    /** @type {Map<string, string[]>} */
    const left = new Map();
    for (const r of look.roots) {
      const names = await this.folder(r, skew, start);
      if (names.length) left.set(r.id, names);
    }
    return left;
  }

  /** A branch the server's worktree is on is this copy's: another here that still has it (a closed minion's, say) lets go. @param {string} common @param {string} gitDir @param {string} branch */
  async claim(common, gitDir, branch) {
    for (const n of await readdir(join(common, 'worktrees')).catch(() => [])) {
      const head = join(common, 'worktrees', n, 'HEAD');
      if (join(common, 'worktrees', n) === gitDir || (await readFile(head, 'utf8').catch(() => '')).trim() !== `ref: ${branch}`) continue;
      const sha = (await git(['--git-dir', common, 'rev-parse', '--verify', '--quiet', branch], { ok: [1] })).trim();
      if (sha) await writeFile(head, `${sha}\n`);
    }
  }

  // -- the worktree --

  /** @param {GitLook} look @param {number} ticket */
  async seed(look, ticket) {
    const repo = this.at(look.repo);
    const work = this.at(look.cwd);
    const common = join(repo, '.git');
    const gitDir = join(common, 'worktrees', look.name);
    if (!existsSync(common)) {
      await mkdir(repo, { recursive: true });
      await git(['init', '-q', repo]);
    }
    const kept = ['--git-dir', common];
    const was = await readFile(join(common, 'config'), 'utf8');
    await writeFile(join(common, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n');
    try {
      for (const [k, v] of look.config) await git([...kept, 'config', '--add', k, v]);
    } catch (err) {
      await writeFile(join(common, 'config'), was);
      throw err;
    }
    await mkdir(join(common, 'info'), { recursive: true });
    await writeFile(join(common, 'info', 'exclude'), look.exclude);

    const mine = await refsOf(common, ['refs/heads', 'refs/remotes', 'refs/tags', 'refs/citadel']);
    const have = new Set(Object.values(mine));
    const refs = look.refs ?? {};
    const mark = `refs/citadel/machine/${ticket}`;
    const last = mine[mark] ?? null;
    const want = [...new Set([look.snap, ...Object.values(refs)])].filter((s) => !have.has(s));
    if (want.length) {
      await unpack(common, await this.call('pack', { want, have: [...have], snaps: last ? [last] : [] }));
      if (!(await complete(common, want))) throw new Error('what came from the app is not whole');
    }
    if (existsSync(join(work, '.git')) && existsSync(join(gitDir, 'HEAD'))) {
      // Work a lost turn left here that never got home: kept aside, not written over. shortcut: only here, T6 brings it home.
      const left = await snapshot(work);
      if (left.sha !== last && left.sha !== look.snap) await git([...kept, 'update-ref', `refs/citadel/left/${ticket}/${Date.now()}`, left.sha]);
    } else {
      await mkdir(gitDir, { recursive: true });
      await mkdir(work, { recursive: true });
      await writeFile(join(gitDir, 'commondir'), '../..\n');
      await writeFile(join(gitDir, 'gitdir'), `${join(look.cwd, '.git')}\n`);
      await writeFile(join(gitDir, 'HEAD'), `${(await snapHead(common, look.snap)).head || look.snap}\n`);
      // Relative, so it holds whatever folder the container has it under.
      await writeFile(join(work, '.git'), `gitdir: ${relative(work, gitDir)}\n`);
    }

    const { branch: own } = await snapHead(common, look.snap);
    if (own) await this.claim(common, gitDir, own);
    // The server's refs, but for branches another minion here is on, and this server's deletions of what it once sent.
    const elsewhere = await branchesElsewhere(common, gitDir);
    const main = look.main?.branch ?? null;
    const baseFile = join(this.state, `refs-${createHash('sha256').update(look.repo).digest('hex').slice(0, 16)}.json`);
    /** @type {Record<string, string>} */
    const base = JSON.parse(await readFile(baseFile, 'utf8').catch(() => '{}'));
    /** @type {string[]} */
    const lines = [];
    /** @type {string[]} */
    const asides = [];
    for (const [name, sha] of Object.entries(mine)) {
      if (name.startsWith('refs/citadel/') || refs[name] || base[name] !== sha || elsewhere.has(name)) continue;
      lines.push(`delete ${name}`);
      delete base[name];
    }
    for (const [name, sha] of Object.entries(refs)) {
      // The main checkout here is nobody's: its branch follows the server's.
      if (elsewhere.has(name) && name !== main) continue;
      const unsentHere = mine[name] && mine[name] !== sha && mine[name] !== base[name] && /^refs\/(heads|tags)\//.test(name);
      // Moved only here, and never got home: the next checkpoint sends it.
      if (unsentHere && base[name] === sha && name !== own) continue;
      if (unsentHere) asides.push(`update refs/citadel/left/${ticket}/${Date.now()}/${name.slice('refs/'.length)} ${mine[name]}`);
      if (mine[name] !== sha) lines.push(`update ${name} ${sha}`);
      base[name] = sha;
    }
    const update = (/** @type {string[]} */ l) => git([...kept, 'update-ref', '--no-deref', '--stdin'], { input: `${l.join('\n')}\n` });
    if (asides.length) await update(asides);
    const deletes = lines.filter((l) => l.startsWith('delete ')).length;
    for (const part of [lines.slice(0, deletes), lines.slice(deletes)]) {
      if (!part.length) continue;
      // One that cannot be (a branch left here in the way of another's name) must not keep the rest from coming.
      await update(part).catch(async () => {
        for (const l of part) await update([l]).catch(() => delete base[l.split(' ')[1]]);
      });
    }
    if (look.main) {
      // The scheme's own checkout: hooks and tools are read from it by path.
      await writeFile(join(common, 'HEAD'), look.main.branch ? `ref: ${look.main.branch}\n` : `${look.main.head}\n`);
      await git([...kept, '--work-tree', repo, 'reset', '-q', '--hard', look.main.head], { cwd: repo });
    }
    await restore(work, look.snap);
    const now = await snapshot(work);
    if (now.sha !== look.snap) throw new Error(`the copy here differs from the server's (${now.sha.slice(0, 9)}, not ${look.snap.slice(0, 9)})`);
    await git([...kept, 'update-ref', mark, look.snap]);
    await mkdir(this.state, { recursive: true });
    await writeFile(`${baseFile}.tmp`, JSON.stringify(base));
    await rename(`${baseFile}.tmp`, baseFile);
  }

  /** What changed here goes home; why it did not go over the worktree there, if so. @param {GitLook} look @param {number} ticket @returns {Promise<string | null>} */
  async checkpoint(look, ticket) {
    const work = this.at(look.cwd);
    const gitDir = await gitDirOf(work);
    const common = await commonDir(gitDir);
    const mark = `refs/citadel/machine/${ticket}`;
    let last = (await git(['--git-dir', common, 'rev-parse', '--verify', '--quiet', mark], { ok: [1] })).trim();
    if (!last) throw new Error('this turn has no copy of its worktree here');
    const baseFile = join(this.state, `refs-${createHash('sha256').update(look.repo).digest('hex').slice(0, 16)}.json`);
    /** @type {Record<string, string>} */
    const base = JSON.parse(await readFile(baseFile, 'utf8').catch(() => '{}'));
    const elsewhere = await branchesElsewhere(common, gitDir);
    const save = async () => {
      await mkdir(this.state, { recursive: true });
      await writeFile(`${baseFile}.tmp`, JSON.stringify(base));
      await rename(`${baseFile}.tmp`, baseFile);
    };
    // What home has: not what is on its way there, or was turned away.
    const held = () => Object.keys(base).flatMap((k) => (/^(sent|refused) /.test(k) ? [] : [base[k]]));
    const done = (/** @type {string} */ snap) => git(['--git-dir', common, 'update-ref', '--stdin'], { input: `update ${mark} ${snap}\ndelete ${mark}-next\ndelete ${mark}-from\n` });
    const cut = await resume(common, work, mark, (b) => base[b]);
    if (cut && !cut.back) {
      const { branch, head } = await snapHead(common, cut.snap);
      if (branch && head) base[branch] = head;
      await save();
      last = cut.snap;
    }
    if (cut) await done(last);
    const now = await snapshot(work);
    /** @type {{ name: string, old: string | null, sent: string[], sha: string }[]} */
    const refs = [];
    /** What went before in a call whose answer did not come, and what home said it would not take. @param {string} name @param {string} sha */
    const offer = (name, sha) => base[`refused ${name}`] !== sha && refs.push({ name, old: base[name] ?? null, sent: (base[`sent ${name}`] ?? '').split(' ').filter(Boolean), sha });
    for (const [name, sha] of Object.entries(await refsOf(common, ['refs/heads', 'refs/tags']))) if (base[name] !== sha && !elsewhere.has(name)) offer(name, sha);
    // The branches this worktree has been on.
    const been = new Set([now.branch, look.branch].map((b) => b?.replace('refs/heads/', '') ?? '(no branch)'));
    for (const l of (await git(['--git-dir', gitDir, 'reflog', 'show', '--format=%gs', 'HEAD', '--'], { ok: [128] })).split('\n')) for (const b of /^checkout: moving from (.+) to (.+)$/.exec(l)?.slice(1) ?? []) been.add(/^[0-9a-f]{40}$/.test(b) ? '(no branch)' : b);
    for (const l of (await git(['--git-dir', common, 'reflog', 'show', '--format=%H %gs', 'refs/stash', '--'], { ok: [128] })).split('\n').filter(Boolean)) {
      const sha = l.slice(0, 40);
      // The list is the repo's, every minion's here; git names the branch each was made on.
      if (been.has(/^(?:WIP on|On) (.+?): /.exec(l.slice(41))?.[1] ?? '') && !base[`refs/stash/${sha}`]) offer(`refs/stash/${sha}`, sha);
    }
    const own = (/** @type {string} */ name) => name === now.branch || name === look.branch;
    /** @type {string | null} */
    let why = null;

    if (now.sha === last && !refs.some((r) => own(r.name)) && look.moved && look.snap !== last) {
      // Nothing new here, and it moved at home meanwhile (a ship's rebase, a file a tool made): that comes here.
      await unpack(common, await this.call('pack', { want: [look.snap], have: [last, ...held()], snaps: [last] }));
      if (!(await complete(common, [look.snap]))) throw new Error('what came from the app is not whole');
      const { branch, head } = await snapHead(common, look.snap);
      if (branch) await this.claim(common, gitDir, branch);
      try {
        await place(common, work, mark, look.snap, { from: last, refs: branch && head ? [`update ${branch} ${head} ${base[branch] ?? ZERO}`] : [], hold: true });
      } catch (err) {
        // The turn was quicker: what it just did goes home at the next one.
        if (err instanceof Changed) return null;
        throw err;
      }
      if (branch && head) base[branch] = head;
      await save();
      await done(look.snap);
    } else if (now.sha === last && !refs.length && look.last === last) {
      return null;
    } else {
      const want = [now.sha, ...refs.map((r) => r.sha)];
      const send = async (/** @type {string[]} */ have) => {
        const got = await this.json('unpack', await packTo(common, want, have, have.length ? [last] : []));
        return got.need ? got : this.json('commit', { snap: now.sha, prev: last, refs, nested: now.nested });
      };
      for (const r of refs) if (!r.sent.includes(r.sha)) base[`sent ${r.name}`] = [...r.sent, r.sha].join(' ');
      await save();
      let said = await send([last, ...held()]);
      // It no longer holds what it once had (a branch deleted and cleaned up): everything, then.
      if (said.need) said = await send([]);
      if (said.need) throw new Error(`what went to the app did not arrive whole (${said.need})`);
      for (const r of refs) {
        if (said.refs?.includes(r.name)) {
          base[r.name] = r.sha;
          delete base[`sent ${r.name}`];
        } else if (said.applied || !own(r.name)) base[`refused ${r.name}`] = r.sha;
      }
      // Kept aside at home: the next checkpoint offers it again, with whatever is new.
      if (said.applied) await git(['--git-dir', common, 'update-ref', mark, now.sha]);
      why = said.kept ?? null;
      await save();
    }
    return why;
  }

  // -- folders --

  /** One folder; its files that did not go home. @param {Look['roots'][number]} root @param {number} skew @param {boolean} start */
  async folder(root, skew, start) {
    const at = this.at(root.path);
    const baseFile = join(this.state, `base-${createHash('sha256').update(root.path).digest('hex').slice(0, 16)}.json`);
    /** @type {Base} */
    const base = JSON.parse(await readFile(baseFile, 'utf8').catch(() => '{}'));
    const local = await listTree(at);
    /** @type {Map<string, Stat>} */
    const remote = new Map(root.files.map(([p, size, mtime]) => [p, [size, mtime]]));
    // An earlier session of the minion's, which this turn was not sent.
    if (root.session && !start) for (const p of remote.keys()) if (!local.has(p) && !base[p]) remote.delete(p);
    const plan = reconcile(local, remote, base, { partial: root.partial, mirror: start && !!root.session, skew });
    const before = JSON.stringify(base);
    if (!local.size || (!remote.size && !root.partial)) for (const p of Object.keys(base)) delete base[p];
    for (const p of plan.same) {
      if (local.get(p) || remote.get(p)) base[p] = { l: local.get(p) ?? null, r: remote.get(p) ?? null };
      else delete base[p];
    }
    for (const p of plan.dropHere) {
      const file = await inside(at, p);
      if (file && same(await statOf(file), local.get(p))) await unlink(file).catch(() => {});
      delete base[p];
    }
    for (const batch of batches(plan.dropThere.map((rel) => ({ rel, size: 0 })))) for (const p of (await this.json('drop', { root: root.id, files: batch.map(({ rel }) => ({ rel, expect: remote.get(rel) })) })).dropped) delete base[p];
    if (start && root.session) {
      // A transcript's end a lost turn left here that never got home: kept aside, not written over.
      const aside = join(this.state, 'left', String(Date.now()));
      for (const p of plan.pull) {
        if (!local.has(p) || same(local.get(p), base[p]?.l)) continue;
        await mkdir(dirname(join(aside, p)), { recursive: true });
        await copyFile(join(at, p), join(aside, p));
      }
    }
    /** @type {string[]} */
    const left = [];
    for (const batch of batches(plan.pull.map((rel) => ({ rel, size: remote.get(rel)?.[0] ?? 0 })))) {
      const frames = new Frames(await this.call('get', { files: batch.map((f) => ({ root: root.id, rel: f.rel })) }));
      /** @type {FileHead[]} */
      const files = (await frames.json()).files.map((/** @type {FileHead} */ f) => ({ ...f, expect: local.get(f.rel) ?? null }));
      const got = await take(
        frames,
        files,
        async (f) => (f.root === root.id && (await inside(at, f.rel)) ? { root: at, file: join(at, f.rel) } : null),
        (f) => f.mtime,
      );
      for (const [i, g] of got.entries()) if ('ok' in g) base[files[i].rel] = { l: g.ok, r: [files[i].size, files[i].mtime] };
    }
    for (const batch of batches(plan.push.map((rel) => ({ rel, size: local.get(rel)?.[0] ?? 0 }))))
      await this.push(
        root,
        at,
        batch.map((f) => f.rel),
        remote,
        base,
        true,
      ).then((names) => left.push(...names));
    if (JSON.stringify(base) === before) return left;
    await mkdir(this.state, { recursive: true });
    await writeFile(`${baseFile}.tmp`, JSON.stringify(base));
    await rename(`${baseFile}.tmp`, baseFile);
    return left;
  }

  /** Send files home; those that did not go. @param {Root} root @param {string} at @param {string[]} rels @param {Map<string, Stat>} remote @param {Base} base @param {boolean} append */
  async push(root, at, rels, remote, base, append) {
    /** @type {(FileHead & { file: string })[]} */
    const files = [];
    for (const rel of rels) {
      const file = await inside(at, rel);
      const st = file && (await statOf(file));
      if (!st) continue;
      const r = remote.get(rel) ?? null;
      // A transcript only grows: what is past the server's size, and the whole's hash to prove the rest is the same.
      const from = append && root.session && rel.endsWith('.jsonl') && r && r[0] > 0 && r[0] < st[0] ? r[0] : 0;
      files.push({ file, root: root.id, rel, size: st[0], mtime: st[1], x: await runs(file), expect: r, ...(from ? { from, hash: await sha256(file, st[0]) } : {}) });
    }
    if (!files.length) return [];
    const heads = files.map(({ file: _, ...f }) => f);
    const said = await this.json('put', frame({ files: heads, now: Date.now() }, files));
    /** @type {string[]} */
    const whole = [];
    /** @type {string[]} */
    const left = [];
    for (const [i, s] of said.files.entries()) {
      if ('ok' in s) base[files[i].rel] = { l: [files[i].size, files[i].mtime], r: s.ok };
      else if (s.left === 'whole') whole.push(files[i].rel);
      else left.push(files[i].rel);
    }
    return whole.length ? [...left, ...(await this.push(root, at, whole, remote, base, false))] : left;
  }
}

/** Files in transfers of at most 200 files or about 64 MB. @template {{ size: number }} T @param {T[]} files */
export function* batches(files) {
  /** @type {T[]} */
  let batch = [];
  let bytes = 0;
  for (const f of files) {
    if (batch.length && (batch.length >= 200 || bytes + f.size > 64_000_000)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(f);
    bytes += f.size;
  }
  if (batch.length) yield batch;
}

if (process.argv[1] && process.argv[2] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  onMachine = true;
  const o = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  try {
    console.log(JSON.stringify({ ok: true, ...(await new Machine({ ...o, prefix: process.env.CITADEL_SYNC_PREFIX }).sync(o)) }));
  } catch (err) {
    console.log(JSON.stringify(err instanceof Gone ? { gone: true } : { error: err.message, offline: err instanceof Offline }));
  }
}
