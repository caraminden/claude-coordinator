// A reader thread only reads (#1628): starting a process (git, gh) or writing a file throws, so a route that would do
// either is answered by the main thread instead, and never runs twice. src/reader.ts imports this first: a module
// that keeps its own copy at load time (`const run = promisify(execFile)`) must load after the swap to get it.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { workerData } from 'node:worker_threads';

let count = 0;
/**
 * How many times this thread was refused so far. A route can catch the refusal and answer as if the thing came out
 * empty (a `git` that "failed"), so src/reader.ts hands any request that saw one to the main thread, caught or not.
 */
export const refusals = () => count;
/** The error to throw for something a reader doesn't do, counted. */
export const refusal = (what: string) => (count++, new Error(`A reader thread doesn't ${what}`));

export function onlyReads() {
  const refuse = (what: string) => () => { throw refusal(what); };
  for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) (childProcess as any)[n] = refuse(`run ${n}`);
  for (const n of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'renameSync', 'rename', 'rmSync', 'rm', 'unlinkSync', 'unlink', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'createWriteStream', 'symlinkSync', 'symlink']) (fs as any)[n] = refuse(`write files (${n})`);
  for (const n of ['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'copyFile', 'cp', 'symlink'] as const) (fs.promises as any)[n] = refuse(`write files (${n})`);
  syncBuiltinESMExports(); // so `import { spawn } from 'node:child_process'` in any module sees these too
}

if (workerData?.reader) onlyReads();
