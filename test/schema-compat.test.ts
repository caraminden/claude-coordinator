import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_HISTORY, SCHEMA_VERSION, Store } from '../src/db.ts';

// A deploy that fails rolls back to the last release, which then opens a database the new code has
// already migrated. That release's Store must still read and write it. The last release is the live
// checkout's last-good tag (deploy.sh tags it), or GitHub's main (deploy.sh pushes each live commit).
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'schema-compat-'));
after(() => rmSync(root, { recursive: true, force: true }));

// The live checkout's own tag first (deploy.sh moves it there): a worktree's clone can hold a last-good
// left from long ago, which would test a rollback to a release no deploy goes back to (#1169).
const live = process.env.DEPLOY_LIVE || join(homedir(), 'claude-coordinator');
const resolves = (dir: string, ref: string) => spawnSync('git', ['-C', dir, 'rev-parse', '-q', '--verify', `${ref}^{commit}`]).status === 0;
// Without the live checkout (a worker machine's turn, #2249), the repo's own tag only when GitHub's main isn't past it:
// deploy.sh pushes each live commit there, and that tag may be the stale one.
const newer = (dir: string, old: string, ref: string) => resolves(dir, ref) && spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', old, ref]).status === 0;
const release = ([[live, 'last-good'], ...(newer(repo, 'last-good', 'origin/main') ? [] : ([[repo, 'last-good']] as const)), [repo, 'origin/main']] as const).find(([dir, ref]) => resolves(dir, ref));
// A build's merge of main (tools/land.sh --into build/<n> --full) ships nothing and waits in the lands' line, where main
// may ship a newer schema past the main it took in (#2067). When the last release isn't under HEAD and this is that run,
// it is checked against the main it took in: land.sh's LAND_BUILD_BASE, or on CI (GITHUB_REF_NAME land/<branch>) where
// HEAD meets the main land.sh pushed beside it (land-base/<branch>). Any other run, --build (which merges main in)
// included, meets the last release as before, and a stale branch still hears to rebase.
const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
function buildBase(dir: string, releaseSha: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (releaseSha && git(dir, 'merge-base', '--is-ancestor', releaseSha, 'HEAD').status === 0) return undefined;
  if (env.LAND_BUILD_BASE) return env.LAND_BUILD_BASE;
  const name = env.GITHUB_REF_NAME ?? '';
  if (!name.startsWith('land/')) return undefined;
  const r = git(dir, 'merge-base', 'HEAD', `origin/land-base/${name.slice('land/'.length)}`);
  return r.status === 0 ? r.stdout.trim() : undefined;
}
const base = release && buildBase(repo, git(release[0], 'rev-parse', `${release[1]}^{commit}`).stdout.trim(), process.env);
const [prevRepo, prev] = base ? ([repo, resolves(repo, base) ? base : undefined] as const) : (release ?? [repo, undefined]);
const prevDir = join(root, 'prev');
mkdirSync(prevDir);
if (prev) execFileSync('sh', ['-c', 'git -C "$1" archive "$2" src public | tar -x -C "$3"', 'sh', prevRepo, prev, prevDir]);
// A branch whose base is older than the last release has a lower SCHEMA_VERSION; shipping that would be
// wrong, and the failures that follow look like the change broke compatibility. Say the real cause.
const staleBase = (ref: string | undefined, releaseVersion: number, branchVersion: number, build = false) =>
  releaseVersion > branchVersion
    ? build
      ? `this branch's schema is ${branchVersion}, older than the ${releaseVersion} of the main its build took in (${ref}): it lowers the schema.`
      : `this branch's schema is ${branchVersion}, older than the last release's ${releaseVersion} (${ref}): its base is behind. Rebase onto main.`
    : undefined;
const loadPrev = async () => {
  assert.ok(!base || resolves(repo, base), `the build's base ${base} is not a commit in ${repo}`);
  assert.ok(prev, 'no last-good tag or origin/main to find the last release by: fetch origin');
  const mod = await import(join(prevDir, 'src', 'db.ts'));
  const stale = staleBase(prev, mod.SCHEMA_VERSION ?? 0, SCHEMA_VERSION, !!base);
  assert.ok(!stale, stale!);
  return mod;
};

test("a build's merge of main is checked against the main it took in only when the last release isn't under it: land.sh's word, or on CI where HEAD meets land-base (#2067)", () => {
  const dir = join(root, 'base-repo');
  mkdirSync(dir);
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  const commit = (m: string) => (g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m), g('rev-parse', 'HEAD'));
  const took = commit('the main the build took in');
  const moved = commit('main ships a newer schema: the last release');
  g('checkout', '-q', '-b', 'ticket/9-build', took);
  commit("the build's own");
  const ci = { GITHUB_REF_NAME: 'land/ticket/9-build' };
  assert.equal(buildBase(dir, moved, { LAND_BUILD_BASE: took }), took, "the release moved past the build: land.sh's word");
  assert.equal(buildBase(dir, moved, ci), undefined, 'on CI with no land-base pushed: the last release (a stale branch hears to rebase)');
  g('update-ref', 'refs/remotes/origin/land-base/ticket/9-build', moved);
  assert.equal(buildBase(dir, moved, ci), took, "on CI, land-base at main's tip: where HEAD meets it");
  g('update-ref', 'refs/remotes/origin/land-base/ticket/9-build', took);
  assert.equal(buildBase(dir, moved, ci), took, 'land-base at the merge-base (the kit core pushes that): the same commit');
  assert.equal(buildBase(dir, moved, {}), undefined, 'not a land run, nor land.sh: the last release');
  assert.equal(buildBase(dir, moved, { GITHUB_REF_NAME: 'check/ticket/9-build' }), undefined);
  assert.equal(buildBase(dir, took, { ...ci, LAND_BUILD_BASE: took }), undefined, 'the last release under HEAD (every ship, --build too): the last release');
});

