/**
 * The job check (Stop hook, minions only): refuses to end the turn while this session's own
 * background Bash job is still running, at most twice per prompt, and says to wait inside the turn.
 * A running Grunt never blocks the stop (#1031): `claude -p` holds the turn open for it (Claude Code's
 * quiet background wait, checked on 2.1.323) and wakes the session with its result, so the turn ends
 * once the Grunt is done and its result read. Refusing that stop only cost a retry.
 * Ported from Delve's mod (tools/mods/delve/hooks/runs.ts), which tracked the jobs itself; Claude Code
 * now lists them in the Stop input (background_tasks).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerHook } from './answer-check.ts';
import { note } from './retro-log.ts';
import type { BackgroundTask, HookInput } from './hook-input.ts';

export const MAX_STOP_BLOCKS = 2;

/** A background job still running; `grunt` is a subagent, anything else a Bash job (a workflow run doesn't count: `claude -p`
 *  keeps the turn alive until it finishes, and no blocking command could wait for it, #359). */
export function runningTasks(input: HookInput): { id: string; what: string; grunt: boolean; pid?: number }[] {
  const tasks = Array.isArray(input?.background_tasks) ? input.background_tasks : [];
  return tasks
    .filter((t: BackgroundTask | null) => t?.status === 'running' && t?.type !== 'workflow')
    .map((t: BackgroundTask) => ({ id: String(t.id), what: String(t.description || t.command || t.type || 'job').slice(0, 80), grunt: /agent/i.test(String(t.type ?? '')), pid: Number.isInteger(t.pid) ? t.pid : undefined }));
}

/** The background Bash jobs still running (Grunts left out), as "id (what it is)". */
export function runningJobs(input: HookInput): string[] {
  return runningTasks(input).filter((t) => !t.grunt).map((t) => `${t.id} (${t.what})`);
}

/** The one action that ends the wait for this Bash job. */
function wayOut(t: ReturnType<typeof runningTasks>[number]): string {
  return `${t.id} (${t.what}), a Bash job: wait with \`citadel-wait pid ${t.pid ?? '<pid>'}\` and a Bash timeout of 600000, repeated until it ends (the pid is the \`$!\` you noted when you started it); without the pid, \`citadel-wait cmd '<test>'\` / \`port <n>\` / \`file <path>\`, or stop it with TaskStop ${t.id}`;
}

/** Why the turn may not end yet, or null. `blocks` is how many stops this prompt already refused. */
export function jobCheck(input: HookInput, role: string | undefined, blocks: number): string | null {
  if (role !== 'thread' || blocks >= MAX_STOP_BLOCKS) return null;
  const jobs = runningTasks(input).filter((t) => !t.grunt);
  if (!jobs.length) return null;
  const lines = jobs.map((t) => `- ${wayOut(t)}`).join('\n');
  return `[citadel job check] Your own background job is still running, and ending the turn now would leave it unwatched. Keep its task in progress and end the wait with the action beside each job (\`sleep N; check\` is refused):\n${lines}`;
}

/** Runs the check for one Stop, counting refusals per prompt in a temp file; prints the block, if any. */
export function stopHook(input: HookInput, env = process.env, stateDir = join(tmpdir(), 'citadel-kit')): string | null {
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
    // The answer check's trial (answer-check.ts) judges only a stop that ends the turn: not a refused one, nor one
    // with a Grunt still running, whose result wakes the turn again.
    if (out) process.stdout.write(out);
    else if (!runningTasks(input).some((t) => t.grunt)) {
      const refusal = { out: {} as { block?: string } };
      answerHook(input, process.env, refusal);
      if (refusal.out.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: refusal.out.block }));
    }
  } catch (err) {
    process.stderr.write(`[citadel job check] skipped: ${(err as Error).message}\n`);
  }
}
