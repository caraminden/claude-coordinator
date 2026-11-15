// Citadel's tripwire for Codex (#330, #337): the managed PreToolUse hook in /etc/codex/requirements.toml of
// every person's container. Codex skips a hook that crashes, times out or answers "ask", so this one
// fails closed: anything but a clean pass exits 2, which is the only answer Codex treats as a block.
//
// The command in requirements.toml stays static (Codex un-trusts an edited one); the turn's tripwire
// config comes from the JSON file $CITADEL_CODEX_TRIPWIRE names, written by the runner for every turn:
// { script: <the turn's pinned src/tripwire.ts>, config: <its TripwireConfig>, mode?, mcp?, rules? }.
// - mode "review" (also when missing or unknown): Citadel's read-only reviewer (src/codex-review.ts), shell only.
// - mode "turn": a minion or Taskmaster turn on Codex (src/codex-turn.ts): shell, apply_patch and the
//   turn's own MCP servers (`mcp`).
// - mode "contraption": an app's turn: only its own MCP servers (web search, when on, runs at OpenAI and fires no hook).
// - mode "image": an --image-gen run of citadel-codex-review (#738): image_gen only, its reference images checked as reads.
// The tripwire's ask tier and the scheme's approval rules (`rules`) need a person's card, which Codex
// turns can't show (not in this build), so both are plain blocks.
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function deny(why) {
  process.stderr.write(`[tripwire] ${why}\n`);
  process.exit(2);
}

const NO_CARDS = 'Codex turns cannot show an Approve / Deny card, so it is blocked. If the work needs it, ask the people on the minion with ask_question, or say what you needed it for and stop.';

/** Every path an apply_patch envelope touches, or null when it isn't one this parser understands. */
export function patchPaths(patch) {
  if (typeof patch !== 'string') return null;
  const lines = patch.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch' || lines.at(-1)?.trim() !== '*** End Patch') return null;
  const paths = [];
  for (const l of lines.slice(1, -1)) {
    const m = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(l);
    if (m) paths.push(m[2].trim());
    else if (l.startsWith('*** ') && l.trim() !== '*** End of File') return null;
  }
  return paths.length ? paths : null;
}

const glob = (pattern) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** The approval rule (a Claude Code permission rule) this call matches, or null. Matches wide on purpose: a miss runs a call a person meant to approve. */
export function ruleHit(rules, tool, ti) {
  for (const rule of rules ?? []) {
    const m = /^([^(]+)(?:\((.*)\))?$/s.exec(rule);
    if (!m) return rule;
    const [, name, spec] = m;
    if (tool === 'Bash' && name === 'Bash') {
      if (spec === undefined) return rule;
      const prefix = spec.replace(/:\*$/, '').replace(/\s+/g, ' ').trim();
      if (String(ti?.command ?? '').replace(/\s+/g, ' ').includes(prefix)) return rule;
    } else if (tool === 'apply_patch' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
      // shortcut: any edit rule blocks every patch, path-scoped or not; match its paths if a scheme with one wants Codex edits.
      return rule;
    } else if (tool.startsWith('mcp__') && name.startsWith('mcp__')) {
      if (glob(name).test(tool) || glob(`${name}__*`).test(tool)) return rule;
    }
  }
  return null;
}

async function check(input, cfgFile) {
  const { script, config, mode: rawMode, mcp, rules } = cfgFile;
  const mode = ['turn', 'contraption', 'image'].includes(rawMode) ? rawMode : 'review';
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' ? input.cwd : null;
  const { tripwire, commandReason } = await import(script);
  const stop = (v) => {
    if (v?.ask) deny(`${v.reason}\n[tripwire] ${NO_CARDS}`);
    if (v) deny(`${v.reason}\n[tripwire] This guard stops known accidents in Citadel (src/tripwire.ts). If a person really wants this, they can run it themselves.`);
  };
  const at = (p) => (isAbsolute(p) ? p : cwd ? resolve(cwd, p) : deny(`${p} is relative but the call has no working directory, so the tripwire cannot check it.`));
  const rule = (name) => {
    const r = ruleHit(rules, name, ti);
    if (r) deny(`This call matches the scheme's approval rule ${r}, which waits for a person. ${NO_CARDS}`);
  };
  const servers = new Set(Array.isArray(mcp) ? mcp : []);
  const mcpServer = /^mcp__(.+?)__/.exec(tool)?.[1];
  if (mode === 'review') {
    if (tool !== 'Bash') deny(`${tool || 'This tool'} is off: Citadel's Codex reviewer is read-only and runs shell commands only.`);
    return stop(tripwire(input, { ...config, ask: false }));
  }
  if (mode === 'image') {
    if (tool !== 'image_gen') deny(`${tool || 'This tool'} is off: Citadel's Codex image run makes one picture with image_gen and nothing else.`);
    const refs = ti.referenced_image_paths ?? [];
    if (!Array.isArray(refs)) deny('image_gen\'s referenced_image_paths is not a list, so the tripwire cannot check what it reads.');
    for (const p of refs) stop(tripwire({ tool_name: 'Read', tool_input: { file_path: at(String(p)) }, cwd }, { ...config, ask: false }));
    return;
  }
  if (mcpServer && servers.has(mcpServer)) return rule(tool);
  if (mode === 'contraption') {
    deny(`${tool || 'This tool'} is off: this app's turn runs only its own tools${servers.size ? ` (${[...servers].map((s) => `mcp__${s}`).join(', ')})` : ''}.`);
  }
  if (tool === 'Bash') {
    rule('Bash');
    // commandReason, not tripwire(): it keeps the ask tier visible, which tripwire() turns into a retry-with-a-description hint.
    if (typeof ti.command !== 'string') deny('This shell call has no command.');
    return stop(commandReason(ti.command, { cwd, vars: new Set(), values: new Map() }, { ...config, ask: true }));
  }
  if (tool === 'apply_patch') {
    rule('apply_patch');
    const paths = patchPaths(ti.command ?? ti.patch ?? ti.input);
    if (!paths) deny('This patch could not be read (it needs *** Begin Patch, one or more *** Add/Update/Delete File: lines and *** End Patch), so the tripwire cannot check where it writes.');
    for (const p of paths) stop(tripwire({ tool_name: 'Write', tool_input: { file_path: at(p) }, cwd }, { ...config, ask: false }));
    return;
  }
  if (tool === 'view_image') return stop(tripwire({ tool_name: 'Read', tool_input: { file_path: at(String(ti.path ?? '')) }, cwd }, { ...config, ask: false }));
  if (mcpServer) deny(`${tool} is not one of this turn's tools (${[...servers].map((s) => `mcp__${s}`).join(', ') || 'none'}).`);
  // Collaboration (spawn_agent: Grunts), goals and the rest stay off: only the tools above are checked.
  deny(`${tool || 'This tool'} is off in Citadel's Codex turns: use the shell, apply_patch and this turn's MCP tools.`);
}

// Run as the hook; imported (by its tests), it only exports the parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const file = process.env.CITADEL_CODEX_TRIPWIRE;
    if (!file) deny('Codex runs in a Citadel container only through Citadel (citadel-codex-review or a Codex turn), which brings the tripwire config (CITADEL_CODEX_TRIPWIRE is not set).');
    await check(input, JSON.parse(readFileSync(file, 'utf8')));
    process.exit(0);
  } catch (err) {
    deny(`The hook failed, so the call is blocked: ${err?.message ?? err}`);
  }
}
