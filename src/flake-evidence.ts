// What a flake sighting keeps (#1438): the failing test's name and the first lines of its error, read from the failed CI run's log
// on the server (the retro log's flake line has only the file), and a class of failure counted per file on the Test health tab.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

const run = promisify(execFile);
export const MESSAGE_MAX = 600;

export const FLAKE_CLASSES = ['timed out waiting', 'wrong value', 'child or server exit', 'folder not empty', 'address in use', 'database busy', 'test timeout', 'other'] as const;
export type FlakeClass = (typeof FLAKE_CLASSES)[number];

/** The class of an error message; the first rule that matches wins, so the specific causes come before "wrong value". */
export function classifyFlake(message: string): FlakeClass {
  if (/EADDRINUSE|address already in use/i.test(message)) return 'address in use';
  if (/ENOTEMPTY|directory not empty|folder not empty/i.test(message)) return 'folder not empty';
  if (/SQLITE_BUSY|database is locked|database table is locked/i.test(message)) return 'database busy';
  if (/test timed out after|\btestTimeout\b|Promise resolution is still pending|ERR_TEST_FAILURE.*timeout/i.test(message)) return 'test timeout';
  if (/timed out waiting|timeout waiting|waiting for .* (?:timed out|failed)/i.test(message)) return 'timed out waiting';
  if (/exited with|exit code|ECONNREFUSED|ECONNRESET|EPIPE|server (?:exited|died|closed)|child .*(?:exit|died|killed)|SIGKILL|SIGTERM/i.test(message)) return 'child or server exit';
  if (/ERR_ASSERTION|AssertionError|Expected values|expected .* (?:to|but)|deepStrictEqual|strictEqual/i.test(message)) return 'wrong value';
  return 'other';
}

/** An error line can quote an environment value: tokens, key=value secrets and long opaque strings go before anything is stored. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[bap]-|AKIA)[\w-]{8,}/g, '[secret]')
    .replace(/\bBearer\s+[\w.~+/=-]{8,}/gi, 'Bearer [secret]')
    .replace(/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z_]*)(["']?\s*[=:]\s*)(["']?)[^\s"',;]+/gi, '$1$2$3[secret]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) && !m.includes('/') ? '[secret]' : m));
}

const ESC = /(?:\x1b|\^\[)\[[0-9;?]*[A-Za-z]/g;
const STAMP = /^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
const WORKDIR = /(?:file:\/\/)?\/[^\s()]*?\/_work\/[^/\s]+\/[^/\s]+\//g;

/** The first failing test of `file` in a CI job's raw log: its name and the first lines of its error (no stack frames), capped and scrubbed; null when the log doesn't name it. */
export function failureIn(rawLog: string, file: string): { name: string; message: string } | null {
  const lines = rawLog.split('\n').map((l) => l.replace(STAMP, '').replace(ESC, '').replace(WORKDIR, '').trimEnd());
  const at = lines.findLastIndex((l) => /^✖ failing tests:\s*$/.test(l));
  if (at < 0) return null;
  for (let i = at + 1; i < lines.length; i++) {
    const head = /^test at (\S+?):\d+:\d+$/.exec(lines[i]);
    if (!head || head[1] !== file) continue;
    let name = '';
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^test at /.test(lines[j]); j++) {
      const l = lines[j];
      if (!name && /^✖ /.test(l)) { name = l.slice(2).replace(/\s*\([\d.]+ms\)\s*$/, ''); continue; }
      if (/^\s+at /.test(l) || (l.trim() && !/^\s/.test(l))) break; // the stack, or the run's own next line
      body.push(l);
    }
    while (body.length && !body[0].trim()) body.shift();
    const message = scrubSecrets(body.slice(0, 8).join('\n').trim()).slice(0, MESSAGE_MAX);
    return { name: scrubSecrets(name).slice(0, 200), message: message || scrubSecrets(name).slice(0, MESSAGE_MAX) };
  }
  return null;
}

type Gh = (path: string) => Promise<string | null>;
const ghText: (as: GithubEnv) => Gh = (as) => async (path) => {
  try { return (await run('gh', ['api', '--allow-escape-sequences', path], { env: asEnv(as), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })).stdout; } catch { return null; }
};

/**
 * The failure of `file` in the CI run that went red just before a flake line at `at` (ms) on `branch` (land.sh pushes land/<branch>):
 * the newest failed runs first, their failed jobs' logs. Null when no log names the file (the row then keeps no message).
 */
export async function ciEvidence(slug: string, as: GithubEnv, branch: string, file: string, at: number, get: Gh = ghText(as)): Promise<{ name: string; message: string } | null> {
  const runs: { id: number; created_at: string; conclusion: string | null }[] = [];
  for (const b of [`land/${branch}`, branch]) {
    const body = await get(`repos/${slug}/actions/runs?branch=${encodeURIComponent(b)}&per_page=10`);
    try { runs.push(...(JSON.parse(body ?? '{}').workflow_runs ?? [])); } catch {}
  }
  const red = runs.filter((r) => r.conclusion === 'failure' && Date.parse(r.created_at) <= at).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 3);
  for (const r of red) {
    let jobs: { id: number; conclusion: string | null }[] = [];
    try { jobs = JSON.parse((await get(`repos/${slug}/actions/runs/${r.id}/jobs`)) ?? '{}').jobs ?? []; } catch {}
    for (const j of jobs.filter((x) => x.conclusion === 'failure')) {
      const log = await get(`repos/${slug}/actions/jobs/${j.id}/logs`);
      const found = log && failureIn(log, file);
      if (found) return found;
    }
  }
  return null;
}
