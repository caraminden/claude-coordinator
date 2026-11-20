// The PreToolUse hook an opening-move replay runs with (#1117): reads only, as src/side-guard.ts allows a side question,
// but Citadel's own tools pass (they reach stub.ts, never the live app), so a rerun can still post a card or ship.
// It also refuses any call naming today's live state (the real shared folder, the live database, the live checkout, the
// auto-memory), which would leak the present into a frozen moment. Fails closed: a call it can't read is refused.
import { readFileSync } from 'node:fs';
import { sideGuard } from '../../src/side-guard.ts';

const LIVE = /\/projects\/\d+\/shared\/project|coordinator\.db|\/home\/[^/"]+\/claude-coordinator\b|~\/claude-coordinator\b|\.claude\/projects\//;
const deny = (why: string) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } }));
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const tool = String(input?.tool_name ?? '');
  if (!/^mcp__(thread|coordinator)__/.test(tool) && !/^Task(Create|Update|List|Get)$/.test(tool)) {
    const why = sideGuard(input);
    if (LIVE.test(JSON.stringify(input?.tool_input ?? {}))) deny('This turn is a replay of a past moment: today\'s shared folder, database, live checkout and memory are out of reach. Work from the chat.');
    else if (why) deny(`This turn is read-only (a replay): ${why.replace(/^.*?(read-only copy of the minion's session\.?|anything)\s*/, '')}`);
  }
} catch {
  deny('This turn is read-only (a replay), and that call could not be read, so it is refused.');
}
