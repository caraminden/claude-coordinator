// Release targets, found (#627; Josh, 2026-11-13: "it should add new schemes as they are created once they have
// anything resembling a "release" or build, or preview site"). Nobody declares a target: each scheme's targets are
// read from what it already has, its contraptions and its repo's workflow files on the default branch (read from the
// scheme's clone, so finding costs no GitHub call). A scheme's citadel-app.json may carry `targets` to rename, hide
// or relink a found one: [{ "id": "main", "hidden": true }]. src/release-readers.ts reads each kind's releases.
import { existsSync } from 'node:fs';
import type { ContraptionRow, Project, Store } from './db.ts';
import { repoSlug } from './prlinks.ts';
import { git, type Target } from './releases.ts';

/** contraption: an app at /apps/<name>/; apk: an Android app people install; ci: a package a workflow builds; main: the branch itself. */
export type Kind = 'contraption' | 'apk' | 'ci' | 'main';

export interface Found extends Target {
  kind: Kind;
  /** The scheme's default branch, which every target ships from. */
  branch: string;
  /** contraption, and an apk its app serves: the contraption's name. */
  contraption?: string;
  /** apk and ci: the workflow file (.github/workflows/x.yml) that builds it, and for ci the job. */
  workflow?: string;
  job?: string;
}

export interface Override {
  id: string;
  name?: string;
  hidden?: boolean;
  link?: string;
}

/** What detection reads of one scheme. */
export interface SchemeFacts {
  project: Pick<Project, 'id' | 'repo_url'>;
  /** The scheme whose code this server runs: its server is its target (CitadelServer), so it gets no Main. */
  own: boolean;
  branch: string;
  contraptions: Pick<ContraptionRow, 'name' | 'title'>[];
  /** Contraptions with an android/latest.json in their data folder: an APK they serve. */
  apkFeeds: string[];
  workflows: { path: string; text: string }[];
  overrides: Override[];
}

