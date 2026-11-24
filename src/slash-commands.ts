// The slash commands a chat's turns load, with one line on each, for the composer's menu and its check of what it
// sends (#937). The names come from Claude Code's own init event (runner.ts saveCommands), so the list is exactly
// what a turn runs: the kit's skills, the scheme repo's own, picked plugins', Claude Code's built-ins. Citadel's own
// commands (/btw, /fresh, /help) are the front end's (public/slash-commands.js) and never reach a turn.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, Ticket } from './db.ts';
import { commandsKey, schemeCommandsKey, type LoadedCommands } from './runner.ts';

/** One line on Claude Code's built-ins and bundled skills that have no file to read it from. */
const BUILT_IN: Record<string, string> = {
  compact: "Compact the session's context to free up room, keeping a summary",
  context: 'Show what fills the context window',
  usage: "Show the plan's usage limits",
  clear: 'Clear the conversation and start a new Claude session',
  model: "Switch Claude's model for the session",
  effort: 'Set the reasoning effort for the session',
  fast: 'Toggle fast mode',
  mcp: 'List the MCP servers and their status',
  agents: 'List the subagents',
  recap: 'Recap the session so far',
  'claude-api': 'Claude API and Anthropic SDK reference',
  dataviz: 'Charts, graphs and data visualizations',
  'plugin-authoring': "Make a mod: a change to Claude's own interface or behaviour",
  'code-review': "Review the branch's changes",
  'security-review': "Security review of the branch's changes",
  init: 'Write a CLAUDE.md for the repo',
  loop: 'Run a prompt again on an interval',
};

const SAFE = /^[\w.-]+$/;
const DESCRIPTION_MAX = 140;

/** A skill or command file's `description:`, cut to its first sentence. */
export function describe(text: string): string {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (!front) return '';
  const lines = front.split(/\r?\n/);
  const at = lines.findIndex((l) => /^description:/.test(l));
  if (at < 0) return '';
  let value = lines[at].replace(/^description:\s*/, '');
  // A folded or literal block (`description: >`): its indented lines.
  if (/^[>|][-+]?\s*$/.test(value)) {
    const block: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(l)) break;
      block.push(l.trim());
    }
    value = block.join(' ');
  }
  value = value
    .trim()
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .replace(/\s+/g, ' ');
  const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(value)?.[0] ?? value;
  return sentence.length > DESCRIPTION_MAX ? `${sentence.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : sentence;
}

// Read once per file version: the menu asks on every chat it opens.
const cache = new Map<string, { mtime: number; description: string }>();
function fileDescription(path: string): string | null {
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit?.mtime === mtime) return hit.description;
  let description = '';
  try {
    description = describe(readFileSync(path, 'utf8'));
  } catch {
    // Unreadable: no line.
  }
  cache.set(path, { mtime, description });
  return description;
}

/** Where a loaded command's file would be: a plugin's skill or command for `plugin:name`, the repo's own for `name`. */
function candidates(name: string, loaded: LoadedCommands): string[] {
  const [plugin, skill] = name.includes(':') ? name.split(':', 2) : [null, name];
  if (!SAFE.test(skill) || (plugin !== null && !SAFE.test(plugin))) return [];
  const roots = plugin !== null ? loaded.plugins.filter((p) => p.name === plugin).map((p) => p.path) : loaded.cwd ? [join(loaded.cwd, '.claude')] : [];
  return roots.flatMap((root) => [join(root, 'skills', skill, 'SKILL.md'), join(root, 'commands', `${skill}.md`)]);
}

export interface CommandInfo {
  name: string;
  description: string;
}

/**
 * The commands a chat's turns load, each with its line: its own last turn's list, else the scheme's newest (a chat
 * with no turn yet). `loaded` is false when no turn in the scheme has said, so the composer refuses nothing.
 */
export function chatCommands(store: Store, ticket: Ticket): { loaded: boolean; commands: CommandInfo[] } {
  const loaded = store.getSetting<LoadedCommands>(commandsKey(ticket.id)) ?? store.getSetting<LoadedCommands>(schemeCommandsKey(ticket.project_id));
  if (!loaded?.names?.length) return { loaded: false, commands: [] };
  const commands = loaded.names.map((name) => {
    let description = BUILT_IN[name] ?? '';
    for (const path of description ? [] : candidates(name, loaded)) {
      const found = fileDescription(path);
      if (found !== null) {
        description = found;
        break;
      }
    }
    return { name, description };
  });
  return { loaded: true, commands };
}
