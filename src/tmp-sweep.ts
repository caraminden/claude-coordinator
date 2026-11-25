/**
 * Scratch Citadel's own tools leave in perigee's RAM-backed /tmp when they are killed (#1339): lint-ps1's profile
 * folders (84 filled 4.5G), boot-check's copies of the database (1.7G each) and a ship train's scratch worktree.
 * Removed only when it is ours (our uid), made by one of these tools (by name), older than an hour, and its maker is
 * gone: no live pid for a name that carries one, and no process of ours working inside it. Anything else in /tmp is
 * other users' or other apps', and stays.
 *
 * Second kind (#1759): test leftovers. Tests that call os.tmpdir() outside a turn left ~22,000 entries (2 GB) in /tmp.
 * Removed when ours, named like one of the known test stems (a stem plus mkdtemp's six characters; never "anything
 * old"), older than TEST_MIN_AGE_MS, and no process of ours has it open or as its working directory. The stems cover
 * Citadel's own tests and the VoiceAnalyzer, TWIReader and Peek test folders their Taskmasters left to this sweep.
 */
import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { thrown } from './thrown.ts';

export const MIN_AGE_MS = 60 * 60_000;
const NAMES: { re: RegExp; pid: boolean }[] = [
  { re: /^lint-ps1-(\d+)$/, pid: true },
  { re: /^heavy-(\d+)$/, pid: true },
  { re: /^citadel-boot-check-[A-Za-z0-9]+$/, pid: false },
  { re: /^land-(train|guard)\.[A-Za-z0-9]+$/, pid: false },
];

/** Test leftovers are old for days before they go, so no run of a suite can still be using one. */
export const TEST_MIN_AGE_MS = 3 * 24 * 60 * 60_000;
// mkdtemp's six characters; one has a digit or capital (all lowercase is 0.5% of real ones), so a plain word like "-backup" never matches.
const SUFFIX = '-(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{6}';
const stems = (list: string[]) => new RegExp(`^(?:${list.join('|')})${SUFFIX}$`);
const TEST_NAMES: { re: RegExp; file?: boolean }[] = [
  {
    re: stems([
      'answer-(?:proc|refuse|shared|state|t|tmp)',
      'batch',
      'cg',
      'curator',
      'decisions',
      'exec',
      'fp',
      'fp-nice',
      'kit-(?:big-read|flail|grunt-model|jobs|shared|test-first|tmp|tr)',
      'land-busy',
      'machine-setup',
      'memfiles',
      'outside',
      'proc',
      'prlinks-gh',
      'psi',
      'run-tests',
      'sched-cat',
      'turn-images',
      'unit-drift',
    ]),
  },
  // Other schemes' tests, left to this sweep by their Taskmasters (VoiceAnalyzer, TWIReader, Peek).
  { re: new RegExp(`^(?:voice|twi)(?:-[a-z0-9-]+)?${SUFFIX}$`) },
  { re: stems(['peek-(?:wanted|auras-test|video)']) },
  // ui-measure's screenshots: files, not folders.
  { re: /^uim-(?:busy-\d+-\d+|hover-\d+)\.png$/, file: true },
];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return thrown(err).code === 'EPERM';
  }
};

/** Paths our processes have as their working directory (a ship's tool that cd'd into its scratch) or hold open. */
async function workingDirs(proc: string): Promise<string[]> {
  const out: string[] = [];
  let pids: string[] = [];
  try {
    pids = (await readdir(proc)).filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const p of pids) {
    try {
      out.push(await readlink(join(proc, p, 'cwd')));
    } catch {
      // Another user's, or gone already.
    }
    try {
      for (const fd of await readdir(join(proc, p, 'fd'))) {
        try {
          out.push(await readlink(join(proc, p, 'fd', fd)));
        } catch {
          // Closed meanwhile.
        }
      }
    } catch {
      // Another user's, or gone already.
    }
  }
  return out;
}

/** Sweep each of `roots` (default: /tmp and the heavy commands' folder); returns the folders removed. Async: a first pass over thousands of entries must not hold the server's thread. */
export async function sweepOrphanTmp(roots: string[] = ['/tmp'], now = Date.now(), opts: { proc?: string; uid?: number } = {}): Promise<string[]> {
  const uid = opts.uid ?? process.getuid?.();
  const cwds = await workingDirs(opts.proc ?? '/proc');
  const removed: string[] = [];
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const rule = NAMES.find((r) => r.re.test(name));
      const testRule = rule ? undefined : TEST_NAMES.find((r) => r.re.test(name));
      if (!rule && !testRule) continue;
      const dir = join(root, name);
      try {
        const st = await lstat(dir);
        if (st.uid !== uid) continue;
        if (testRule) {
          if (st.isSymbolicLink() || st.isDirectory() === !!testRule.file || now - st.mtimeMs < TEST_MIN_AGE_MS) continue;
        } else if (!st.isDirectory() || now - st.mtimeMs < MIN_AGE_MS) continue;
        if (rule?.pid && alive(Number(rule.re.exec(name)![1]))) continue;
        if (cwds.some((c) => c === dir || c.startsWith(`${dir}/`))) continue;
        await rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        // Gone, or not ours to remove: the next pass looks again.
      }
    }
  }
  return removed;
}
