// The catalogue a Taskmaster setting up a scheme picks from (#172): every scheme's repo skills, agents
// and rules, and the kit's, as names and one-line descriptions. Read server-side, so the Taskmaster's
// own file access stays inside its scheme, and never the files themselves.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './db.ts';

export interface CatalogueItem {
  name: string;
  kind: 'skill' | 'agent' | 'rule';
  /** 'kit', or "<scheme>: <path in its repo>". */
  source: string;
  description: string;
  /** Whether the kit has an item of the same kind and name. */
  in_kit: boolean;
}

const MAX_DESCRIPTION = 200;

/** Where each kind lives under a `.claude/` (or the kit's root): [kind, folder, file name, or null for *.md]. */
const KINDS = [
  ['skill', 'skills', 'SKILL.md'],
  ['agent', 'agents', null],
  ['rule', 'rules', null],
] as const;

/**
 * The frontmatter's scalar fields and string lists, as much as a SKILL.md or agent header uses:
 * `key: value`, quoted values, folded `>` / `|` blocks and `- item` lists.
 */
export function frontmatter(text: string): Record<string, string | string[]> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string | string[]> = {};
  if (!m) return out;
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (field) {
      key = field[1];
      const v = field[2].trim();
      out[key] = /^[>|][+-]?$/.test(v) || v === '' ? '' : v.replace(/^(["'])(.*)\1$/, '$2');
      continue;
    }
    if (!key || !/^\s/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    const prev = out[key];
    if (item && (Array.isArray(prev) || prev === '')) out[key] = [...(Array.isArray(prev) ? prev : []), item[1].trim().replace(/^(["'])(.*)\1$/, '$2')];
    else if (typeof prev === 'string') out[key] = `${prev} ${line.trim()}`.trim();
  }
  return out;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

/** One item's description: its frontmatter's, or for a rule (which has none) its first heading and the paths it loads for. */
function describe(text: string, kind: CatalogueItem['kind']): string {
  const fm = frontmatter(text);
  if (typeof fm.description === 'string' && fm.description) return oneLine(fm.description);
  if (kind !== 'rule') return '';
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const heading = /^#{1,6}\s+(.+)$/m.exec(body)?.[1] ?? '';
  const paths = Array.isArray(fm.paths) ? `for ${fm.paths.join(', ')}` : '';
  return oneLine([heading, paths].filter(Boolean).join(' · '));
}

type Found = Pick<CatalogueItem, 'name' | 'kind' | 'description'> & { path: string };

/** The items under one root (a repo's `.claude/`, or the kit), with paths relative to `prefix`. */
function itemsIn(root: string, prefix: string): Found[] {
  const out: Found[] = [];
  for (const [kind, folder, file] of KINDS) {
    let entries;
    try {
      entries = readdirSync(join(root, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = file ? (e.isDirectory() ? join(folder, e.name, file) : null) : e.isFile() && e.name.endsWith('.md') ? join(folder, e.name) : null;
      if (!rel) continue;
      let text;
      try {
        text = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      const fm = frontmatter(text);
      const name = typeof fm.name === 'string' && fm.name ? fm.name : file ? e.name : e.name.replace(/\.md$/, '');
      out.push({ name, kind, description: describe(text, kind), path: join(prefix, rel) });
    }
  }
  return out;
}

/** The whole catalogue: the kit first, then each scheme with a repo, by name. */
export function catalogue(projects: Pick<Project, 'name' | 'repo_dir'>[], kitDir: string): CatalogueItem[] {
  const kit = itemsIn(kitDir, '');
  const inKit = new Set(kit.map((i) => `${i.kind}:${i.name}`));
  const item = (i: Found, source: string): CatalogueItem => ({ name: i.name, kind: i.kind, source, description: i.description, in_kit: inKit.has(`${i.kind}:${i.name}`) });
  return [
    ...kit.map((i) => item(i, 'kit')),
    ...projects
      .filter((p) => p.repo_dir)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((p) => itemsIn(join(p.repo_dir!, '.claude'), '.claude').map((i) => item(i, `${p.name}: ${i.path}`))),
  ];
}
