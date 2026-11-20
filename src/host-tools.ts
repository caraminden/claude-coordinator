// Host tools (#1147; Josh, 2026-11-19, "Minion proposes, owner approves", as machine notes #617): a minion that needs a
// tool on the server proposes it with propose_host_tool, a member of the Citadel scheme approves on a card, the server
// installs it with mise and ships its line in deploy/host-tools.json, the list a rebuild of the box installs from
// (`node tools/host-tools.ts install`) and a turn reads to see what the host has. Josh's picks, 2026-11-19: Citadel
// scheme members approve; mise's tools, npm, Python packages, cargo crates, GitHub release binaries and Arch packages
// are allowed; the list lives in Citadel's repo, and the server ships each line itself.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SOURCES = ['mise', 'npm', 'pypi', 'cargo', 'github', 'pacman'] as const;
export type Source = (typeof SOURCES)[number];

/** What a minion proposes. */
export interface HostTool {
  source: Source;
  package: string;
  version: string;
  why: string;
}

/** A line of the list: the tool, and who approved it for whom. */
export interface ListedTool extends HostTool {
  approved_by: string;
  /** The Pacific date of the approval. */
  approved_on: string;
  /** The minion that asked, as "<scheme> #N". */
  asked_by: string;
}

/** The list, relative to Citadel's repo. */
export const MANIFEST = 'deploy/host-tools.json';
/** The running server's own copy, which every turn can read (a container's at the same path: src/claude-link.ts). */
export const LIVE_MANIFEST = join(import.meta.dirname, '..', MANIFEST);

// Names as each source spells them; nothing else reaches mise's argv. A github package is owner/repo.
const NAMES: Record<Source, RegExp> = {
  mise: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  npm: /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/,
  pypi: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
  cargo: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  github: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/,
  pacman: /^[a-z0-9@_+][a-z0-9@._+-]{0,99}$/,
};
/** One exact version: no ranges, no "latest". */
const VERSION = /^v?[0-9][0-9A-Za-z.+_-]{0,63}$/;

const SOURCE_NAMES: Record<Source, string> = {
  mise: "mise's own tools", npm: 'npm', pypi: 'Python packages (PyPI)', cargo: 'Rust crates', github: 'GitHub release binaries', pacman: 'Arch packages',
};
export const sourceName = (s: Source) => SOURCE_NAMES[s];

/** A proposal checked field by field; throws an Error saying what was wrong. */
export function parseHostTool(body: { source?: unknown; package?: unknown; version?: unknown; why?: unknown }): HostTool {
  const source = body.source as Source;
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
  const pkg = typeof body.package === 'string' ? body.package.trim() : '';
  if (!NAMES[source].test(pkg)) throw new Error(`"${pkg.slice(0, 100)}" isn't a ${sourceName(source)} name${source === 'github' ? ' (owner/repo)' : ''}`);
  const version = typeof body.version === 'string' ? body.version.trim() : '';
  if (!VERSION.test(version)) throw new Error(`version must be one exact version, such as 1.2.3: "${version.slice(0, 64)}" isn't`);
  const why = typeof body.why === 'string' ? body.why.trim() : '';
  if (!why) throw new Error('why is required: what the tool is for');
  if (why.length > 500) throw new Error(`why is too long: ${why.length} characters, at most 500`);
  return { source, package: pkg, version, why };
}

/** mise's name for it, as `mise use` takes it; null for an Arch package, which needs root. */
export function miseSpec(t: Pick<HostTool, 'source' | 'package' | 'version'>): string | null {
  if (t.source === 'pacman') return null;
  return `${t.source === 'mise' ? '' : `${t.source}:`}${t.package}@${t.version}`;
}

/** The exact command the card shows and approve runs (an Arch package's is run by a person: the server has no root). */
export function installCommand(t: Pick<HostTool, 'source' | 'package' | 'version'>): string {
  const spec = miseSpec(t);
  return spec ? `mise use -g --pin ${spec}` : `sudo pacman -S --needed ${t.package}`;
}

/** "npm:pyright@1.1.414", for titles and messages. */
export const toolLabel = (t: Pick<HostTool, 'source' | 'package' | 'version'>) => `${t.source}:${t.package}@${t.version}`;

export function readManifest(file: string): ListedTool[] {
  if (!existsSync(file)) return [];
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${file} isn't a list`);
  return list;
}

