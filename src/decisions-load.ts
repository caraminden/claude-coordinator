// The Decisions page's sources for one scheme (#1064): reads every place a decision is written, live, and hands the
// texts to src/decisions.ts. Also the held note to the scheme's Taskmaster when a new reversal leaves copies behind
// (Josh, 2026-11-19, picked "Tell the Taskmaster").
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { adrDir, assemble, gitEdits, githubHref, memTitle, type Doc, type DecisionList, type Edit, type SourceKind } from './decisions.ts';
import { gitOut } from './git.ts';
import { memoryFolders, type MemoryLogin } from './memory-files.ts';
import { GLOBAL_OWNER } from './properties.ts';
import type { App } from './http.ts';
import type { Project } from './db.ts';

/** The server's own checkout, whose kit/ every scheme loads. */
const ROOT = join(import.meta.dirname, '..');
const HISTORY = 2000;

/** Every Claude login's config dir, labelled: the one list the Memory page and this page read memory folders from. */
export function memoryLogins(app: App): MemoryLogin[] {
  return app.store.listUsers().flatMap((u) => (u.server_login ? (app.claude.accounts(u.id)?.accounts ?? []).flatMap((a) => {
    const configDir = app.claude.configDir(u.id, a.n);
    return configDir ? [{ label: a.n === 1 ? "The server's own login" : `${u.name}'s account ${a.n}`, configDir }] : [];
  }) : []));
}

/** Markdown files under a folder of a repo, as repo-relative paths; none when it is missing. */
function mdFiles(repo: string, dir: string, depth = 6): string[] {
  if (depth < 0) return [];
  let names: string[];
  try { names = readdirSync(join(repo, dir)); } catch { return []; }
  return names.sort().flatMap((n) => {
    const rel = dir ? `${dir}/${n}` : n;
    let st;
    try { st = statSync(join(repo, rel)); } catch { return []; }
    return st.isDirectory() ? mdFiles(repo, rel, depth - 1) : /\.md$/i.test(n) ? [rel] : [];
  });
}
const read = (path: string): string => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

/** A repo's files as Docs, with their git history and links to GitHub when the repo is there. */
async function repoDocs(repo: string, repoUrl: string | null, groups: { kind: SourceKind; files: string[]; paths: string[]; adr?: (f: string) => boolean }[]): Promise<Doc[]> {
  const branch = (await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], repo))?.trim() || 'main';
  const edits = await gitEdits(repo, groups.flatMap((g) => g.paths), (file, sha) => githubHref(repoUrl, sha, file));
  return groups.flatMap((g) => g.files.map((file) => ({
    kind: g.kind,
    place: { label: file, file, href: githubHref(repoUrl, branch, file) },
    text: read(join(repo, file)),
    adr: g.adr?.(file),
    edits: edits.get(file),
  })));
}

/** Instruction history rows (newest first, as the store keeps them) as edits in order. */
const historyEdits = (rows: { by: string; at: number; old_text: string; new_text: string }[], href: string): Edit[] =>
  rows.slice().reverse().map((r) => ({ before: r.old_text ?? '', after: r.new_text ?? '', at: r.at, by: r.by, href }));

const cache = new Map<number, { hash: string; list: DecisionList }>();

