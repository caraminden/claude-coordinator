// Where a new scheme's code comes from (#173): a fresh repo that also goes to GitHub, a clone of a
// folder on this machine, a clone of a URL, or none. The server does all of it; tests stub `gh`.
import { execFile } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { APP_NAME } from './appname.ts';
import type { Store } from './db.ts';
import { repoSlug } from './prlinks.ts';

const run = promisify(execFile);
const TIMEOUT_MS = 10 * 60 * 1000;

export const SOURCES = ['new', 'url', 'folder', 'none'] as const;
export type Source = (typeof SOURCES)[number];

/** The app setting that names the GitHub account new schemes' repos are made under. */
export const GITHUB_OWNER = 'github_owner';

/** Extra env a person's GitHub work runs with (src/github-link.ts personGithub); undefined runs as the box's login. */
export type GithubEnv = Record<string, string> | undefined;

/** The server's env with its own tokens taken out, plus `as`: only the person's token (if any) is left. */
export function asEnv(as: GithubEnv): NodeJS.ProcessEnv | undefined {
  if (!as) return undefined;
  const { GH_TOKEN, GITHUB_TOKEN, ...env } = process.env;
  return { ...env, ...as };
}

async function git(args: string[], cwd?: string, as?: GithubEnv): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: asEnv(as), maxBuffer: 16 * 1024 * 1024, timeout: TIMEOUT_MS });
  return stdout.trim();
}
const gitOk = (args: string[], cwd?: string) => git(args, cwd).then(() => true, () => false);

/** A failed command's own words: git and gh put them on stderr. git's hints follow its error, so they go. */
export function errorText(err: any): string {
  const lines = (err?.stderr?.toString().trim() || err?.message || String(err)).split('\n').filter((l: string) => l.trim() && !/^hint:/.test(l));
  return lines.slice(-3).join(' ') || String(err?.message ?? err);
}

/** A GitHub account or organisation name. */
export function validOwner(owner: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
}

/** The owner of Citadel's own GitHub origin, the default for new schemes' repos; null if it isn't on GitHub. */
export async function citadelOwner(): Promise<string | null> {
  const url = await git(['remote', 'get-url', 'origin'], join(import.meta.dirname, '..')).catch(() => null);
  return repoSlug(url)?.split('/')[0] ?? null;
}

/** A GitHub repo name from a scheme name: lowercase letters, digits, dots and dashes; '' if nothing is left. */
export function repoName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100);
}

/** git commits as the machine's configured user, or as Citadel where none is set. */
export async function identity(cwd: string): Promise<string[]> {
  return await gitOk(['config', 'user.email'], cwd) ? [] : ['-c', `user.name=${APP_NAME}`, '-c', 'user.email=citadel@localhost'];
}

/** `git init -b main` in `dir` with one commit: a README from the name and about text, and a .gitignore. */
export async function initRepo(dir: string, name: string, about: string): Promise<void> {
  await git(['init', '--quiet', '-b', 'main', dir]);
  await writeFile(join(dir, 'README.md'), `# ${name}\n${about ? `\n${about}\n` : ''}`);
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n.env\n.env.*\n.DS_Store\n*.log\n');
  await git(['add', 'README.md', '.gitignore'], dir);
  await git([...await identity(dir), 'commit', '--quiet', '-m', `Start ${name}`], dir);
}

/** Whether `owner/name` already exists on GitHub: true, false, or null when gh couldn't tell (offline, signed out). */
export async function githubRepoExists(slug: string, as?: GithubEnv): Promise<boolean | null> {
  try {
    await run('gh', ['repo', 'view', slug, '--json', 'name'], { env: asEnv(as), timeout: 60_000 });
    return true;
  } catch (err) {
    return /Could not resolve to a Repository/i.test(errorText(err)) ? false : null;
  }
}

/** The GitHub URL a scheme's repo `owner/name` lives at. */
export const githubUrl = (slug: string) => `https://github.com/${slug}`;

/**
 * Put the local repo `dir` on GitHub as private `slug` and push main. When a past try already made
 * the repo and set `origin` but the push failed, this only pushes. `checked`: the caller already
 * found the name free. `as`: whose GitHub it goes on (#195). Throws gh's or git's words.
 */
