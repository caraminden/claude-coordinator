// Release targets, found (#627; Josh, 2026-11-13: "it should add new schemes as they are created once they have
// anything resembling a "release" or build, or preview site"). Nobody declares a target: each scheme's targets are
// read from what it already has, its contraptions and its repo's workflow files on the default branch (read from the
// scheme's clone, so finding costs no GitHub call). A scheme's citadel-app.json may carry `targets` to rename, hide
// or relink a found one: [{ "id": "main", "hidden": true }]. src/release-readers.ts reads each kind's releases.
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { ContraptionRow, Project, Store } from './db.ts';
import { repoSlug } from './prlinks.ts';
import { git, type Target } from './releases.ts';
import { desktopTargetOf, type DesktopTarget } from './desktop-feed.ts';

/** contraption: an app at /apps/<name>/; apk: an Android app people install; ci: a package a workflow builds; file: builds minions
 * handed people as files (no CI makes them); main: the branch itself. */
export type Kind = 'contraption' | 'apk' | 'ci' | 'file' | 'main';

export interface Found extends Target {
  kind: Kind;
  /** The scheme's default branch, which every target ships from. */
  branch: string;
  /** contraption, and an apk its app serves: the contraption's name. */
  contraption?: string;
  /** apk and ci: the workflow file (.github/workflows/x.yml) that builds it, and for ci the job. */
  workflow?: string;
  job?: string;
  /** file: its builds, newest first. */
  files?: BuildFile[];
  /** file: where every release build of its platform is, a version's duplicates too, so none is listed as a test copy. */
  shared?: string[];
  /** A ci job's own `name:`, which is what the Actions API calls it; its id when it has none. */
  jobName?: string;
  /** The repo folders it ships (#764): a change touching one goes to it; a target with none takes what no target's folder holds. */
  paths?: string[];
  /** Ships only changes in its paths, never the rest as a fallback: an app in a folder of its scheme's repo (#1136). */
  own?: boolean;
  /** ci: the workflow files ("desktop.yml") that must also run every job green on a build's commit before it goes out to
   * people (#1019, citadel-app.json `release.needs`): until then its changes are still on their way. */
  needs?: string[];
  /** ci: the desktop app its release build goes out to through Citadel's feed (#1148, citadel-app.json `desktop`). */
  desktop?: DesktopTarget;
}

export interface Override {
  id: string;
  name?: string;
  hidden?: boolean;
  link?: string;
  /** The folders it ships, as path prefixes or globs ("companion/", "android/**"): see Found.paths. */
  paths?: string[];
  /** How its releases are numbered and named (Target.numbering). */
  release?: { name?: string; number?: string; needs?: string[] };
  /** ci: publish its release build to a desktop feed: { app, exe?, started?, title? } (src/desktop-feed.ts). */
  desktop?: unknown;
}

/** A build a minion shared (the artifacts table): a file people install or run, and what it is for. */
export interface BuildFile {
  ticketId: number;
  /** Its minion's number. */
  number: number;
  /** As the minion linked it, for the file route; `abs` is where it is. */
  path: string;
  abs: string;
  name: string;
  /** When it was shared (ms). */
  at: number;
  platform: string;
  /** A release people were handed, or a test copy: a debug build, or one built from a minion's branch. */
  release: boolean;
  /** Its version from its name ("0.4"), or the commit in it. */
  version: string;
}

