// The hook that caps a contraption turn's subagents (src/contraption-turns.ts): at most `max` Agent calls
// at once, nested ones included. PreToolUse claims a numbered slot file in `dir` with an exclusive create,
// so two calls at once can't both take the last one; PostToolUse (and its failure twin) frees it.
// Background agents are off for these turns, so an Agent call's Post comes once its agent is done.
// Usage: node contraption-agent-cap.ts <slots dir> <max>, with the hook's JSON on stdin.
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, max] = [process.argv[2], Number(process.argv[3])];
const input = JSON.parse(readFileSync(0, 'utf8'));
const id = String(input.tool_use_id ?? '');

if (input.hook_event_name === 'PreToolUse') {
  for (let i = 0; i < max; i++) {
    try {
      writeFileSync(join(dir, String(i)), id, { flag: 'wx' });
      process.exit(0);
    } catch {
      // Taken: try the next.
    }
  }
  const reason = `At most ${max} agent${max === 1 ? '' : 's'} may run at once here: wait for one to finish, or do it yourself.`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
} else {
  for (const f of readdirSync(dir)) {
    try {
      if (readFileSync(join(dir, f), 'utf8') === id) rmSync(join(dir, f), { force: true });
    } catch {
      // Freed by another call meanwhile.
    }
  }
}
