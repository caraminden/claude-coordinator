// The plugin folders in a scheme's repo, for the Minion rules page's plugin picker (#1041): folders holding
// .claude-plugin/plugin.json. The kit's own (kit/) loads in every turn already, so it isn't offered.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FoundPlugin { dir: string; name: string; description: string }

const SKIP = new Set(['.git', 'node_modules', 'kit']);
const MAX_DEPTH = 4;
const MAX_FOUND = 100;

/** Folders under `root`, as repo-relative paths, that hold .claude-plugin/plugin.json; their name and description from it. */
export async function findPlugins(root: string): Promise<FoundPlugin[]> {
  const found: FoundPlugin[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (found.length >= MAX_FOUND) return;
    const abs = rel ? join(root, rel) : root;
    const manifest = await readFile(join(abs, '.claude-plugin', 'plugin.json'), 'utf8').catch(() => null);
    if (manifest !== null && rel) {
      let m: any = {};
      try { m = JSON.parse(manifest) ?? {}; } catch { /* a broken manifest still lists, by its folder name */ }
      found.push({ dir: rel, name: typeof m.name === 'string' && m.name ? m.name : rel.split('/').pop()!, description: typeof m.description === 'string' ? m.description : '' });
      return; // a plugin's own folders aren't plugins
    }
    if (depth >= MAX_DEPTH) return;
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk('', 0);
  return found;
}
