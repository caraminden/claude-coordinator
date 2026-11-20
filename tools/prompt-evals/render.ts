// Renders one prompt version for a replay (#1117): the system prompt and turn note its src/prompts.ts builds for a
// case's minion or Taskmaster, and the tool list its src/mcp.ts offers. A child process of run.ts, so an old ref's
// modules load on their own. Usage: node render.ts <version dir> '<spec json>'  → JSON on stdout.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Spec = {
  role: 'minion' | 'taskmaster';
  number: number;
  title: string;
  appText: string;        // the Citadel-wide instructions
  schemeText: string;     // the scheme's own
  dirs: { files: string; shared: string; tickets: string; cwd: string };
};

// The Citadel scheme's settings as they were on 2026-11-19 (projects row 2); instructions come from the spec.
const PROJECT = {
  id: 2, name: 'Citadel', repo_url: null, ship_path: 'citadel', go_from: 'high', try_first: 'never', fable_ok: 'on', grill: 'design',
  gh_runners: 'ask', shot_widths: '1440,390', shot_themes: 'light', shots_required: 1, shot_note: '', skills_off: '', approval_rules: '',
};

function tools(dir: string, role: Spec['role']): Promise<object[]> {
  // An unreachable API and no token: listing tools calls nothing, and a stray call can't reach the live app.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', COORDINATOR_API: 'http://127.0.0.1:9', COORDINATOR_TOKEN: '',
    COORDINATOR_ROLE: role === 'taskmaster' ? 'coordinator' : 'thread', COORDINATOR_PROJECT: '2', COORDINATOR_TICKET: '0',
    COORDINATOR_DEPLOYS: '1', COORDINATOR_APPROVALS: role === 'minion' ? '1' : '', COORDINATOR_CONTAINER: '1',
    COORDINATOR_APP_INSTRUCTIONS: role === 'taskmaster' ? '1' : '' };
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [join(dir, 'src/mcp.ts')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => { p.kill(); fail(new Error('mcp.ts gave no tool list in 20 s')); }, 20_000);
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n').slice(0, -1)) {
        if (!line.includes('"id":2')) continue;
        clearTimeout(t); p.kill();
        return done(JSON.parse(line).result.tools);
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  });
}

export async function render(dir: string, s: Spec): Promise<{ system: string; turn: string; tools: object[] }> {
  const m = await import(pathToFileURL(resolve(dir, 'src/prompts.ts')).href);
  const project = { ...PROJECT, instructions: s.schemeText };
  const ticket = { id: 900_000 + s.number, project_id: 2, number: s.role === 'taskmaster' ? null : s.number, title: s.title,
    kind: s.role === 'taskmaster' ? 'coordinator' : 'ticket', status: 'idle', cwd: s.dirs.cwd, branch: `ticket/${s.number}-replay`,
    permission_mode: 'bypassPermissions', model: null, effort: null, workflow: 0, build: null, plugin_dirs: '', coordinator_of: null, created_by: 'replay' };
  const args = [project, ticket, s.dirs.files, s.dirs.shared, s.dirs.tickets, null, [], true, s.appText];
  const text = (p: Record<string, string[]>) => Object.values(p).flat().join('\n');
  // Before the turn note split off (#878), systemPrompt() returned the whole prompt as one string.
  if (!m.promptParts) return { system: m.systemPrompt(...args), turn: '', tools: await tools(dir, s.role) };
  const parts = m.promptParts(...args);
  return { system: text(parts.system), turn: text(parts.turn), tools: await tools(dir, s.role) };
}

if (import.meta.main) {
  const [dir, spec] = process.argv.slice(2);
  render(dir, JSON.parse(spec)).then((r) => process.stdout.write(JSON.stringify(r)), (e) => { console.error(String(e?.stack ?? e)); process.exit(1); });
}
