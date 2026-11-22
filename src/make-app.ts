// make_app (#1136): one Taskmaster call makes a working app for its own scheme. On a turn a member of that scheme
// asked for, the server checks the name, starts a minion whose branch already holds the kit's generated app
// (kit/skills/contraption-ui/new-app) in apps/<name>/, registers the app to deploy from that folder of the
// scheme's repo, switches it on for the scheme's members, and sends the minion its brief: ship it, then build
// the idea. The decision record: docs/adr/ (the new-app one).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { manifestOn, parseManifest, MANIFEST } from './app-services.ts';
import { pickFor, pickReason } from '../public/model-table.js';
import { APP_NAME } from './appname.ts';
import { runnerLabel } from './ci-runner.ts';
import { CONTRAPTION_NAME, RESERVED } from './contraptions.ts';
import { askerKey, type Project, type Ticket } from './db.ts';
import { HttpError, type App } from './http.ts';
import { SCHEME_CALLER } from './mandate-items.ts';
import { repoSlug } from './prlinks.ts';
import { addAppTurnsCheck } from './standard-audits.ts';

const run = promisify(execFile);
/** Where new apps' ports come from: above the first apps' (7341-7349), below the 8000s that dev copies use. */
export const PORTS = [7350, 7999] as const;

/** A port in PORTS no app has and nothing on this host listens on. */
export async function freeAppPort(taken: Set<number>, [from, to] = PORTS): Promise<number> {
  for (let port = from; port <= to; port++) {
    if (taken.has(port)) continue;
    const free = await new Promise<boolean>((ok) => {
      const s = createServer().once('error', () => ok(false)).listen(port, '127.0.0.1', () => s.close(() => ok(true)));
    });
    if (free) return port;
  }
  throw new HttpError(503, `No free app port left between ${from} and ${to}`);
}

/** The label its workflow runs on when the scheme has a CI runner its workflows already use; else null, and no workflow. */
export function schemeRunner(project: Pick<Project, 'name'>, repo: string): string | null {
  const label = runnerLabel(project.name);
  const dir = join(repo, '.github', 'workflows');
  if (!label || !existsSync(dir)) return null;
  return readdirSync(dir).some((f) => /\.ya?ml$/.test(f) && readFileSync(join(dir, f), 'utf8').includes(label)) ? label : null;
}

/** Names and ports of make_app calls still between their checks and their registration: two at once never share one. */
const making = { names: new Set<string>(), ports: new Set<number>() };

export interface Made {
  name: string;
  port: number;
  minion: number;
  files: number;
  workflow: boolean;
}

/** The whole of make_app, for `caller` (a Taskmaster of `project`, which the route has checked). */
export async function makeApp(app: App, project: Project, caller: Ticket, by: string, body: { name?: unknown; title?: unknown; idea?: unknown }): Promise<Made> {
  const { store } = app;
  // Loaded on use, as doc-preview loads its kit script: a copy of the server with no kit/ (a test's, a preview's) still boots.
  const { appDir, TITLE } = await import('../kit/skills/contraption-ui/new-app/new-app.ts');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const idea = typeof body.idea === 'string' ? body.idea.trim() : '';
  if (!CONTRAPTION_NAME.test(name) || RESERVED.has(name) || SCHEME_CALLER.test(name)) throw new HttpError(400, 'name must be a short slug: lowercase letters, digits and dashes, like trip-notes');
  if (!TITLE.test(title)) throw new HttpError(400, 'title must be 1 to 60 letters, digits, spaces and simple punctuation');
  if (!idea || idea.length > 4000) throw new HttpError(400, 'idea is required: what the app is for, at most 4,000 characters');
  // Anyone signed in makes one, for a scheme of their own (Josh, 2026-11-19): the person this turn answers is a member.
  const asker = store.turnAsker(caller.id);
  const maker = asker === null ? null : store.listMembers(project.id).find((m) => m.id === asker);
  if (!maker) throw new HttpError(403, `make_app runs only on a turn a member of ${project.name} asked for`);
  if (store.getContraption(name) || making.names.has(name)) throw new HttpError(409, `There is already an app called ${name}`);
  const repo = repoSlug(project.repo_url);
  if (!project.repo_dir || !repo) throw new HttpError(400, `${project.name} has no GitHub repo to keep the app in`);
  if (existsSync(join(project.repo_dir, appDir(name)))) throw new HttpError(409, `${appDir(name)} already exists in ${project.name}'s repo`);
  making.names.add(name);
  let port = 0;
  try {
    port = await freeAppPort(new Set([...store.listContraptions().map((c) => c.port), ...making.ports]));
    making.ports.add(port);
    return await make(app, project, caller, by, { name, title, idea, maker, repo, port });
  } finally {
    making.names.delete(name);
    making.ports.delete(port);
  }
}

