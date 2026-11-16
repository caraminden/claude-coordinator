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

/** A background job still running; `grunt` is a subagent, anything else a Bash job (a workflow run doesn't count: `claude -p`
 *  keeps the turn alive until it finishes, and no blocking command could wait for it, #359). */
export function runningTasks(input: any): { id: string; what: string; grunt: boolean; pid?: number }[] {
  const tasks = Array.isArray(input?.background_tasks) ? input.background_tasks : [];
  return tasks
    .filter((t: any) => t?.status === 'running' && t?.type !== 'workflow')
    .map((t: any) => ({ id: String(t.id), what: String(t.description || t.command || t.type || 'job').slice(0, 80), grunt: /agent/i.test(String(t.type ?? '')), pid: Number.isInteger(t.pid) ? t.pid : undefined }));
}

/** The background jobs still running, as "id (what it is)". */
export function runningJobs(input: any): string[] {
  return runningTasks(input).map((t) => `${t.id} (${t.what})`);
}

/** The one action that ends the wait for this job. */
function wayOut(t: ReturnType<typeof runningTasks>[number]): string {
  return t.grunt
    ? `${t.id} (${t.what}), a Grunt: wait for its result with SendMessage to ${t.id}, or stop it with TaskStop ${t.id}`
    : `${t.id} (${t.what}), a Bash job: wait with \`citadel-wait pid ${t.pid ?? '<pid>'}\` and a Bash timeout of 600000, repeated until it ends (the pid is the \`$!\` you noted when you started it); without the pid, \`citadel-wait cmd '<test>'\` / \`port <n>\` / \`file <path>\`, or stop it with TaskStop ${t.id}`;
}

/** Why the turn may not end yet, or null. `blocks` is how many stops this prompt already refused. */
export function jobCheck(input: any, role: string | undefined, blocks: number): string | null {
  if (role !== 'thread' || blocks >= MAX_STOP_BLOCKS) return null;
  const jobs = runningJobs(input);
  if (!jobs.length) return null;
  const lines = runningTasks(input).map((t) => `- ${wayOut(t)}`).join('\n');
  return `[citadel job check] Your own background job is still running, and ending the turn now would leave it unwatched. Keep its task in progress and end the wait with the action beside each job (\`sleep N; check\` is refused):\n${lines}\nA Grunt whose result this turn needs starts with \`run_in_background: false\` on its Agent call, so it can't hold up a later stop.`;
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
