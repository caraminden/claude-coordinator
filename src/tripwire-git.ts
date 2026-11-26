// The git habits every scheme shares: the tripwire's git rules, which gitReason in src/tripwire.ts runs for each `git` call.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { hard, under, type TripwireConfig, type Verdict, type Word } from './tripwire-base.ts';

// CLAUDE.md's "commit before you move", ported from Delve's git guard (tools/mods/delve/hooks, judgeGit).
const NEVER_PATH =
  "A pattern, a path it can't read or a flag like -f, -p or --overlay on a checkout or restore can throw uncommitted work away unsaved. Files and folders named plainly, from the index, HEAD or another commit (`git checkout -- .`, `git checkout main -- src`, `git restore path`), pass: the tripwire saves their diff under $TMPDIR first. To see an old version, use `git show <ref>:path` or `git diff`; otherwise commit first (a WIP commit is fine).";
const STASH_WHY = 'The stash stack is shared by every worktree of the repo, so another session can pop your entry, or you theirs. Commit work in progress instead (a WIP commit is fine), and use `git show HEAD:path` or `git diff` to see the old version.';
const PROTECTED = /^(main|master)$/;
const MAIN_WHY = "main changes only through the scheme's own route (tools/land.sh and tools/deploy.sh, or a merged pull request), never a push from a minion's worktree. Push your minion branch.";

/** Runs git in dir: null when it can't run there (no such folder, not a repo), so the guard lets the call through. */
function git(dir: string, ...args: string[]): { status: number; out: string } | null {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 3000 });
  return r.error || r.status === null ? null : { status: r.status, out: r.stdout };
}

/** A minion's worktree: <data>/projects/<id>/tickets/<n>, in any scheme. */
function inWorktree(dir: string, cfg: TripwireConfig): boolean {
  const projects = join(cfg.data, 'projects');
  return under(dir, projects) && /^\d+\/tickets\/[^/]+/.test(dir.slice(projects.length + 1));
}

/** A repo whose whole working tree is under the turn's TMPDIR: a scratch clone, whose changes nobody else has. */
function scratchClone(dir: string, cfg: TripwireConfig): boolean {
  const tmp = (cfg.env ?? process.env).TMPDIR;
  const top = tmp && under(dir, tmp) ? git(dir, 'rev-parse', '--show-toplevel') : null;
  return !!top && top.status === 0 && under(top.out.trim(), tmp!) && top.out.trim() !== tmp;
}

/** Whether a merge, rebase, cherry-pick or revert is stopped mid-way in this repo. */
function midMerge(dir: string): boolean {
  const states = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  const r = git(dir, 'rev-parse', ...states.flatMap((s) => ['--git-path', s]));
  return r?.status === 0 && r.out.split('\n').some((p) => p && existsSync(resolve(dir, p)));
}