async function make(app: App, project: Project, caller: Ticket, by: string, a: { name: string; title: string; idea: string; maker: { id: number; name: string }; repo: string; port: number }): Promise<Made> {
  const { store } = app;
  const { name, title, idea, maker, repo, port } = a;
  const { appDir, generateApp } = await import('../kit/skills/contraption-ui/new-app/new-app.ts');
  const branch = (await run('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: project.repo_dir! }).catch(() => null))?.stdout.trim() || 'main';

  // The minion first: its branch gets the app as its first commit, before its brief can start a turn.
  const table = pickFor('feature');
  const { id, number } = await app.newMinion(project, { title: `New app: ${title}`, props: { type: 'feature', assigned: maker.name }, model: table.model, effort: table.effort }, by);
  const ticket = store.getTicket(id)!;
  let files: string[];
  try {
    files = generateApp({ repo: ticket.cwd!, name, title, idea, runner: schemeRunner(project, ticket.cwd!) });
    await run('git', ['add', '--', ...files], { cwd: ticket.cwd! });
    await run('git', ['commit', '--quiet', '--no-verify', '-m', `New app ${name}: the kit's starter (make_app, #1136)`], {
      cwd: ticket.cwd!,
      env: { ...process.env, GIT_AUTHOR_NAME: APP_NAME, GIT_AUTHOR_EMAIL: 'citadel@localhost', GIT_COMMITTER_NAME: APP_NAME, GIT_COMMITTER_EMAIL: 'citadel@localhost' },
    });
  } catch (err) {
    store.deleteTicket(id);
    await run('git', ['worktree', 'remove', '--force', ticket.cwd!], { cwd: project.repo_dir! }).catch(() => {});
    if (ticket.branch) await run('git', ['branch', '-D', ticket.branch], { cwd: project.repo_dir! }).catch(() => {});
    throw new HttpError(500, `Could not write the app: ${(err as Error).message}`);
  }

  app.contraptions.register({
    name, title, port, icon: '/icon.svg', home_scheme: project.id, open_paths: '[]', relay_paths: '[]', static_paths: null,
    default_model: null, turn_cap: null, repo, branch: branch === 'main' ? null : branch, folder: null, subdir: appDir(name),
  });
  const contraption = store.getContraption(name)!;
  for (const m of store.listMembers(project.id)) store.setContraptionUser(contraption.id, m.id, true, maker.id);
  void app.releases.refresh(true);
  addAppTurnsCheck(store, app.dataDir, project.id);

  store.updateTicket(id, { picked_because: pickReason('table', 'feature', table.model, table.effort), person_id: caller.person_id, parent: null });
  if (maker.id !== caller.person_id) store.setSetting(askerKey(id), maker.id);
  app.runner.send(id, by, brief({ name, title, idea, maker: maker.name, port, workflow: files.some((f) => f.startsWith('.github/')) }), [], { brief: true });
  return { name, port, minion: number, files: files.length, workflow: files.some((f) => f.startsWith('.github/')) };
}

/** The new minion's brief. */
export function brief(a: { name: string; title: string; idea: string; maker: string; port: number; workflow: boolean }): string {
  return [
    `Ship the new app ${a.title} (/apps/${a.name}/), then build what it is for.`,
    '',
    `The idea, in ${a.maker}'s words:`,
    '',
    ...a.idea.split('\n').map((l) => `> ${l}`),
    '',
    `make_app has registered it (port ${a.port}, deployed from apps/${a.name}/ of this repo) and switched it on for this scheme's members, and the first commit on your branch is the kit's starter: a server that checks who is signed in, migrations, a nightly backup, a health path and a first page on ${APP_NAME} UI${a.workflow ? ', with its own CI workflow' : ''}. Read apps/${a.name}/CLAUDE.md before anything else.`,
    '',
    `1. Run its tests: \`npm test\` in apps/${a.name}/: all pass on the starter.`,
    `2. Ship it as this scheme ships. The ship deploys it; if /apps/${a.name}/ isn't up after, call deploy_contraption for ${a.name}. Check the page says "Signed in as" you at 1440 and 390 px.`,
    `3. Then build the idea in apps/${a.name}/, following its CLAUDE.md and the citadel:contraption-ui skill. It is design-shaped, so grill ${a.maker} first with citadel:grilling, and ship in small steps.`,
  ].join('\n');
}

export interface Adopted {
  name: string;
  port: number;
  subdir: string | null;
  icon: string;
}

/** A folder of the repo from what a Taskmaster typed: "" and "." are the root (null); anything leaving the repo is refused. */
export function adoptFolder(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const parts = text.split('/').filter((p) => p !== '' && p !== '.');
  if (text.startsWith('/') || parts.includes('..') || /[\\\0]/.test(text)) throw new HttpError(400, 'folder must be a folder inside the repo, like apps/trip-notes ("" or "." for the repo root)');
  return parts.length ? parts.join('/') : null;
}

/**
 * adopt_app (#1624): register an app whose code is already on its scheme's main branch (citadel-app.json at the root or in
 * `folder`), as make_app does a new one (same checks, port, icon default and member switch) but with no minion and no
 * files written. The route starts its deploy afterwards (startDeploy lives with the routes).
 */
export async function adoptApp(app: App, project: Project, caller: Ticket, body: { name?: unknown; title?: unknown; folder?: unknown; repo?: unknown }): Promise<Adopted> {
  const { store } = app;
  const { TITLE } = await import('../kit/skills/contraption-ui/new-app/new-app.ts');
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!CONTRAPTION_NAME.test(name) || RESERVED.has(name) || SCHEME_CALLER.test(name)) throw new HttpError(400, 'name must be a short slug: lowercase letters, digits and dashes, like trip-notes');
  if (!TITLE.test(title)) throw new HttpError(400, 'title must be 1 to 60 letters, digits, spaces and simple punctuation');
  const subdir = adoptFolder(body.folder);
  const asker = store.turnAsker(caller.id);
  const maker = asker === null ? null : store.listMembers(project.id).find((m) => m.id === asker);
  if (!maker) throw new HttpError(403, `adopt_app runs only on a turn a member of ${project.name} asked for`);
  if (store.getContraption(name) || making.names.has(name)) throw new HttpError(409, `There is already an app called ${name}`);
  const repo = repoSlug(project.repo_url);
  if (!project.repo_dir || !repo) throw new HttpError(400, `${project.name} has no GitHub repo to keep the app in`);
  if (body.repo !== undefined && body.repo !== null && body.repo !== '' && String(body.repo).toLowerCase() !== repo.toLowerCase()) {
    throw new HttpError(400, `${body.repo} isn't ${project.name}'s repo (${repo}): adopt_app registers only apps in this scheme's own repo`);
  }
  const where = subdir ? `${subdir}/${MANIFEST}` : MANIFEST;
  if (!manifestOn(project.repo_dir, subdir ?? '', 'main')) throw new HttpError(404, `No ${where} on main in ${project.name}'s repo: ship it to main first`);
  making.names.add(name);
  let port = 0;
  try {
    try {
      parseManifest((await run('git', ['show', `main:${where}`], { cwd: project.repo_dir })).stdout);
    } catch (err) {
      throw new HttpError(400, `${where} on main isn't a usable manifest: ${(err as Error).message}`);
    }
    // /icon.svg only when the folder serves one at its usual places (its top or public/); else empty, and the deploy fills it from the app's web manifest (or says what is missing).
    const at = (f: string) => (subdir ? `${subdir}/${f}` : f);
    const found = (await run('git', ['ls-tree', '--name-only', 'main', '--', at('icon.svg'), at('public/icon.svg')], { cwd: project.repo_dir })).stdout.trim();
    const icon = found ? '/icon.svg' : '';
    port = await freeAppPort(new Set([...store.listContraptions().map((c) => c.port), ...making.ports]));
    making.ports.add(port);
    app.contraptions.register({
      name, title, port, icon, home_scheme: project.id, open_paths: '[]', relay_paths: '[]', static_paths: null,
      default_model: null, turn_cap: null, repo, branch: null, folder: null, subdir,
    });
    const contraption = store.getContraption(name)!;
    for (const m of store.listMembers(project.id)) store.setContraptionUser(contraption.id, m.id, true, maker.id);
    void app.releases.refresh(true);
    addAppTurnsCheck(store, app.dataDir, project.id);
    return { name, port, subdir, icon };
  } finally {
    making.names.delete(name);
    making.ports.delete(port);
  }
}
