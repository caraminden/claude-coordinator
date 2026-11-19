// How a scheme's repo is set up, read from its files when asked for (never copied): the Project facts block in
// CLAUDE.md, the rule files in .claude/rules/ and the repo's own skills. Read-only.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Fact { label: string; value: string }

/** The `- **Label:** value` bullets under `## Project facts`, continuation lines folded into their bullet. Null with no such block. */
export function parseProjectFacts(md: string): Fact[] | null {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^##\s+Project facts\s*$/i.test(l));
  if (start < 0) return null;
  const facts: Fact[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const bullet = /^[-*]\s+\*\*(.+?):?\*\*:?\s*(.*)$/.exec(line);
    if (bullet) facts.push({ label: bullet[1].replace(/:$/, ''), value: bullet[2] });
    else if (facts.length && /^\s+\S/.test(line)) facts[facts.length - 1].value += ' ' + line.trim();
  }
  return facts;
}

export interface RuleFile { name: string; size: number; paths: string[]; upstream: string | null }

/** The `paths:` globs of a rule file's front matter (a list or one line) and the first link after "From" in its body. */
export function parseRule(name: string, text: string): RuleFile {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const paths: string[] = [];
  const m = /^paths:[ \t]*(.*)$/m.exec(fm);
  if (m) {
    if (m[1].trim()) paths.push(...m[1].replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
    else for (const l of fm.slice(m.index + m[0].length).split('\n')) { const i = /^\s*-\s*(.+)$/.exec(l); if (!i) { if (l.trim()) break; continue; } paths.push(i[1].trim().replace(/^["']|["']$/g, '')); }
  }
  const upstream = /^From \[[^\]]+\]\((https:\/\/[^)\s]+)\)/m.exec(text)?.[1] ?? null;
  return { name, size: text.length, paths, upstream };
}

/** The pin for a copied path, from a THIRD_PARTY.md table row that names it (the "Pinned commit" column). */
export function pinFor(thirdParty: string, path: string): string | null {
  for (const row of thirdParty.split('\n')) {
    if (!row.startsWith('|') || !row.includes('`' + path)) continue;
    const pin = /\|\s*`([0-9a-f]{7,40})`\s*\|/.exec(row);
    if (pin) return pin[1];
  }
  return null;
}

export interface RepoSetup { facts: Fact[] | null; rules: (RuleFile & { pin: string | null })[]; skills: { name: string; description: string }[] }

const read = (p: string) => readFile(p, 'utf8').catch(() => null);
const ls = (p: string) => readdir(p).catch(() => [] as string[]);

export async function repoSetup(repoDir: string): Promise<RepoSetup> {
  const claude = await read(join(repoDir, 'CLAUDE.md'));
  const thirdParty = (await read(join(repoDir, 'THIRD_PARTY.md'))) ?? (await read(join(repoDir, 'kit', 'skills', 'THIRD_PARTY.md'))) ?? '';
  const rules = [];
  for (const f of (await ls(join(repoDir, '.claude', 'rules'))).filter((f) => f.endsWith('.md')).sort()) {
    const text = await read(join(repoDir, '.claude', 'rules', f));
    if (text !== null) rules.push({ ...parseRule(f, text), pin: pinFor(thirdParty, `.claude/rules/${f}`) });
  }
  const skills = [];
  for (const d of (await ls(join(repoDir, '.claude', 'skills'))).sort()) {
    const text = await read(join(repoDir, '.claude', 'skills', d, 'SKILL.md'));
    if (text === null || !(await stat(join(repoDir, '.claude', 'skills', d)).catch(() => null))) continue;
    skills.push({ name: d, description: /^description:\s*(.+)$/m.exec(text)?.[1].replace(/^["']|["']$/g, '').slice(0, 300) ?? '' });
  }
  return { facts: claude === null ? null : parseProjectFacts(claude), rules, skills };
}
