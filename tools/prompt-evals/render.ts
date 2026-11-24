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
  type?: string | null; // the case's ticket type: a feature's first turn opens with the done-lines rule (#1574)
  appText: string; // the Citadel-wide instructions
  schemeText: string; // the scheme's own
  dirs: { files: string; shared: string; tickets: string; cwd: string };
  // Ablation (#1277): prompt parts to empty, entries to remove (each entry containing the text; an instructions block is one entry), tools cut to their first sentence.
  drop?: { parts?: string[]; lines?: string[]; tools?: string[] };
};

/** Takes `drop` out of a rendering. A part, line or tool that matches nothing throws: a stale drop would test nothing. */
export function ablate(parts: Record<'system' | 'turn', Record<string, string[]>>, tools: { name: string; description?: string }[], drop: NonNullable<Spec['drop']>) {
  const keys = Object.keys(drop ?? {});
  if (
    !drop ||
    typeof drop !== 'object' ||
    !keys.length ||
    keys.some((k) => !['parts', 'lines', 'tools'].includes(k)) ||
    keys.some((k) => {
      const v = (drop as Record<string, unknown>)[k];
      return !Array.isArray(v) || !v.length || v.some((x: unknown) => typeof x !== 'string' || !x);
    })
  )
    throw new Error('drop: want {"parts"?, "lines"?, "tools"?}, each a non-empty list of non-empty strings');
  const all = { ...parts.system, ...parts.turn };
  for (const k of drop.parts ?? []) {
    if (!all[k]?.length) throw new Error(`drop: no prompt part "${k}" with text`);
    for (const side of [parts.system, parts.turn]) if (side[k]) side[k] = [];
  }
  for (const needle of drop.lines ?? []) {
    let hit = 0;
    for (const side of [parts.system, parts.turn]) for (const k of Object.keys(side)) side[k] = side[k].filter((l) => !(l.includes(needle) && ++hit));
    if (!hit) throw new Error(`drop: no prompt line contains "${needle}"`);
  }
  for (const name of drop.tools ?? []) {
    const t = tools.find((x) => x.name === name);
    if (!t?.description) throw new Error(`drop: no tool "${name}" with a description`);
    const cut = t.description.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? t.description;
    if (cut === t.description) throw new Error(`drop: tool "${name}" is one sentence already; nothing to cut`);
    t.description = cut;
  }
}

// The Citadel scheme's settings as they were on 2026-11-19 (projects row 2); instructions come from the spec.
const PROJECT = {
  id: 2,
  name: 'Citadel',
  repo_url: null,
  ship_path: 'citadel',
  go_from: 'high',
  try_first: 'never',
  fable_ok: 'on',
  grill: 'design',
  gh_runners: 'ask',
  shot_widths: '1440,390',
  shot_themes: 'light',
  shots_required: 1,
  shot_note: '',
  skills_off: '',
  approval_rules: '',
};

function tools(dir: string, role: Spec['role']): Promise<object[]> {
  // An unreachable API and no token: listing tools calls nothing, and a stray call can't reach the live app.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    COORDINATOR_API: 'http://127.0.0.1:9',
    COORDINATOR_TOKEN: '',
    COORDINATOR_ROLE: role === 'taskmaster' ? 'coordinator' : 'thread',
    COORDINATOR_PROJECT: '2',
    COORDINATOR_TICKET: '0',
    COORDINATOR_DEPLOYS: '1',
    COORDINATOR_APPROVALS: role === 'minion' ? '1' : '',
    COORDINATOR_CONTAINER: '1',
    COORDINATOR_APP_INSTRUCTIONS: role === 'taskmaster' ? '1' : '',
  };
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [join(dir, 'src/mcp.ts')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const t = setTimeout(() => {
      p.kill();
      fail(new Error('mcp.ts gave no tool list in 20 s'));
    }, 20_000);
    p.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n').slice(0, -1)) {
        if (!line.includes('"id":2')) continue;
        clearTimeout(t);
        p.kill();
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
  const ticket = {
    id: 900_000 + s.number,
    project_id: 2,
    number: s.role === 'taskmaster' ? null : s.number,
    title: s.title,
    type: s.type ?? null,
    kind: s.role === 'taskmaster' ? 'coordinator' : 'ticket',
    status: 'idle',
    cwd: s.dirs.cwd,
    branch: `ticket/${s.number}-replay`,
    permission_mode: 'bypassPermissions',
    model: null,
    effort: null,
    workflow: 0,
    build: null,
    plugin_dirs: '',
    coordinator_of: null,
    created_by: 'replay',
  };
  const args = [project, ticket, s.dirs.files, s.dirs.shared, s.dirs.tickets, null, [], true, s.appText];
  const text = (p: Record<string, string[]>) => Object.values(p).flat().join('\n');
  // Before the turn note split off (#878), systemPrompt() returned the whole prompt as one string.
  if (!m.promptParts) {
    if (s.drop) throw new Error('drop needs a version with promptParts (#878 or later)');
    return { system: m.systemPrompt(...args), turn: '', tools: await tools(dir, s.role) };
  }
  const parts = m.promptParts(...args),
    list = (await tools(dir, s.role)) as { name: string; description?: string }[];
  if (s.drop) ablate(parts, list, s.drop);
  return { system: text(parts.system), turn: text(parts.turn), tools: list };
}

if (import.meta.main) {
  const [dir, spec] = process.argv.slice(2);
  render(dir, JSON.parse(spec)).then(
    (r) => process.stdout.write(JSON.stringify(r)),
    (e) => {
      console.error(String(e?.stack ?? e));
      process.exit(1);
    },
  );
}
