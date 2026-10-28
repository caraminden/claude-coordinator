// Where project instructions can be imported from: the instruction and memory files of the Claude
// Code login this app runs as. Only these known locations are read, never a path from the request.
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Project } from './db.ts';
import { projectSlug } from './sessions.ts';

/** Larger files are cut short; instructions themselves are capped well below this. */
const MAX_SOURCE_CHARS = 64_000;

export interface InstructionSource {
  /** Stable within one listing, for the browser to keep track of picks. */
  id: string;
  group: 'Your Claude Code' | 'This project' | 'Other Claude Code projects';
  label: string;
  /** Where it lives, with the home directory shortened to ~. */
  path: string;
  /** Why this one may already reach threads, when it does. */
  note: string | null;
  content: string;
  truncated: boolean;
}

function tilde(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}

async function read(path: string): Promise<{ content: string; truncated: boolean } | null> {
  try {
    const text = await readFile(path, 'utf8');
    if (!text.trim()) return null;
    return text.length > MAX_SOURCE_CHARS ? { content: text.slice(0, MAX_SOURCE_CHARS), truncated: true } : { content: text, truncated: false };
  } catch {
    return null;
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      // The index first, then the notes it points to.
      .sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)));
  } catch {
    return [];
  }
}

/** Claude Code names a project's folder after its path with every non-alphanumeric turned to "-"; undo that roughly for a label. */
function slugLabel(slug: string): string {
  const home = projectSlug(homedir());
  return slug.startsWith(home) ? '~' + slug.slice(home.length).replace(/-/g, '/') : slug.replace(/-/g, '/');
}

/** Every instruction and memory file this app's Claude Code login has, for the import picker. */
export async function instructionSources(project: Project, configDir: string, dataDir: string): Promise<InstructionSource[]> {
  const out: InstructionSource[] = [];
  const add = async (group: InstructionSource['group'], label: string, path: string, note: string | null = null) => {
    const file = await read(path);
    if (file) out.push({ id: String(out.length), group, label, path: tilde(path), note, ...file });
  };

  await add('Your Claude Code', 'Your instructions (CLAUDE.md)', join(configDir, 'CLAUDE.md'), 'Minions on this machine already read this, since they run as this login.');
  for (const name of await markdownFiles(join(configDir, 'rules'))) {
    await add('Your Claude Code', `Rule: ${name}`, join(configDir, 'rules', name), 'Minions on this machine already read this, since they run as this login.');
  }

  const memorySlug = project.repo_dir ? projectSlug(project.repo_dir) : null;
  if (project.repo_dir) {
    for (const name of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      await add('This project', `Repo ${name}`, join(project.repo_dir, name), 'Every minion already reads this from its own worktree; the Taskmaster does not.');
    }
    const dir = join(configDir, 'projects', memorySlug!, 'memory');
    for (const name of await markdownFiles(dir)) {
      await add('This project', `Memory: ${name}`, join(dir, name), 'Minions already load this auto-memory; the Taskmaster does not.');
    }
  }

  // Memory Claude Code kept for other folders, such as a checkout you work in by hand. The app's own
  // ticket and coordinator folders are skipped: their memory is per thread and rarely worth importing.
  const dataSlug = projectSlug(dataDir);
  let slugs: string[] = [];
  try {
    slugs = (await readdir(join(configDir, 'projects'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    // No projects folder yet.
  }
  for (const slug of slugs) {
    if (slug === memorySlug || slug.startsWith(dataSlug) || slug.startsWith('-tmp')) continue;
    const dir = join(configDir, 'projects', slug, 'memory');
    for (const name of await markdownFiles(dir)) {
      await add('Other Claude Code projects', `${slugLabel(slug)}: ${name}`, join(dir, name));
    }
  }
  return out;
}
