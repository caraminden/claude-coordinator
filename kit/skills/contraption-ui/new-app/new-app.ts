// The new-app generator: writes a working Citadel app into a folder of a scheme's repo, from template/.
// Citadel's make_app tool runs it; by hand: node new-app.ts <repo> <name> <title> <idea> [runner-label]
// What the app gets and why each part is the one way: docs/adr/ (the new-app decision) in Citadel's repo.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const HERE = import.meta.dirname;
const TEMPLATE = join(HERE, 'template');
/** Copied as they are: the kit's stand-in icons and its fake Citadel, so a fix in the kit reaches the next app. */
const COPIED: [string, string][] = [
  ...['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'].map((f): [string, string] => [join(HERE, '..', 'starter', f), join('public', f)]),
  [join(HERE, '..', 'fake-citadel', 'fake-citadel.ts'), join('test', 'fake-citadel.ts')],
];
/** Citadel's contraption name rule (src/contraptions.ts CONTRAPTION_NAME). */
export const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** A title lands in HTML, JSON and code comments unescaped, so it keeps to characters safe in all three. */
export const TITLE = /^[\p{L}\p{N}][\p{L}\p{N} .,'!?:()+-]{0,59}$/u;

export interface NewApp {
  /** The repo's root (a checkout or worktree). The app goes in apps/<name>/ under it. */
  repo: string;
  name: string;
  title: string;
  /** What the app is for, in the asker's words: it goes into the app's CLAUDE.md and README. */
  idea: string;
  /** The scheme's CI runner label (`<scheme-slug>-ci`), or null for no workflow. */
  runner: string | null;
}

export const appDir = (name: string) => join('apps', name);

/** Write the app; returns the paths written, relative to the repo. Refuses a bad name or title, or a folder that exists. */
export function generateApp({ repo, name, title, idea, runner }: NewApp): string[] {
  if (!NAME.test(name)) throw new Error(`Not an app name: ${name} (lowercase letters, digits and dashes, like mandate)`);
  if (!TITLE.test(title)) throw new Error(`The title must be 1 to 60 letters, digits, spaces and simple punctuation: ${title}`);
  idea = idea.trim().replace(/\r/g, '');
  if (!idea || idea.length > 4000) throw new Error('The idea must be 1 to 4000 characters');
  if (runner !== null && !/^[a-z0-9-]+-ci$/.test(runner)) throw new Error(`Not a runner label: ${runner}`);
  const dir = join(repo, appDir(name));
  if (existsSync(dir)) throw new Error(`${appDir(name)} already exists in the repo`);
  const workflow = join(repo, '.github', 'workflows', `app-${name}.yml`);
  if (runner && existsSync(workflow)) throw new Error(`${relative(repo, workflow)} already exists in the repo`);
  const fill = (s: string) => s.replace(/\{\{(name|title|idea|runner)\}\}/g, (_, k: string) => ({ name, title, idea, runner: runner ?? '' })[k]!);
  const written: string[] = [];
  const write = (to: string, body: string | Buffer) => {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, body);
    written.push(relative(repo, to));
  };
  for (const f of readdirSync(TEMPLATE, { recursive: true, withFileTypes: true })) {
    if (!f.isFile()) continue;
    const from = join(f.parentPath, f.name);
    write(join(dir, relative(TEMPLATE, from)), fill(readFileSync(from, 'utf8')));
  }
  for (const [from, to] of COPIED) {
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    copyFileSync(from, join(dir, to));
    written.push(join(appDir(name), to));
  }
  if (runner) write(workflow, fill(readFileSync(join(HERE, 'workflow.yml'), 'utf8')));
  return written.sort();
}

if (import.meta.main) {
  const [repo, name, title, idea, runner] = process.argv.slice(2);
  if (!repo || !name || !title || !idea) throw new Error('usage: node new-app.ts <repo> <name> <title> <idea> [runner-label]');
  for (const f of generateApp({ repo, name, title, idea, runner: runner || null })) console.log(f);
}