export async function pushToGithub(dir: string, slug: string, checked: boolean, as?: GithubEnv): Promise<void> {
  if (await gitOk(['remote', 'get-url', 'origin'], dir)) {
    await git(['push', '--quiet', '-u', 'origin', 'main'], dir, as);
  } else {
    if (!checked && await githubRepoExists(slug, as)) throw new Error(`GitHub repo ${slug} already exists`);
    await run('gh', ['repo', 'create', slug, '--private', '--source', dir, '--remote', 'origin', '--push'], { cwd: dir, env: asEnv(as), timeout: TIMEOUT_MS });
  }
  // A push sets no origin/HEAD; with it, ticketBase notices when a push elsewhere puts origin ahead.
  await gitOk(['remote', 'set-head', 'origin', 'main'], dir);
}

/** Inside `parent` (or `parent` itself), comparing real paths. */
const within = (path: string, parent: string) => path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * The real path of a folder a scheme may be cloned from, or an error to show: it has to be an
 * absolute path under $HOME, outside the data dir, and the top of a git repo with commits.
 */
export async function checkFolder(folder: string, dataDir: string): Promise<{ path: string } | { error: string }> {
  // The form's placeholder starts with ~/, as people type it.
  if (folder === '~' || folder.startsWith('~/')) folder = join(homedir(), folder.slice(1));
  if (!isAbsolute(folder)) return { error: `The folder must be an absolute path, like ${join(homedir(), 'code', 'my-game')}` };
  let path: string;
  try {
    path = await realpath(folder);
  } catch {
    return { error: `There is no folder at ${folder}` };
  }
  const home = await realpath(homedir()).catch(() => homedir());
  if (!within(path, home)) return { error: `The folder must be under your home folder (${home}); ${folder} isn't` };
  const data = await realpath(dataDir).catch(() => dataDir);
  if (within(path, data) || within(data, path)) return { error: `${folder} is ${APP_NAME}'s own data folder or inside it; pick the original folder instead` };
  const bare = (await git(['rev-parse', '--is-bare-repository'], path).catch(() => '')) === 'true';
  const top = bare ? path : await git(['rev-parse', '--show-toplevel'], path).then((t) => realpath(t), () => null);
  if (top !== path) {
    return { error: top ? `${folder} is inside the git repo at ${top}; give that folder instead` : `${folder} isn't a git repo (no .git); run git init there and commit, or pick another folder` };
  }
  if (!await gitOk(['rev-parse', '--verify', '--quiet', 'HEAD'], path)) return { error: `${folder} is a git repo with no commits yet; commit something first` };
  return { path };
}

/**
 * Clone the folder `src` into `dir`; the folder itself is left untouched. If its origin is on
 * GitHub, the clone's origin becomes that URL, so it behaves like a URL clone. Returns the clone's origin.
 */
export async function cloneFolder(src: string, dir: string): Promise<string> {
  await git(['clone', '--quiet', '--', src, dir]);
  // The URL as configured: get-url would expand insteadOf rules.
  const upstream = await git(['config', '--get', 'remote.origin.url'], src).catch(() => null);
  if (upstream && repoSlug(upstream)) {
    await git(['remote', 'set-url', 'origin', upstream], dir);
    return upstream;
  }
  return src;
}

/**
 * Bring each scheme's repo_url in line with its checkout's GitHub origin (#456): a repo moved on GitHub
 * (FuckSpamTexts, KatzMeIfYouCan to caraminden) keeps its old URL otherwise, and PR links, repo access
 * and CI key on it. Run at boot, so a move takes effect at the next restart.
 */
export async function followOrigins(store: Store): Promise<void> {
  for (const p of store.listProjects()) {
    if (!p.repo_dir) continue;
    // As configured, like cloneFolder; repoSlug refuses a URL with a login in it, so no token lands in the DB.
    const origin = await git(['config', '--get', 'remote.origin.url'], p.repo_dir).catch(() => null);
    const slug = repoSlug(origin);
    if (!slug || slug.toLowerCase() === repoSlug(p.repo_url)?.toLowerCase()) continue;
    store.setProjectUpstream(p.id, origin, null);
    console.log(`${p.name}'s repo moved: ${p.repo_url ?? 'none'} → ${origin}`);
  }
}