/** A top-level YAML key's block (`on:`, `jobs:`): its first line's rest, and the lines under it. */
function block(text: string, key: string): { inline: string; body: string } | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^["']?${key}["']?:`).test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^[^\s#]/.test(lines[j])) j++;
  return { inline: lines[i].replace(/^[^:]+:/, '').replace(/#.*/, '').trim(), body: lines.slice(i + 1, j).join('\n') };
}

/** The keys one level in (`  push:`, `  release:`), each with its lines; the level is the first key's indent, whatever its width. */
function children(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let key: string | null = null;
  let lines: string[] = [];
  const indent = /^( +)["']?[\w-]+["']?:/m.exec(body)?.[1].length ?? 2;
  const at = new RegExp(`^ {${indent}}["']?([\\w-]+)["']?:`);
  for (const l of body.split('\n')) {
    const m = at.exec(l);
    if (m) {
      if (key) out.set(key, lines.join('\n'));
      key = m[1];
      lines = [l.slice(m[0].length)];
    } else if (key) lines.push(l);
  }
  if (key) out.set(key, lines.join('\n'));
  return out;
}

/** Whether a workflow runs on its own once work reaches `branch` (a push there, a tag, a published release), or only by hand. */
export function shipsOn(text: string, branch: string): 'push' | 'dispatch' | null {
  const on = block(text, 'on');
  if (!on) return null;
  const events = on.inline ? new Map(on.inline.replace(/[[\]]/g, '').split(',').map((e) => [e.trim(), ''] as [string, string])) : children(on.body);
  if (events.has('release')) return 'push';
  const push = events.get('push');
  if (push != null) {
    const branches = /\bbranches:([^\n]*(?:\n\s+-[^\n]*)*)/.exec(push)?.[1];
    const ignored = /\bbranches-ignore:([^\n]*(?:\n\s+-[^\n]*)*)/.exec(push)?.[1];
    const names = (list: string) => new RegExp(`(^|[\\s'",[-])(${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|\\*\\*?)(?=$|[\\s'",\\]])`, 'm').test(list);
    // No branch filter (or only tags) runs on every push, the default branch's too.
    if (/\btags:/.test(push) || (branches != null ? names(branches) : ignored == null || !names(ignored))) return 'push';
  }
  return events.has('workflow_dispatch') ? 'dispatch' : null;
}

/** Each job of a workflow, by its id. */
export function jobsOf(text: string): Map<string, string> {
  const jobs = block(text, 'jobs');
  return jobs ? children(jobs.body) : new Map();
}

const PUBLISHES = /gh release (create|upload)|action-gh-release|actions\/create-release|actions\/upload-release-asset/;
const RELEASE_JOB = /release|package|dist|publish|bundle|installer/i;

/** A job that hands people something: it publishes a GitHub Release, or uploads an artifact from a release-like job. */
export function shipsPackage(id: string, job: string): boolean {
  if (PUBLISHES.test(job)) return true;
  if (!/actions\/upload-artifact/.test(job)) return false;
  const name = /^\s+name:\s*(.+)$/m.exec(job)?.[1] ?? '';
  return RELEASE_JOB.test(id) || RELEASE_JOB.test(name);
}

/** A platform's short name from a job's runs-on, its workflow's file name, or its name. */
export function platform(path: string, text: string, job: string): string {
  const said = `${/runs-on:([^\n]*(?:\n\s+-[^\n]*)*)/.exec(job)?.[1] ?? ''} ${path.replace(/^.*\//, '')} ${/^name:\s*(.+)$/m.exec(text)?.[1] ?? ''}`.toLowerCase();
  if (said.includes('windows')) return 'Windows';
  if (/macos|\bmac\b|osx/.test(said)) return 'macOS';
  if (/\bios\b/.test(said)) return 'iOS';
  if (/linux|ubuntu/.test(said)) return 'Linux';
  const name = (/^name:\s*["']?([^"'\n]+)/m.exec(text)?.[1] ?? path.replace(/^.*\//, '').replace(/\.ya?ml$/, '')).trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A scheme's targets, from what it has. */
export function detect(f: SchemeFacts): Found[] {
  const pid = f.project.id;
  const slug = repoSlug(f.project.repo_url);
  const out: Found[] = [];
  const base = { projectId: pid, branch: f.branch };
  for (const c of f.contraptions) {
    out.push({ ...base, id: `app:${c.name}`, kind: 'contraption', name: f.contraptions.length > 1 ? c.title : 'App', link: `/apps/${c.name}/`, contraption: c.name });
  }
  const feeds = [...f.apkFeeds];
  for (const w of f.workflows) {
    const on = shipsOn(w.text, f.branch);
    if (!on) continue;
    const file = w.path.replace(/^.*\//, '');
    const actions = slug ? `https://github.com/${slug}/actions/workflows/${file}` : null;
    // A release APK (a debug build is a test copy): started by hand is how people make one.
    if (/assembleRelease|bundleRelease/.test(w.text)) {
      const feed = feeds.shift();
      out.push({ ...base, id: `apk:${file.replace(/\.ya?ml$/, '')}`, kind: 'apk', name: 'Android', link: feed ? `/apps/${feed}/android/` : actions, workflow: w.path, ...(feed ? { contraption: feed } : {}) });
      continue;
    }
    if (on !== 'push') continue;
    for (const [id, job] of jobsOf(w.text)) {
      if (shipsPackage(id, job)) out.push({ ...base, id: `ci:${file.replace(/\.ya?ml$/, '')}:${id}`, kind: 'ci', name: platform(w.path, w.text, job), link: actions, workflow: w.path, job: id });
    }
  }
  for (const feed of feeds) out.push({ ...base, id: `apk:${feed}`, kind: 'apk', name: 'Android', link: `/apps/${feed}/android/`, contraption: feed });
  // Two of one platform keep apart by their job.
  for (const t of out) if (t.kind === 'ci' && out.some((o) => o !== t && o.name === t.name)) t.name = `${t.name} (${t.job})`;
  // Main only where nothing else ships what lands there (Josh's "everything": every scheme's work reaches people somehow).
  if (!out.length && !f.own) out.push({ ...base, id: 'main', kind: 'main', name: 'Main', link: slug ? `https://github.com/${slug}/commits/${f.branch}` : null });
  const kept: Found[] = [];
  for (const t of out) {
    const o = f.overrides.find((x) => x.id === t.id);
    if (o?.hidden) continue;
    kept.push({ ...t, ...(typeof o?.name === 'string' && o.name.trim() ? { name: o.name.trim() } : {}), ...(typeof o?.link === 'string' ? { link: o.link } : {}) });
  }
  return kept;
}

/** The overrides in a citadel-app.json's text: its `targets`, the well-formed entries only. */
export function overridesOf(text: string | null): Override[] {
  if (!text) return [];
  try {
    const list = JSON.parse(text)?.targets;
    return Array.isArray(list) ? list.filter((o) => o && typeof o.id === 'string') : [];
  } catch {
    return [];
  }
}

export interface FinderDeps {
  store: Store;
  /** The scheme whose code this server runs, or null before it's known. */
  own: () => Project | null;
  /** Where a contraption's android/latest.json would be (its data folder). */
  apkFeed: (name: string) => string;
}

/** Every scheme's found targets, read again by scan(): at start, when a scheme or contraption is made, and on a slow poll. */
export class TargetFinder {
  private d: FinderDeps;
  private found = new Map<number, Found[]>();
  constructor(d: FinderDeps) {
    this.d = d;
  }

  list(kind?: Kind): Found[] {
    const all = [...this.found.values()].flat();
    return kind ? all.filter((t) => t.kind === kind) : all;
  }

  async scan() {
    const { store } = this.d;
    const apps = store.listContraptions();
    const seen = new Set<number>();
    for (const p of store.listProjects()) {
      seen.add(p.id);
      const facts = await this.facts(p, apps.filter((c) => c.home_scheme === p.id));
      // A clone git can't read keeps what was found before, rather than its targets blinking out.
      if (facts) this.found.set(p.id, detect(facts));
      else if (!p.repo_dir) this.found.delete(p.id);
    }
    for (const id of this.found.keys()) if (!seen.has(id)) this.found.delete(id);
  }

  private async facts(p: Project, apps: ContraptionRow[]): Promise<SchemeFacts | null> {
    const base = { project: p, own: this.d.own()?.id === p.id, contraptions: apps, apkFeeds: apps.filter((c) => existsSync(this.d.apkFeed(c.name))).map((c) => c.name) };
    if (!p.repo_dir) return apps.length ? { ...base, branch: 'main', workflows: [], overrides: [] } : null;
    const dir = p.repo_dir;
    const branch = await defaultBranch(dir);
    if (!branch) return null;
    const files = await git(['ls-tree', '--name-only', `${branch}:.github/workflows`], dir);
    const workflows = [];
    for (const name of (files ?? '').split('\n').filter((n) => /\.ya?ml$/.test(n))) {
      const text = await git(['show', `${branch}:.github/workflows/${name}`], dir);
      if (text != null) workflows.push({ path: `.github/workflows/${name}`, text });
    }
    return { ...base, branch: branch.replace(/^origin\//, ''), workflows, overrides: overridesOf(await git(['show', `${branch}:citadel-app.json`], dir)) };
  }
}

/** The ref to read a clone's default branch at: origin's HEAD's branch, local if the clone has it, else origin's; null with neither. */
export async function defaultBranch(dir: string): Promise<string | null> {
  const name = (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir))?.trim().replace(/^origin\//, '');
  for (const ref of name ? [name, `origin/${name}`] : ['main', 'master']) {
    if ((await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], dir)) != null) return ref;
  }
  return null;
}
