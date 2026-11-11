/**
 * The job check (Stop hook, minions only): refuses to end the turn while this session's own
 * background job is still running, at most twice per prompt, and says to wait inside the turn. A
 * minion's turn is one `claude -p`; once it ends the minion shows idle and the job may not outlive it.
 * Ported from Delve's mod (tools/mods/delve/hooks/runs.ts), which tracked the jobs itself; Claude Code
 * now lists them in the Stop input (background_tasks).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerHook } from './answer-check.ts';
import { note } from './retro-log.ts';

export const MAX_STOP_BLOCKS = 2;

/**
 * The background jobs still running, as "id (what it is)". A workflow run doesn't count: `claude -p`
 * keeps the turn alive until it finishes, and no blocking command could wait for it (#359).
 */
export function runningJobs(input: any): string[] {
  const tasks = Array.isArray(input?.background_tasks) ? input.background_tasks : [];
  return tasks.filter((t: any) => t?.status === 'running' && t?.type !== 'workflow').map((t: any) => `${t.id} (${String(t.description || t.command || t.type || 'job').slice(0, 80)})`);
}

/** Why the turn may not end yet, or null. `blocks` is how many stops this prompt already refused. */
export function jobCheck(input: any, role: string | undefined, blocks: number): string | null {
  if (role !== 'thread' || blocks >= MAX_STOP_BLOCKS) return null;
  const jobs = runningJobs(input);
  if (!jobs.length) return null;
  return `[citadel job check] Your own background job is still running: ${jobs.join(', ')}. Don't end the turn to wait for it: keep its task in progress and wait inside the turn with one blocking command (up to 10 minutes per call, repeated) until it finishes, or stop it with TaskStop if it is no longer needed.`;
}

/** Runs the check for one Stop, counting refusals per prompt in a temp file; prints the block, if any. */
export function stopHook(input: any, env = process.env, stateDir = join(tmpdir(), 'citadel-kit')): string | null {
  const file = join(stateDir, `jobs-${String(input?.session_id ?? 'unknown').replace(/[^\w.-]/g, '_')}.json`);
  // Without a prompt id to count by, refuse only a first stop.
  const prompt = input?.prompt_id ?? null;
  let blocks = prompt ? 0 : input?.stop_hook_active ? MAX_STOP_BLOCKS : 0;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (prompt && state.prompt === prompt) blocks = state.blocks;
  } catch {
    // No refusal yet this session.
  }
  const reason = jobCheck(input, env.COORDINATOR_ROLE, blocks);
  if (!reason) return null;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ prompt, blocks: blocks + 1 }));
  note(input, 'refused stop', `background job still running: ${runningJobs(input).join(', ')}`, env);
  return JSON.stringify({ decision: 'block', reason });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails open: a broken input lets the turn end.
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const out = stopHook(input);
    // The answer check's trial (answer-check.ts) judges only a stop that ends the turn.
    if (out) process.stdout.write(out);
    else answerHook(input);
  } catch (err: any) {
    process.stderr.write(`[citadel job check] skipped: ${err.message}\n`);
  }
}
