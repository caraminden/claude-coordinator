/**
 * The grunt-model guard (PreToolUse on Agent, every session, Grunts included): sends back an Agent call that leaves a
 * Grunt's model or effort to chance, so each Grunt's are chosen for its job (Cara, 2026-11-17, on #941's card: "Why
 * should a grunt have the same effort or model as its parent? shouldnt we be making that decision intentionally?").
 * A call passes when its model comes from the call or the agent's definition (not `inherit`), and its effort from the
 * call, the definition or CLAUDE_CODE_EFFORT_LEVEL. Built-ins (general-purpose, Explore, Plan) have no definition, so
 * they need both on the call. Forks run on the parent's model by design and pass. The reason quotes the job table in
 * citadel:subagents (the one place its rows live). Fails open: an agent it can't find or read goes through.
 * A call it lets through without `run_in_background` gets `false` (#1031): Claude Code backgrounds a Grunt by
 * default, and a turn that ends on "started it" reads as its answer until the result wakes it. A call that
 * sets it either way keeps its choice.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILT_INS = new Set(['general-purpose', 'Explore', 'Plan']);

/** A definition file's model, effort and name from its frontmatter, or null when it can't be read. */
function frontmatter(file: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(name|model|effort):\s*['"]?([^'"#]*?)['"]?\s*$/);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

/** The definition of an agent named `name` in dir: <name>.md, else any .md whose name: matches. */
function findIn(dir: string, name: string): Record<string, string> | null {
  const direct = frontmatter(join(dir, `${name}.md`));
  if (direct && (!direct.name || direct.name === name)) return direct;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  for (const f of files) {
    const fm = frontmatter(join(dir, f));
    if (fm?.name === name) return fm;
  }
  return null;
}

/** Where a subagent_type's definition lives: the kit's agents/ for citadel:<name>, else the repo's and the user's. */
function definition(type: string, cwd: string): Record<string, string> | null {
  const parts = type.split(':');
  if (parts.length > 1) {
    if (parts[0] !== 'citadel') return null; // another plugin's: unknown here
    return frontmatter(join(KIT, 'agents', ...parts.slice(1)) + '.md');
  }
  const dirs = [cwd, process.env.CLAUDE_PROJECT_DIR].filter(Boolean).map((d) => join(d!, '.claude', 'agents'));
  dirs.push(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'agents'));
  for (const d of dirs) {
    const fm = findIn(d, type);
    if (fm) return fm;
  }
  return null;
}

/** The rows of the job table in citadel:subagents: job, model and effort as written. */
export function jobTable(file = join(KIT, 'skills', 'subagents', 'SKILL.md')): { job: string; model: string; effort: string }[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\|\s*Job\s*\|\s*Model\s*\|\s*Effort\s*\|/.test(l));
  if (start < 0) return [];
  const rows: { job: string; model: string; effort: string }[] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|')) break;
    const [job, model, effort] = l.split('|').slice(1).map((c) => c.trim());
    rows.push({ job, model, effort });
  }
  return rows;
}

/** One hook call; returns what to print (a deny, or the call in the foreground), or null to let the call run as it is. */
export function gruntModelHook(input: any): string | null {
  if (input?.tool_name !== 'Agent' && input?.tool_name !== 'Task') return null;
  const ti = input?.tool_input ?? {};
  // Only a plugin's hook may change a call's input; Claude Code refuses the call if a user's settings hook tries.
  const pass = () => (ti.run_in_background === undefined ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, run_in_background: false } } }) : null);
  const type = String(ti.subagent_type || 'general-purpose');
  if (type === 'fork') return pass();
  let def: Record<string, string> | null = {};
  if (!BUILT_INS.has(type)) {
    def = definition(type, String(input?.cwd ?? process.cwd()));
    if (!def) return pass();
  }
  const hasModel = Boolean(ti.model) || Boolean(def.model && def.model !== 'inherit');
  const hasEffort = Boolean(ti.effort) || Boolean(def.effort) || Boolean(process.env.CLAUDE_CODE_EFFORT_LEVEL);
  if (hasModel && hasEffort) return pass();
  const missing = [!hasModel && 'no model', !hasEffort && 'no effort'].filter(Boolean).join(' and ');
  const rows = jobTable();
  const mine = rows.filter((r) => r.job.includes(`\`${type}\``));
  const hint = mine.length ? ` Row for ${type}: ${mine.map((r) => `${r.job}: ${r.model}, ${r.effort}`).join('; ')}.` : '';
  const table = rows.map((r) => `- ${r.job}: ${r.model}, ${r.effort}`).join('\n');
  const reason =
    `[citadel grunt-model] This Agent call starts ${type} with ${missing} chosen: neither the call nor its definition sets it, so the Grunt would get whatever its parent or the model's default happens to be. ` +
    `Pick the row for this job in the citadel:subagents job table and pass \`model\` and \`effort\` on the call.${hint}\n${table}`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Fails open: a guard that can't run lets the call through.
  try {
    const out = gruntModelHook(JSON.parse(readFileSync(0, 'utf8')));
    if (out) process.stdout.write(out);
  } catch {
    // See above.
  }
}