test('a base older than the last release says to rebase, with both schema numbers', () => {
  assert.equal(staleBase('last-good', 111, 110), "this branch's schema is 110, older than the last release's 111 (last-good): its base is behind. Rebase onto main.");
  assert.equal(staleBase('last-good', 110, 110), undefined);
  assert.equal(staleBase('last-good', 109, 110), undefined);
  assert.equal(staleBase('abc123', 111, 110, true), "this branch's schema is 110, older than the 111 of the main its build took in (abc123): it lowers the schema.");
});

// The shape a Store gives a new database: every table and index, as SQLite stores them.
const shape = (S: typeof Store, file: string) => {
  new S(file).db.close();
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  db.close();
  return rows;
};

test(`the last release's Store (${prev}) reads and writes a database this code has migrated`, async () => {
  const { Store: PrevStore, SCHEMA_VERSION: prevVersion = 0 } = await loadPrev();
  const file = join(root, 'coordinator.db'); // the live name: events.db beside it is the name every release looks for
  const now = new Store(file);
  const project = now.createProject('Compat', null);
  const ticket = now.createTicket({ project_id: project.id, title: 'Before', permission_mode: 'default', created_by: 'Cara' });
  now.addEvent(ticket.id, 'note', { text: 'written by this code' });
  now.putClaudeState({ path: 'projects/x/1.jsonl', project_id: project.id, ticket_id: ticket.id, size: 1, mtime: 1, data: new Uint8Array(1) });
  // A person note (#146) has no foreign key, so the last release can still delete its minion.
  const noted = now.createTicket({ project_id: project.id, title: 'Noted', permission_mode: 'default', created_by: 'Cara' });
  now.setPersonNote(noted.id, 'a note', 'Cara');
  now.db.prepare('UPDATE person_notes SET updated_at = 1 WHERE ticket_id = ?').run(noted.id); // well before the minion that reuses its id
  // So has a pin (#179).
  now.setTicketPinned('Cara', noted.id, true);
  now.db.prepare('UPDATE ticket_pins SET pinned_at = 1 WHERE ticket_id = ?').run(noted.id);
  now.db.close();

  const old = new PrevStore(file);
  assert.deepEqual(
    old.listProjects().map((p: { name: string }) => p.name),
    ['Compat'],
  );
  assert.equal(old.getTicket(ticket.id).title, 'Before');
  assert.equal(old.listEvents(ticket.id).at(-1).data, JSON.stringify({ text: 'written by this code' }));
  // Releases before state.db (version 2) look for session state in the main file: they find an empty
  // table there and refill it from Claude's config dir at start; the next release folds it back.
  assert.equal(old.listClaudeState(project.id, ticket.id).length, prevVersion < 2 ? 0 : 1);
  old.putClaudeState({ path: 'projects/x/2.jsonl', project_id: project.id, ticket_id: ticket.id, size: 1, mtime: 1, data: new Uint8Array(1) });
  old.listTickets(project.id);
  old.listArtifacts(project.id);
  old.listTurns(ticket.id);
  old.listMachines();
  old.listPushSubscriptions();
  old.props.forTarget('minion', ticket.id);
  old.schedules.list(project.id);
  old.deleteTicket(noted.id);
  const added = old.createTicket({ project_id: project.id, title: 'After rollback', permission_mode: 'default', created_by: 'Cara' });
  old.addEvent(added.id, 'note', { text: 'written by the last release' });
  old.db.close();

  const again = new Store(file); // and forward again, as the fixed deploy that follows would
  assert.equal(again.getTicket(added.id)!.title, 'After rollback');
  assert.equal(added.id, noted.id, 'the newest id is reused');
  assert.equal(again.personNotes(project.id)[added.id], undefined, "the deleted minion's note left behind doesn't show on the new one");
  assert.deepEqual(again.pinnedTickets('Cara', project.id), [], 'nor does its pin');
  assert.equal(again.getSetting('schema_version'), SCHEMA_VERSION);
  assert.deepEqual(
    again
      .listClaudeState(project.id, ticket.id)
      .map((r) => r.path)
      .sort(),
    ['projects/x/1.jsonl', 'projects/x/2.jsonl'],
    'sessions from both releases',
  );
  again.db.close();
});

test('a change to the database shape comes with a higher SCHEMA_VERSION than the last release', async () => {
  const mod = await loadPrev();
  if (JSON.stringify(shape(Store, join(root, 'now.db'))) === JSON.stringify(shape(mod.Store, join(root, 'prev.db')))) return;
  assert.ok(SCHEMA_VERSION > (mod.SCHEMA_VERSION ?? 0), `the tables differ from ${prev}'s: bump SCHEMA_VERSION in src/db.ts`);
});

test('a Store never lowers schema_version, so an older release left behind by a rollback leaves the newer number', () => {
  const file = join(root, 'newer.db');
  const s = new Store(file);
  s.setSetting('schema_version', SCHEMA_VERSION + 1);
  s.db.close();
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    const reopened = new Store(file);
    assert.equal(reopened.getSetting('schema_version'), SCHEMA_VERSION + 1);
    reopened.db.close();
  } finally {
    console.warn = warn;
  }
  assert.match(warned.join('\n'), /newer than this code's .*pre-deploy/);
});

test('SCHEMA_HISTORY numbers rise by one with no gaps or repeats', () => {
  SCHEMA_HISTORY.forEach(([n], i) => assert.equal(n, SCHEMA_HISTORY[0][0] + i));
});
