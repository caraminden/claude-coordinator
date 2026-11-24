// The PreToolUse hook a verifier case runs under (#1740): node verifier-guard.ts <case folder> [<readable folder>...].
// Unlike the reviewer's read-only guard it may write, but only inside its own case folder (its clone, its dev copy's
// data, its scratch), and it may read only there, the folders named after it and system paths. It refuses today's
// live state (which would leak the later fix into a frozen moment), anything that reaches the box's services or
// GitHub, other sessions, and killing by name. Fails closed: a call it can't read is refused.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [root, ...readable] = process.argv.slice(2).map((p) => resolve(p));
const HOME = process.env.HOME ?? '/home';
// The session's own saved long outputs (tool-results/) are its own, not today's state (#1505).
const OWN_OUTPUT = /\/\.claude\/projects\/[^/"' ]+\/[0-9a-f-]{36}\/tool-results\/[\w-][\w.-]*/g;
const OWN_ONE = /\/\.claude\/projects\/[^/]+\/[0-9a-f-]{36}\/tool-results\//;
const inside = (p: string, dirs: string[]) => dirs.some((d) => p === d || p.startsWith(d + '/'));

/** Why this call is refused, or '' to let it run. */
export function verdict(input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string }): string {
  const tool = String(input.tool_name ?? '');
  const ti = input.tool_input ?? {};
  if (/^(Agent|Task|WebFetch|WebSearch)$/.test(tool) || tool.startsWith('mcp__')) return `${tool} is off in a verifier case: run the change yourself.`;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const p = resolve(String(ti.file_path ?? ti.notebook_path ?? ''));
    return inside(p, [root]) ? '' : `writes only inside this case's folder ${root}`;
  }
  if (/^(Read|Grep|Glob|LS)$/.test(tool)) {
    const p = String(ti.file_path ?? ti.path ?? input.cwd ?? root);
    const abs = resolve(input.cwd ?? root, p);
    if (OWN_ONE.test(abs)) return '';
    return !abs.startsWith(HOME) || inside(abs, [root, ...readable]) ? '' : `reads only this case's folder ${root}, the kit and system paths`;
  }
  if (tool === 'Bash') {
    const c = String(ti.command ?? '').replace(OWN_OUTPUT, '');
    // Command words, not path parts: `.claude/rules` and `claude-coordinator` in a path pass.
    if (/(^|[\s;&|(`])(systemctl|loginctl|journalctl|systemd-run|gh|podman|docker|sudo|crontab|tailscale|caddy|pkill|killall|claude|citadel-dev-copy|citadel-heavy|heavy-unit)(?=$|[\s;&|)`])/m.test(c))
      return 'that command reaches the box, GitHub or other sessions; a verifier case runs only its own copy';
    if (/\bgit\b[^;&|]*\b(push|fetch|pull|clone|remote)\b/.test(c)) return 'git stays inside this case\'s clone: no push, fetch, pull, clone or remote';
    if (/\bkill\b(?![^;&|]*\s-?\d)/.test(c)) return 'kill by a literal pid only: look the pid up first (node boot.mjs stop for the server), then kill 12345';
    if (/(^|[\s'"=:])(~|\$HOME|\$\{HOME\})(\/|\s|$|['"])/.test(c)) return `name paths inside ${root}, not the home folder`;
    if (/:8573\b/.test(c)) return 'the live Citadel is out of reach; use your own copy\'s port';
    for (const m of c.matchAll(/\/home\/[^\s'"`;|&)<>]*/g)) if (!inside(resolve(m[0]), [root, ...readable])) return `${m[0]} is outside this case's folder`;
    return '';
  }
  return '';
}

const deny = (why: string) => console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Verifier case: ${why}` } }));
if (import.meta.main) {
  try {
    if (!root) throw new Error('no case folder');
    const why = verdict(JSON.parse(readFileSync(0, 'utf8')));
    if (why) deny(why);
  } catch {
    deny('that call could not be read, so it is refused.');
  }
}