/** One tool per line, sorted, so two lists that each add a tool rarely touch the same lines. */
export function manifestText(list: ListedTool[]): string {
  const keys: (keyof ListedTool)[] = ['source', 'package', 'version', 'why', 'approved_by', 'approved_on', 'asked_by'];
  const rows = [...list].sort((a, b) => `${a.source}:${a.package}`.localeCompare(`${b.source}:${b.package}`))
    .map((t) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, t[k]]))));
  return rows.length ? `[\n${rows.join(',\n')}\n]\n` : '[]\n';
}

/** The list with `t` in it: a tool already there (same source and package) is replaced, as `mise use` replaces its version. */
export function withTool(list: ListedTool[], t: ListedTool): ListedTool[] {
  return [...list.filter((x) => x.source !== t.source || x.package !== t.package), t];
}

/** The same tool at the same version is listed already. */
export const listed = (list: ListedTool[], t: Pick<HostTool, 'source' | 'package' | 'version'>) =>
  list.some((x) => x.source === t.source && x.package === t.package && x.version === t.version);

/** What `mise ls --json` says: each tool's versions. */
export type MiseList = Record<string, { version: string; installed?: boolean; active?: boolean }[]>;

/**
 * Where the box differs from the list: a line per listed tool that isn't installed at its version (or, from mise, isn't
 * active, so its command won't run). `pacmanVersion` gives an installed Arch package's version, or null.
 */
export function manifestProblems(list: ListedTool[], mise: MiseList, pacmanVersion: (pkg: string) => string | null): string[] {
  const out: string[] = [];
  for (const t of list) {
    if (t.source === 'pacman') {
      // pacman -Q says pkgver-pkgrel ("14.1.1-1"); the list holds the pkgver a person approved.
      const v = pacmanVersion(t.package);
      if (v === null) out.push(`${toolLabel(t)}: not installed; a person runs \`${installCommand(t)}\``);
      else if (v.replace(/-[^-]*$/, '') !== t.version.replace(/^v/, '')) out.push(`${toolLabel(t)}: pacman has ${v} installed; list the version the box has, or install ${t.version}`);
      continue;
    }
    const key = t.source === 'mise' ? t.package : `${t.source}:${t.package}`;
    const got = (mise[key] ?? []).find((v) => v.version === t.version.replace(/^v/, '') || v.version === t.version);
    if (!got?.installed) out.push(`${toolLabel(t)}: not installed; run \`${installCommand(t)}\``);
    else if (got.active === false) out.push(`${toolLabel(t)}: installed but not active in mise's global config; run \`${installCommand(t)}\``);
  }
  return out;
}

/** mise, which a user unit's PATH doesn't have (src/app-services.ts toolPath). */
export function miseBin(home = homedir()): string {
  if (process.env.CITADEL_MISE) return process.env.CITADEL_MISE;
  const local = join(home, '.local/bin/mise');
  return existsSync(local) ? local : 'mise';
}

/** What mise's backends need on the PATH: its shims (uv, node), cargo, then the usual. */
export function installEnv(home = homedir()): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, PATH: [join(home, '.local/share/mise/shims'), join(home, '.cargo/bin'), join(home, '.local/bin'), '/usr/local/bin', '/usr/bin', '/bin'].join(':') };
}

/** Longest an install may take: a cargo crate builds from source. */
export const INSTALL_MS = 30 * 60_000;

let running = 0;
/** Installs running now, as the server's children: a restart waits for them (server.ts runner.hostJobs). */
export const installing = () => running;

/** Install a tool with mise, as approve does and a rebuild does; an Arch package isn't, and says so. */
export function installTool(t: Pick<HostTool, 'source' | 'package' | 'version'>, home = homedir()): Promise<{ ok: boolean; output: string }> {
  const spec = miseSpec(t);
  if (!spec) return Promise.resolve({ ok: false, output: `${t.package} is an Arch package: a person runs \`${installCommand(t)}\`` });
  running++;
  return new Promise((done) => execFile(miseBin(home), ['use', '-g', '--pin', '--yes', spec], { cwd: home, env: installEnv(home), timeout: INSTALL_MS, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
    running--;
    done({ ok: !err, output: `${stdout}${stderr}${err && !stderr ? err.message : ''}`.trim().slice(-4000) });
  }));
}