/** Whether every path names a file with a conflict still open: `--ours` on any other file throws away its changes. */
function conflicted(dir: string, paths: Word[]): boolean {
  if (!paths.length || paths.some((w) => w.unknown || /[*?[]/.test(w.text))) return false;
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const u = git(dir, 'diff', '--name-only', '--diff-filter=U');
  if (top?.status !== 0 || u?.status !== 0) return false;
  const open = new Set(
    u.out
      .split('\n')
      .filter(Boolean)
      .map((f) => resolve(top.out.trim(), f)),
  );
  return paths.every((w) => open.has(resolve(dir, w.text)));
}

/**
 * The git habits every scheme shares: no stash; a file checked out or restored from HEAD or the index only once
 * its diff is saved (pushed onto `saves`, which the hook writes once the whole call passes), and no folder or other
 * commit's version; no checkout, merge, rebase or reset over uncommitted tracked changes; from a minion's worktree,
 * no push to main and no plain force. With the folder unknown it checks only what the words alone show.
 */
export function gitHabitReason(sub: string, args: Word[], dir: string | null, cfg: TripwireConfig, committed = false, moved = false, saves?: Save[]): Verdict | null {
  const words = args.map((w) => w.text);
  const has = (...flags: string[]) => words.some((a) => flags.includes(a));
  const plain = args.filter((w) => !w.text.startsWith('-'));
  let move: string | null = null;
  switch (sub) {
    case 'stash':
      return ['list', 'show'].includes(words[0]) ? null : hard(`\`git stash\` is blocked. ${STASH_WHY}`);
    case 'restore': {
      if (dir && scratchClone(dir, cfg)) return null;
      // Short flags can come together (`-SW`).
      const short = (f: string) => words.some((a) => new RegExp(`^-[qSW]*${f}[qSW]*$`).test(a));
      const staged = has('--staged') || short('S');
      if (staged && !has('--worktree') && !short('W')) return null;
      // Files and folders from the index, HEAD or another commit, saved first (#1716, #2038); any other flag (-p, --ours) stays refused.
      const refused = hard(`\`git restore ${words.join(' ')}\` is blocked. ${NEVER_PATH}`);
      let source: Word | undefined;
      const paths: Word[] = [];
      for (let k = 0; k < args.length; k++) {
        const t = args[k].text;
        if (t === '--') {
          paths.push(...args.slice(k + 1));
          break;
        }
        if (t === '-s' || t === '--source') {
          source = args[++k];
          if (!source) return refused;
        } else if (t.startsWith('--source=')) source = { ...args[k], text: t.slice('--source='.length) };
        else if (t.startsWith('-')) {
          if (!/^(-[qSW]+|--quiet|--worktree|--staged)$/.test(t)) return refused;
        } else paths.push(args[k]);
      }
      // --staged with the worktree is from HEAD unless named; the worktree alone is from the index unless named.
      if (staged && !source) source = { text: 'HEAD', unknown: false };
      return savePaths(`git restore ${words.join(' ')}`, paths, source, staged, false, dir, cfg, saves);
    }
    case 'checkout': {
      // A clone under the turn's TMPDIR is scratch; --ours and --theirs pick a side of an open conflict (#485).
      if (dir && (scratchClone(dir, cfg) || (has('--ours', '--theirs') && midMerge(dir) && conflicted(dir, plain)))) return null;
      const dd = words.indexOf('--');
      const quiet = (ws: string[]) => ws.every((a) => !a.startsWith('-') || a === '-q' || a === '--quiet');
      if (dd >= 0) {
        // Files and folders from the index, HEAD or another commit: saved first (#1716, #2038). Any flag but -q stays refused.
        const ref = plain.filter((w) => args.indexOf(w) < dd);
        if (quiet(words.slice(0, dd)) && ref.length <= 1) return savePaths(`git checkout ${words.join(' ')}`, args.slice(dd + 1), ref[0], ref.length === 1, true, dir, cfg, saves);
        return hard(`\`git checkout ${words.join(' ')}\` is blocked. ${NEVER_PATH}`);
      }
      // A new branch keeps the working tree as it is.
      if (has('-b', '-B', '--orphan') && !has('-f', '--force')) return null;
      if (plain.length > 1) {
        // git reads the first word as the commit when it names one (`git checkout main src`).
        if (quiet(words) && dir && !plain[0].unknown && git(dir, 'rev-parse', '--verify', '--quiet', `${plain[0].text}^{commit}`)?.status === 0) return savePaths(`git checkout ${words.join(' ')}`, plain.slice(1), plain[0], true, true, dir, cfg, saves);
        return hard(`\`git checkout <ref> <path>\` is blocked. ${NEVER_PATH}`);
      }
      if (plain.length === 0) {
        if (has('-')) move = 'git checkout -';
        // With no branch, -f still resets the working tree to HEAD (#468 S01-3).
        else if (words.some((a) => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a))) move = 'git checkout --force';
        break;
      }
      if (!dir) return null;
      const target = plain[0];
      // git takes a commit's name as a switch, and a file or glob as a path; any other name (a remote
      // branch to set up, a typo) it sorts out itself. Exit 1 is "not a commit"; other codes can't tell.
      const isRef = git(dir, 'rev-parse', '--verify', '--quiet', `${target.text}^{commit}`)?.status !== 1;
      if (!target.unknown && !isRef && (/[*?[]/.test(target.text) || existsSync(resolve(dir, target.text)))) {
        if (quiet(words) && !/[*?[]/.test(target.text)) return savePaths(`git checkout ${words.join(' ')}`, [target], undefined, false, true, dir, cfg, saves);
        return hard(`\`git checkout ${target.text}\` names a path, not a branch or commit. ${NEVER_PATH}`);
      }
      move = `git checkout ${target.text}`;
      break;
    }
    case 'switch':
      if (!has('-c', '-C', '--create', '--force-create')) move = 'git switch';
      break;
    case 'merge':
      if (!has('--abort', '--continue', '--quit')) move = 'git merge';
      break;
    case 'reset':
      if (has('--hard', '--merge', '--keep')) move = `git reset ${words.find((a) => /^--(hard|merge|keep)$/.test(a))}`;
      else if (dir && !moved) {
        // `git reset <commit> -- <paths>` resets only those paths; a bare `--` after the commit changes nothing.
        const dd = words.indexOf('--');
        const ref = plain.filter((w) => dd < 0 || args.indexOf(w) < dd);
        if ((dd < 0 || dd === words.length - 1) && ref.length === 1 && !ref[0].unknown) return staleSquashReason(ref[0].text, words, dir);
      }
      break;
    case 'rebase':
    case 'pull':
    case 'cherry-pick':
      if (!has('--abort', '--continue', '--quit', '--skip')) move = `git ${sub}`;
      break;
    case 'push':
      // A folder it lost track of (a cd to a variable) may be a worktree: the words alone still show main
      // or a plain force (#468 S01-9). A known folder outside one is left to the scheme.
      return !dir || inWorktree(dir, cfg) ? pushReason(args, dir) : null;
  }
  if (!move || !dir || committed) return null;
  const st = git(dir, 'status', '--porcelain', '--untracked-files=no');
  const dirty =
    st?.status === 0
      ? st.out
          .split('\n')
          .map((l) => l.slice(3))
          .filter(Boolean)
      : [];
  if (!dirty.length) return null;
  return hard(`Commit first: \`${move}\` with ${dirty.length} uncommitted tracked file(s) (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}) can lose them. Commit (a WIP commit is fine) before any checkout, merge, rebase or reset; to see another version of a file, use \`git show <ref>:path\`.`);
}

/**
 * Files whose uncommitted changes the hook saves under the turn's TMPDIR before a checkout or restore throws them away
 * (#1716); `head`: the index is written too, so staged changes go as well; `undo`: the step that puts the files back
 * where the patches apply (from the index or HEAD), when the call leaves them at another commit's version.
 */
export interface Save {
  dir: string;
  head: boolean;
  paths: string[];
  undo?: string;
}

// Raw and from the repo's top whatever the config: a textconv, an external diff, colour, noprefix or diff.relative would make a patch `git apply` can't take.
const RAW = ['--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/'];
/** What a checkout or restore that writes the index throws away (staged, then unstaged), or one that writes only the worktree (unstaged only). */
const parts = (head: boolean) => (head ? [['staged', '--cached'], ['unstaged']] : [['unstaged']]);
const shq = (p: string) => (/^[\w./@:+=-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

/**
 * `source`'s files under `paths` against the index: `untracked`, the ones the index lacks but the disk has, which a
 * checkout from it overwrites unsaved; `indexOnly`, whether the index has files the source lacks.
 */
function againstIndex(dir: string, source: string, paths: string[]): { untracked: string[]; indexOnly: boolean } | null {
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const tree = git(dir, 'ls-tree', '-r', '-z', '--name-only', '--full-name', source, '--', ...paths);
  const index = git(dir, 'ls-files', '-z', '--full-name', '--', ...paths);
  if (top?.status !== 0 || tree?.status !== 0 || index?.status !== 0) return null;
  const inTree = new Set(tree.out.split('\0').filter(Boolean));
  const inIndex = new Set(index.out.split('\0').filter(Boolean));
  return {
    untracked: [...inTree].filter((f) => !inIndex.has(f) && lstatSync(join(top.out.trim(), f), { throwIfNoEntry: false })),
    indexOnly: [...inIndex].some((f) => !inTree.has(f)),
  };
}

/**
 * A checkout or restore of files or folders, from `source` (a commit) or the index: through, once their uncommitted
 * changes are queued on `saves` (nothing queued when they are clean). `index`: the call writes the index as well as
 * the worktree; `overlay`: it leaves files the source lacks as they are (checkout does, restore doesn't). A pattern, a path or source it can't read, an untracked file the source would overwrite, or nowhere
 * to save (no TMPDIR, no saves list, a folder that isn't a repo) is refused.
 */
function savePaths(cmd: string, paths: Word[], source: Word | undefined, index: boolean, overlay: boolean, dir: string | null, cfg: TripwireConfig, saves?: Save[]): Verdict | null {
  const refused = hard(`\`${cmd}\` is blocked. ${NEVER_PATH}`);
  // Codex turns' hook has no saves list: there the old way still holds.
  if (!dir || !saves || !(cfg.env ?? process.env).TMPDIR) return hard(`\`${cmd}\` is blocked: this turn can't save the file's uncommitted changes first. Commit first (a WIP commit is fine), or write it over from HEAD on purpose: \`git show HEAD:./path > path\`.`);
  // A pathspec's magic (`:/`, `:(glob)`), a pattern or a brace list (bash expands `{a,b}.txt` to two files) can reach
  // more than the word it names. A folder or `.` names what it holds, which `git diff` of it saves (#2038).
  if (paths.some((w) => w.unknown || /[*?[{}]/.test(w.text) || w.text.startsWith(':'))) return refused;
  if (!paths.length) return null;
  const texts = paths.map((w) => w.text);
  let stray = false;
  if (source) {
    if (source.unknown || source.text.startsWith('-') || git(dir, 'rev-parse', '--verify', '--quiet', `${source.text}^{tree}`)?.status !== 0) return refused;
    // A file the source has and the index doesn't is written over even when untracked, which no diff holds.
    const seen = againstIndex(dir, source.text, texts);
    if (!seen) return refused;
    const lost = seen.untracked;
    // A checkout keeps the index's files its source lacks, staged edits and all, so the patches can't recreate them until they're cleared.
    stray = overlay && seen.indexOnly;
    if (lost.length) return hard(`\`${cmd}\` is blocked: it would write over ${lost.length} untracked file(s) (${lost.slice(0, 5).join(', ')}${lost.length > 5 ? ', …' : ''}), which the tripwire can't save. Move them aside or commit them first (a WIP commit is fine).`);
  }
  const quiet = parts(index).map(([, ...flags]) => git(dir, 'diff', '--quiet', ...flags, '--', ...texts)?.status);
  if (quiet.some((q) => q !== 0 && q !== 1)) return refused;
  if (!quiet.includes(1)) return null;
  // The patches apply to HEAD's version (index too) or the index's (worktree only); another source leaves the files elsewhere.
  const back = index ? (source?.text === 'HEAD' && !stray ? '' : 'restore --source=HEAD --staged --worktree') : source ? 'restore' : '';
  saves.push({ dir, head: index, paths: texts, ...(back ? { undo: `git -C ${shq(dir)} ${back} -- ${texts.map(shq).join(' ')}` } : {}) });
  return null;
}

/** Writes each queued save's patches under $TMPDIR/tripwire-saves: the note for the turn, or throws when one can't be saved. */
export function writeSaves(saves: Save[], cfg: TripwireConfig): string {
  const folder = join((cfg.env ?? process.env).TMPDIR!, 'tripwire-saves');
  mkdirSync(folder, { recursive: true });
  return saves
    .map((s, k) => {
      const name = `${Date.now()}-${k}-${basename(s.paths[0]).replace(/[^\w.-]/g, '_')}${s.paths.length > 1 ? `-and-${s.paths.length - 1}-more` : ''}`;
      // Patches name paths from the repo's top, so they apply from there.
      const top = git(s.dir, 'rev-parse', '--show-toplevel')?.out.trim() || s.dir;
      const steps: string[] = s.undo ? [`\`${s.undo}\``] : [];
      for (const [kind, ...flags] of parts(s.head)) {
        if (git(s.dir, 'diff', '--quiet', ...flags, '--', ...s.paths)?.status === 0) continue;
        const file = join(folder, `${name}.${kind}.patch`);
        if (git(s.dir, 'diff', ...RAW, `--output=${file}`, ...flags, '--', ...s.paths)?.status !== 0) throw new Error(`couldn't save the ${kind} changes of ${s.paths.join(', ')}`);
        steps.push(`\`git -C ${top} apply${kind === 'staged' ? ' --index' : ''} ${file}\``);
      }
      return `[tripwire] Saved the uncommitted changes of ${s.paths.join(', ')} before this call throws them away: ${steps.join(', then ')} puts them back.`;
    })
    .join('\n');
}

/**
 * A soft or mixed reset keeps the working tree, so onto a commit HEAD lacks (main's tip, from a branch that started
 * further back) the next commit has that commit as its parent and the branch's old tree: a fast-forward that quietly
 * reverts everything that landed since (Peek Auras #309 undid Peek Auras #310 so). By ancestry, not by name: any default branch.
 * Two git calls on the usual path, a third only when it would refuse.
 */
function staleSquashReason(target: string, words: string[], dir: string): Verdict | null {
  const sha = git(dir, 'rev-parse', '--verify', '--quiet', `${target}^{commit}`);
  if (sha?.status !== 0) return null; // a path, not a commit
  if (git(dir, 'merge-base', '--is-ancestor', sha.out.trim(), 'HEAD')?.status !== 1) return null;
  // Only a commit on some branch is other work: the commit before an amend (HEAD@{1}) is on none, and undoing an amend reverts nothing.
  const on = git(dir, 'for-each-ref', '--count=1', '--contains', sha.out.trim(), '--format=%(refname)', 'refs/heads', 'refs/remotes');
  if (on?.status !== 0 || !on.out.trim()) return null;
  return hard(
    `\`git reset ${words.join(' ')}\` keeps this branch's files but puts it on ${target}, which has commits this branch doesn't: the next commit would revert them (Peek Auras #309 undid a landing that way, and land saw a clean fast-forward). To squash, rebase first (\`git rebase ${target}\`) and then reset, or squash where the branch started: \`git reset --soft $(git merge-base HEAD ${target})\`. To move a branch with no work of its own up to ${target}, use \`git reset --keep ${target}\`.`,
  );
}

/** Why a `git push` from a minion's worktree is blocked: it reaches main, or forces without a lease. With dir null, the current branch is unknown. */
function pushReason(args: Word[], dir: string | null): Verdict | null {
  const pos: Word[] = [];
  let repo = false;
  let tags = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (t === '--') {
      pos.push(...args.slice(k + 1));
      break;
    }
    if (/^--(all|mirror|branches)$/.test(t)) return hard(`\`git push ${t}\` pushes main too. ${MAIN_WHY}`);
    if (t === '--force' || (/^-[A-Za-z0-9]+$/.test(t) && t.includes('f'))) return hard('Plain force pushes are blocked: use `--force-with-lease`, and only on your own branch.');
    if (t === '--tags') tags = true;
    else if (t === '--repo') (repo = true), k++;
    else if (t.startsWith('--repo=')) repo = true;
    else if (/^(-o|--push-option|--receive-pack|--exec)$/.test(t) || /^-[A-Za-z0-9]*o$/.test(t)) k++;
    else if (!t.startsWith('-')) pos.push(args[k]);
  }
  const refspecs = repo ? pos : pos.slice(1);
  let branch: string | undefined;
  const current = () => (branch ??= (dir && git(dir, 'symbolic-ref', '--short', '-q', 'HEAD')?.out.trim()) || '');
  // With no refspec git pushes the current branch (--tags alone pushes only tags).
  if (!refspecs.length && !tags && PROTECTED.test(current())) return hard(`This push names no branch, and the current branch is ${current()}. ${MAIN_WHY}`);
  for (const w of refspecs) {
    if (w.unknown) continue;
    const r = w.text;
    if (r.startsWith('+')) return hard(`\`${r}\` is a force push: use \`--force-with-lease\`, and only on your own branch.`);
    if (r === ':') return hard(`\`git push <remote> :\` pushes every matching branch, main included. ${MAIN_WHY}`);
    const colon = r.indexOf(':');
    let dst = colon < 0 ? r : r.slice(colon + 1) || r.slice(0, colon);
    if (dst === 'HEAD' || dst === '@') dst = current();
    // git completes heads/main to refs/heads/main, as guard.sh knows.
    dst = dst.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
    if (PROTECTED.test(dst)) return hard(`Pushing to ${dst} is blocked. ${MAIN_WHY}`);
    if (dst.includes('*')) return hard(`The wildcard refspec \`${r}\` could push main. Push your minion branch by name.`);
  }
  return null;
}