/** Every decision this scheme can see: its own sources and the Citadel-wide ones, with reversals across them. */
export async function loadDecisions(app: App, project: Project): Promise<DecisionList> {
  const { store } = app;
  const pid = project.id;
  const names = store.listUsers().map((u) => u.name);
  const app_ = store.appInstructions();
  const docs: Doc[] = [
    { kind: 'citadel', place: { label: 'Citadel-wide instructions', href: `#/p/${pid}/app-instructions` }, text: app_.text, edits: historyEdits(store.appInstructionHistory(HISTORY), `#/p/${pid}/app-instructions`) },
    { kind: 'scheme', place: { label: 'Scheme instructions', href: `#/p/${pid}/instructions` }, text: project.instructions ?? '', edits: historyEdits(store.instructionHistory(pid, HISTORY), `#/p/${pid}/instructions`) },
  ];
  const repo = project.repo_dir && existsSync(project.repo_dir) ? project.repo_dir : null;
  if (repo) {
    const adr = adrDir(read(join(repo, 'CLAUDE.md')));
    const rules = ['CLAUDE.md', 'AGENTS.md'].filter((f) => existsSync(join(repo, f))).concat(mdFiles(repo, '.claude/rules'));
    // A README in the ADR folder is its index, not a decision.
    const adrs = mdFiles(repo, adr.replace(/\/$/, ''), 0).filter((f) => !/readme|template/i.test(f));
    docs.push(...await repoDocs(repo, project.repo_url, [
      { kind: 'repo', files: rules, paths: ['CLAUDE.md', 'AGENTS.md', '.claude/rules'] },
      { kind: 'adr', files: adrs, paths: [adr], adr: () => true },
    ]));
  }
  const citadelUrl = store.getProject(GLOBAL_OWNER)?.repo_url ?? null;
  docs.push(...await repoDocs(ROOT, citadelUrl, [{ kind: 'kit', files: mdFiles(ROOT, 'kit'), paths: ['kit'] }]));
  const seen = new Set<string>();
  for (const f of memoryFolders(project.repo_dir, memoryLogins(app))) {
    let files: string[] = [];
    try { files = readdirSync(f.dir).filter((n) => /\.md$/.test(n) && n !== 'MEMORY.md').sort(); } catch { continue; }
    for (const file of files) {
      const text = read(join(f.dir, file));
      // Two logins can hold the same note; list it once.
      const key = `${file}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      docs.push({ kind: 'memory', place: { label: f.label, file, href: `#/p/${pid}/memory` }, text, title: memTitle(text) });
    }
  }
  const staleKinds: SourceKind[] = ['scheme', 'repo', 'memory', ...(pid === GLOBAL_OWNER ? ['kit', 'citadel'] as SourceKind[] : [])];
  const h = createHash('sha1');
  for (const d of names) h.update(d + '\0');
  for (const d of docs) h.update(`${d.kind}|${d.place.file ?? d.place.label}|${d.text}|${d.edits?.length ?? 0}|${d.edits?.at(-1)?.at ?? 0}\0`);
  const hash = h.digest('hex');
  const hit = cache.get(pid);
  if (hit?.hash === hash) return hit.list;
  const list = assemble(docs, names, staleKinds);
  cache.set(pid, { hash, list });
  tellStale(app, project, list);
  return list;
}

/**
 * Leave the scheme's Taskmaster a held note for each new reversal that still has copies written in this scheme.
 * The first look at a scheme only records what is there, so turning this on does not mail every old reversal.
 */
export function tellStale(app: App, project: Project, list: DecisionList) {
  const key = `decisions_told:${project.id}`;
  const told = app.store.getSetting<string[]>(key);
  const now = list.decisions.filter((d) => d.reversed?.stale.length);
  const ids = now.map((d) => d.id);
  if (!told) return void app.store.setSetting(key, ids);
  const fresh = now.filter((d) => !told.includes(d.id));
  if (!fresh.length) return;
  app.store.setSetting(key, [...new Set([...told, ...ids])].slice(-500));
  const tm = app.store.getOverlord(project.id);
  if (!tm) return;
  const lines = fresh.map((d) => {
    const by = list.decisions.find((x) => x.id === d.reversed!.by);
    const now = by ? `${by.rule}${by.quote ? `: "${by.quote}"` : ''} (${by.who}, ${by.date})` : d.reversed!.byText;
    const where = d.reversed!.stale.map((p) => `${p.label}${p.file && p.file !== p.label ? ` ${p.file}` : ''}${p.line ? `:${p.line}` : ''}`).join(', ');
    return `- ${d.rule}${d.quote ? `: "${d.quote}"` : ''} (${d.who}, ${d.date}) was reversed by ${now}. Still written in: ${where}.`;
  });
  app.runner.leaveMail(tm.id, 'Decisions', `(nothing to do unless you choose to) A newer decision reversed ${fresh.length === 1 ? 'one' : fresh.length} that ${fresh.length === 1 ? 'is' : 'are'} still written elsewhere in this scheme. Offer the members a card to clean up the old copies, or start a chore minion for it; the Decisions page (Scheme → Decisions) has a Clean up button too.\n${lines.join('\n')}`);
}

/** After an instructions save: re-read in the background, so a reversal it made reaches the Taskmaster. */
export function recheckDecisions(app: App, projects: Project[]) {
  for (const p of projects) void loadDecisions(app, p).catch(() => {});
}