/** What a build file is, from its name and (for an archive) the names inside it; null for anything else. */
export function buildOf(name: string, inside: string[] | null): { platform: string; release: boolean; version: string } | null {
  const lower = name.toLowerCase();
  const has = (re: RegExp) => !!inside?.some((n) => re.test(n));
  // A Chrome extension zip has its manifest at the root (or in one folder); a Windows build, an .exe; an APK may come zipped.
  const platform = /\.(apk|aab)$/.test(lower) ? 'Android' : /\.xpi$/.test(lower) ? (has(/^manifest\.json$/) ? 'Firefox' : null) : !/\.zip$/.test(lower) ? null : has(/^([^/]+\/)?manifest\.json$/) ? 'Chrome' : has(/\.exe$/i) ? 'Windows' : has(/\.apk$/i) ? 'Android' : has(/\.app\//) ? 'macOS' : null;
  if (!platform) return null;
  const version = /[-_ ]v?(\d+\.\d+(?:\.\d+)*)(?=[-_. ])/.exec(name)?.[1] ?? /-([0-9a-f]{7,40})(?=[-.])/.exec(name)?.[1] ?? name.replace(/\.[a-z0-9]+$/i, '');
  // Delve's windows-build.sh names a branch's build Delve-ticket-<n>-…-<sha>-windows.zip; a build's or main's isn't a minion's branch.
  return { platform, release: !/debug|(^|[-_])ticket-\d+/i.test(lower), version };
}

/** The names of the files in a zip, from its central directory; null when it isn't one we can read. */
// shortcut: no Zip64 (an archive over 4 GB or 65,535 files reads as null), until a build that big ships.
export async function zipNames(file: string): Promise<string[] | null> {
  const fh = await open(file).catch(() => null);
  if (!fh) return null;
  try {
    const { size } = await fh.stat();
    const tail = Buffer.alloc(Math.min(size, 65_557));
    await fh.read(tail, 0, tail.length, size - tail.length);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > tail.length) return null;
    const count = tail.readUInt16LE(end + 10),
      dirSize = tail.readUInt32LE(end + 12),
      dirAt = tail.readUInt32LE(end + 16);
    if (dirSize > 8_000_000 || dirAt + dirSize > size) return null;
    const dir = Buffer.alloc(dirSize);
    await fh.read(dir, 0, dirSize, dirAt);
    const names: string[] = [];
    for (let i = 0, p = 0; i < count && p + 46 <= dir.length && dir.readUInt32LE(p) === 0x02014b50; i++) {
      const n = dir.readUInt16LE(p + 28);
      names.push(dir.toString('utf8', p + 46, p + 46 + n));
      p += 46 + n + dir.readUInt16LE(p + 30) + dir.readUInt16LE(p + 32);
    }
    return names;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

/** What detection reads of one scheme. */
export interface SchemeFacts {
  project: Pick<Project, 'id' | 'name' | 'repo_url'>;
  /** The scheme whose code this server runs: its server is its target (CitadelServer), so it gets no Main. */
  own: boolean;
  branch: string;
  contraptions: (Pick<ContraptionRow, 'name' | 'title'> & Partial<Pick<ContraptionRow, 'repo' | 'subdir'>>)[];
  /** Contraptions with an android/latest.json in their data folder: an APK they serve. */
  apkFeeds: string[];
  workflows: { path: string; text: string }[];
  overrides: Override[];
  /** Scripts that run a preview site (poe2's deploy/preview.sh). */
  scripts?: { path: string; text: string }[];
  /** Builds its minions shared, newest first. */
  files?: BuildFile[];
  /** The folder its repo's contraption runs from (the root citadel-app.json's `workdir`), when not the root. */
  appDir?: string;
  /** The folder its Android app is in (the one holding app/build.gradle), when not the root. */
  apkDir?: string;
}

/** Where a scheme's test copies come from, besides Citadel's previews (src/releases.ts previewCopies). */
export type CopySource =
  | { kind: 'site'; projectId: number; name: string; port: number }
  /** A workflow that builds a debug APK on main; `run` is it as a whole-run target, for src/release-readers.ts's run reads. */
  | { kind: 'debug-apk'; projectId: number; target: string | null; run: Found };

/** A scheme's test-copy sources, beside its targets `found`: a debug APK workflow, and a script that runs a preview site on a port. */
export function copySources(f: SchemeFacts, found: Found[]): CopySource[] {
  const out: CopySource[] = [];
  for (const w of f.workflows) {
    if (!/assembleDebug|bundleDebug/.test(w.text) || /assembleRelease|bundleRelease/.test(w.text) || shipsOn(w.text, f.branch) !== 'push') continue;
    const file = w.path.replace(/^.*\//, '');
    const run: Found = { projectId: f.project.id, branch: f.branch, id: `debug:${file.replace(/\.ya?ml$/, '')}`, kind: 'apk', name: 'Debug APK', link: null, workflow: w.path };
    out.push({ kind: 'debug-apk', projectId: f.project.id, target: found.find((t) => t.kind === 'apk')?.id ?? null, run });
  }
  for (const s of f.scripts ?? []) {
    const port = Number(/\bPORT=\$\{PORT:-(\d+)\}/.exec(s.text)?.[1] ?? /^\s*(?:export\s+)?PORT=(\d+)\s*$/m.exec(s.text)?.[1]);
    if (port > 0 && port < 65536) out.push({ kind: 'site', projectId: f.project.id, name: 'Preview site', port });
  }
  return out;
}

/** A top-level YAML key's block (`on:`, `jobs:`): its first line's rest, and the lines under it. */
function block(text: string, key: string): { inline: string; body: string } | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => new RegExp(`^["']?${key}["']?:`).test(l));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && !/^[^\s#]/.test(lines[j])) j++;
  return {
    inline: lines[i]
      .replace(/^[^:]+:/, '')
      .replace(/#.*/, '')
      .trim(),
    body: lines.slice(i + 1, j).join('\n'),
  };
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
  const events = on.inline
    ? new Map(
        on.inline
          .replace(/[[\]]/g, '')
          .split(',')
          .map((e) => [e.trim(), ''] as [string, string]),
      )
    : children(on.body);
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

/** A workflow's push `paths:` filter (null: none), so only changes there ship on it. */
export function pushPaths(text: string): string[] | null {
  const on = block(text, 'on');
  const push = on && !on.inline ? children(on.body).get('push') : null;
  const list = push ? /\bpaths:([^\n]*(?:\n\s+-[^\n]*)*)/.exec(push)?.[1] : null;
  if (!list) return null;
  const items = list
    .replace(/[[\]]/g, '')
    .split(/[\n,]/)
    .map((l) =>
      l
        .replace(/^\s*-?\s*/, '')
        .replace(/#.*/, '')
        .trim()
        .replace(/^(["'])(.*)\1$/, '$2'),
    )
    .filter(Boolean);
  return items.length ? items : null;
}

/** A path filter as a prefix: what comes before its first glob character ("android/**" → "android/"); "" holds everything. */
const prefixOf = (p: string) => p.replace(/^\.?\//, '').split(/[*?[{]/)[0];

/**
 * Whether a target's folders hold file `f`, as GitHub reads a `paths:` list: the last pattern that matches decides, a
 * `!` one excluding. shortcut: a pattern matches by its prefix before the first glob character, so `*.md` holds every
 * file; match whole globs if a scheme's filter needs it.
 */
export function holds(t: Pick<Found, 'paths'>, f: string): boolean {
  let held = false;
  for (const p of t.paths ?? []) {
    const neg = p.startsWith('!');
    const x = prefixOf(neg ? p.slice(1) : p);
    if (!x || f === x.replace(/\/$/, '') || f.startsWith(x.endsWith('/') ? x : `${x}/`)) held = !neg;
  }
  return held;
}

/**
 * The targets a change ships on (#764), by the files it touched: each file goes to the targets whose folder holds it,
 * else to the targets with no folder of their own; a change that reaches none (no files known, or only folders with no
 * target) goes to the scheme's first target, so it never drops out. File targets (no pipeline) only when there is
 * nothing else. `targets` are one scheme's, in detect's order.
 */
export function shipsTo(files: string[] | null | undefined, targets: Pick<Found, 'id' | 'kind' | 'paths'>[]): string[] {
  const own = targets.filter((t) => t.kind !== 'file');
  const list = own.length ? own : targets;
  const out = new Set<string>();
  for (const f of files ?? []) {
    const mine = list.filter((t) => holds(t, f));
    for (const t of mine.length ? mine : list.filter((t) => !t.paths?.length)) out.add(t.id);
  }
  if (!out.size && list.length) out.add(list[0].id);
  return [...out];
}

/** Each job of a workflow, by its id. */
export function jobsOf(text: string): Map<string, string> {
  const jobs = block(text, 'jobs');
  return jobs ? children(jobs.body) : new Map();
}

const PUBLISHES = /gh release (create|upload)|action-gh-release|actions\/create-release|actions\/upload-release-asset|ci-upload\.sh\s+--kind\s+release/;
const RELEASE_JOB = /release|package|dist|publish|bundle|installer/i;

/** A job's own `name:` (not a step's or an input's), unquoted, or null. */
export function jobName(job: string): string | null {
  return (
    children(job)
      .get('name')
      ?.replace(/#.*/, '')
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2') || null
  );
}

/** A job that hands people something: it publishes a GitHub Release, or uploads an artifact from a release-like job. */
export function shipsPackage(id: string, job: string): boolean {
  if (PUBLISHES.test(job)) return true;
  if (!/actions\/upload-artifact/.test(job)) return false;
  return RELEASE_JOB.test(id) || RELEASE_JOB.test(jobName(job) ?? '');
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
    // The root citadel-app.json is the contraption deployed from this repo.
    // An app in a folder of the repo (#1136) ships only what touches that folder; otherwise the root citadel-app.json's workdir.
    const dir = c.subdir ? { paths: [`${c.subdir.replace(/\/$/, '')}/`], own: true } : f.appDir && (!c.repo || c.repo.toLowerCase() === slug) ? { paths: [f.appDir] } : {};
    out.push({ ...base, id: `app:${c.name}`, kind: 'contraption', name: f.contraptions.length > 1 ? c.title : 'Contraption', link: `/apps/${c.name}/`, contraption: c.name, ...dir });
  }
  const apkDir = f.apkDir ? { paths: [f.apkDir] } : {};
  const feeds = [...f.apkFeeds];
  for (const w of f.workflows) {
    const on = shipsOn(w.text, f.branch);
    if (!on) continue;
    const file = w.path.replace(/^.*\//, '');
    // A release APK (a debug build is a test copy): started by hand is how people make one.
    if (/assembleRelease|bundleRelease/.test(w.text)) {
      const feed = feeds.shift();
      out.push({ ...base, id: `apk:${file.replace(/\.ya?ml$/, '')}`, kind: 'apk', name: 'Android', link: feed ? `/apps/${feed}/android/` : null, workflow: w.path, ...(feed ? { contraption: feed } : {}), ...apkDir });
      continue;
    }
    if (on !== 'push') continue;
    const paths = pushPaths(w.text);
    for (const [id, job] of jobsOf(w.text)) {
      if (shipsPackage(id, job)) out.push({ ...base, id: `ci:${file.replace(/\.ya?ml$/, '')}:${id}`, kind: 'ci', name: platform(w.path, w.text, job), link: null, workflow: w.path, job: id, jobName: jobName(job) ?? id, ...(paths ? { paths } : {}) });
    }
  }
  for (const feed of feeds) out.push({ ...base, id: `apk:${feed}`, kind: 'apk', name: 'Android', link: `/apps/${feed}/android/`, contraption: feed, ...apkDir });
  // A platform no workflow or feed ships, whose builds minions hand people as files (FuckSpamTexts' APK and Chrome
  // extension, Delve's Windows zip): its releases are those files. Only files named for the scheme or its repo, so
  // another scheme's build a minion shared here (a Delve zip in Citadel) isn't taken for this one's.
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const ours = [f.project.name, slug?.split('/')[1]].map((s) => key(s ?? '')).filter(Boolean);
  const released = (f.files ?? []).filter((b) => b.release && ours.some((k) => key(b.name).startsWith(k)));
  for (const platform of [...new Set(released.map((b) => b.platform))]) {
    if (out.some((t) => t.name === platform || t.name.startsWith(`${platform} (`) || (platform === 'Android' && t.kind === 'apk'))) continue;
    // One file per version: the APK itself over the same APK zipped, then the newest (a stable sort settles a tie).
    const all = released.filter((b) => b.platform === platform);
    const apk = (b: BuildFile) => Number(/\.apk$/i.test(b.name));
    const first = new Map<string, BuildFile>();
    for (const b of [...all].sort((x, y) => apk(y) - apk(x) || y.at - x.at)) if (!first.has(b.version)) first.set(b.version, b);
    out.push({ ...base, id: `file:${platform.toLowerCase()}`, kind: 'file', name: platform, link: null, files: all.filter((b) => first.get(b.version) === b), shared: all.map((b) => b.abs) });
  }
  // Two of one platform keep apart by their job.
  for (const t of out) if (t.kind === 'ci' && out.some((o) => o !== t && o.name === t.name)) t.name = `${t.name} (${t.job})`;
  // Main only where nothing else ships what lands there (Josh's "everything": every scheme's work reaches people somehow).
  if (!out.length && !f.own) out.push({ ...base, id: 'main', kind: 'main', name: 'Main', link: null });
  const kept: Found[] = [];
  for (const t of out) {
    const o = f.overrides.find((x) => x.id === t.id);
    if (o?.hidden) continue;
    const paths = Array.isArray(o?.paths) ? o.paths.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
    const numbering = numberingOf(o?.release);
    const needs = t.kind === 'ci' ? needsOf(o?.release) : [];
    const desktop = t.kind === 'ci' ? desktopTargetOf(o?.desktop) : null;
    kept.push({
      ...t,
      ...(typeof o?.name === 'string' && o.name.trim() ? { name: o.name.trim() } : {}),
      ...(typeof o?.link === 'string' ? { link: o.link } : {}),
      ...(paths.length ? { paths } : {}),
      ...(numbering ? { numbering } : {}),
      ...(needs.length ? { needs } : {}),
      ...(desktop ? { desktop } : {}),
    });
  }
  return kept;
}

/** An override's `release`, kept when well formed: a name with {n} in it, and a number source this server knows. */
function numberingOf(r: Override['release']): Target['numbering'] | null {
  if (!r || typeof r !== 'object') return null;
  const name = typeof r.name === 'string' && r.name.includes('{n}') ? r.name.trim() : undefined;
  const number = r.number === 'run' || r.number === 'count' ? r.number : undefined;
  return name || number ? { ...(name ? { name } : {}), ...(number ? { number } : {}) } : null;
}

/** An override's `release.needs`: workflow file names (".github/workflows/desktop.yml" or "desktop.yml"), as file names. */
function needsOf(r: Override['release']): string[] {
  const list = r && typeof r === 'object' && Array.isArray(r.needs) ? r.needs : [];
  return [
    ...new Set(
      list
        .filter((w): w is string => typeof w === 'string')
        .map((w) => w.trim().replace(/^.*\//, ''))
        .filter((w) => /^[\w.-]+\.ya?ml$/.test(w)),
    ),
  ];
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

/** A citadel-app.json's `workdir` as a folder ("companion/"), or undefined at the root or when it can't be read. */
export function workdirOf(text: string | null): string | undefined {
  try {
    const w = text ? JSON.parse(text)?.workdir : null;
    const dir =
      typeof w === 'string'
        ? w
            .trim()
            .replace(/^\.?\/+/, '')
            .replace(/\/+$/, '')
        : '';
    return dir && dir !== '.' && !dir.startsWith('..') ? `${dir}/` : undefined;
  } catch {
    return undefined;
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
  private sources = new Map<number, CopySource[]>();
  /** Each shared file's build, by its path and mtime, so a scan doesn't open a zip twice. */
  private builds = new Map<string, ReturnType<typeof buildOf>>();
  private seenBuilds = new Set<string>();
  constructor(d: FinderDeps) {
    this.d = d;
  }

  /** Every scheme's test-copy sources, as last found. */
  copySources(): CopySource[] {
    return [...this.sources.values()].flat();
  }

  list(kind?: Kind): Found[] {
    const all = [...this.found.values()].flat();
    return kind ? all.filter((t) => t.kind === kind) : all;
  }

  /** Whether a release workflow signs `app`'s APKs (src/apk-build.ts leaves those to CI). */
  async ciRelease(app: ContraptionRow): Promise<boolean> {
    return this.list('apk').some((t) => t.contraption === app.name && !!t.workflow);
  }

  async scan() {
    const { store } = this.d;
    const apps = store.listContraptions();
    const seen = new Set<number>();
    this.seenBuilds.clear();
    for (const p of store.listProjects()) {
      seen.add(p.id);
      const facts = await this.facts(
        p,
        apps.filter((c) => c.home_scheme === p.id),
      );
      // A clone git can't read keeps what was found before, rather than its targets blinking out.
      if (facts) {
        const found = detect(facts);
        this.found.set(p.id, found);
        this.sources.set(p.id, copySources(facts, found));
      } else if (!p.repo_dir) {
        this.found.delete(p.id);
        this.sources.delete(p.id);
      }
    }
    for (const id of this.found.keys()) if (!seen.has(id)) this.found.delete(id);
    for (const id of this.sources.keys()) if (!seen.has(id)) this.sources.delete(id);
    for (const key of this.builds.keys()) if (!this.seenBuilds.has(key)) this.builds.delete(key);
  }

  /** The builds a scheme's minions shared that are still there, newest first. */
  private async files(p: Project): Promise<BuildFile[]> {
    const out: BuildFile[] = [];
    for (const a of this.d.store.listArtifacts(p.id)) {
      if (a.missing || !/\.(apk|aab|zip|xpi)$/i.test(a.path)) continue;
      const t = this.d.store.getTicket(a.ticket_id);
      const abs = isAbsolute(a.path) ? a.path : t?.cwd ? join(t.cwd, a.path) : null;
      const st = abs ? await stat(abs).catch(() => null) : null;
      if (!t || !abs || !st?.isFile()) continue;
      const key = `${abs}:${st.mtimeMs}`;
      this.seenBuilds.add(key);
      if (!this.builds.has(key)) this.builds.set(key, buildOf(basename(abs), /\.(zip|xpi)$/i.test(abs) ? await zipNames(abs) : null));
      const b = this.builds.get(key);
      if (b) out.push({ ticketId: t.id, number: t.number ?? t.id, path: a.path, abs, name: basename(abs), at: a.created_at, ...b });
    }
    return out.sort((x, y) => y.at - x.at);
  }

  /** Every shared build that is a release, by where it is: the test-copy list leaves these out. */
  releaseFiles(): Set<string> {
    return new Set(this.list('file').flatMap((t) => t.shared ?? []));
  }

  private async facts(p: Project, apps: ContraptionRow[]): Promise<SchemeFacts | null> {
    const base = { project: p, own: this.d.own()?.id === p.id, contraptions: apps, apkFeeds: apps.filter((c) => existsSync(this.d.apkFeed(c.name))).map((c) => c.name), files: await this.files(p) };
    if (!p.repo_dir) return apps.length || base.files.length ? { ...base, branch: 'main', workflows: [], overrides: [] } : null;
    const dir = p.repo_dir;
    const branch = await defaultBranch(dir);
    if (!branch) return null;
    const files = await git(['ls-tree', '--name-only', `${branch}:.github/workflows`], dir);
    const workflows = [];
    for (const name of (files ?? '').split('\n').filter((n) => /\.ya?ml$/.test(n))) {
      const text = await git(['show', `${branch}:.github/workflows/${name}`], dir);
      if (text != null) workflows.push({ path: `.github/workflows/${name}`, text });
    }
    const scripts = [];
    const tree = ((await git(['ls-tree', '-r', '--name-only', branch], dir)) ?? '').split('\n');
    for (const path of tree.filter((n) => /(^|\/)[^/]*preview[^/]*\.sh$/i.test(n))) {
      const text = await git(['show', `${branch}:${path}`], dir);
      if (text != null) scripts.push({ path, text });
    }
    const app = await git(['show', `${branch}:citadel-app.json`], dir);
    // The Android app's top folder (android/native/app/build.gradle → android/); none when it is the repo itself.
    const gradle = tree.find((n) => /(^|\/)app\/build\.gradle(\.kts)?$/.test(n));
    const apkDir = gradle && gradle.split('/').length > 2 ? `${gradle.split('/')[0]}/` : undefined;
    return { ...base, branch: branch.replace(/^origin\//, ''), workflows, scripts, overrides: overridesOf(app), appDir: workdirOf(app), apkDir };
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
