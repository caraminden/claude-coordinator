import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { restoreTicketDir } from '../src/workspace.ts';

const root = mkdtempSync(join(tmpdir(), 'prune-'));
after(() => rmSync(root, { recursive: true, force: true }));

const prune = join(import.meta.dirname, '..', 'deploy', 'prune.sh');
const backup = join(import.meta.dirname, '..', 'deploy', 'backup.sh');
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const run = (script: string, ...args: string[]) => execFileSync(script, args, { env: { ...process.env, DATA_DIR: root }, encoding: 'utf8' });

const store = new Store(join(root, 'coordinator.db'));
const project = store.createProject('Demo', null);
const repo = join(root, 'projects', String(project.id), 'repo');
mkdirSync(repo, { recursive: true });
git(['init', '--quiet', '-b', 'main'], repo);
git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'init'], repo);
store.setProjectRepoDir(project.id, repo);

const DAY = 86_400_000;
function minion(title: string, closedDaysAgo: number | null) {
  const t = store.createTicket({ project_id: project.id, title, permission_mode: 'default', created_by: 't' });
  const cwd = join(root, 'projects', String(project.id), 'tickets', String(t.id));
  const branch = `ticket/${t.number}-x`;
  git(['worktree', 'add', '--quiet', '-b', branch, cwd], repo);
  store.setTicketDir(t.id, cwd, branch);
  store.putClaudeState({ path: `projects/x/${t.id}.jsonl`, project_id: project.id, ticket_id: t.id, size: 3, mtime: 1, data: new Uint8Array(1000) });
  if (closedDaysAgo !== null) {
    store.updateTicket(t.id, { status: 'closed' });
    store.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(Date.now() - closedDaysAgo * DAY, t.id);
  }
  return { id: t.id, number: t.number, cwd, branch };
}
const old = minion('old', 40); // past both cutoffs
const mid = minion('mid', 20); // state goes, worktree stays
const fresh = minion('fresh', 2);
const open = minion('open', null);
const dirty = minion('dirty', 40);
writeFileSync(join(dirty.cwd, 'wip.txt'), 'unsaved');
const stateOf = (id: number) => store.listClaudeState(project.id, id).length;

test('a dry run lists what it would prune and changes nothing', () => {
  const out = run(prune);
  assert.match(out, new RegExp(`Would delete: Demo #${old.number}, 1 files`));
  assert.match(out, new RegExp(`Would delete: Demo #${mid.number}, 1 files`));
  assert.doesNotMatch(out, new RegExp(`#${fresh.number},`));
  assert.match(out, new RegExp(`Would delete: Demo #${old.number}, ${old.cwd}`));
  assert.match(out, new RegExp(`Skipping \\(uncommitted changes\\): Demo #${dirty.number}`));
  assert.ok(existsSync(old.cwd));
  assert.equal(stateOf(old.id), 1);
});

test('--apply drops old session state and old clean worktrees, keeping branches', () => {
  run(prune, '--apply');
  assert.equal(stateOf(old.id), 0);
  assert.equal(stateOf(mid.id), 0);
  assert.equal(stateOf(fresh.id), 1);
  assert.equal(stateOf(open.id), 1);
  assert.ok(!existsSync(old.cwd));
  assert.ok(existsSync(mid.cwd) && existsSync(dirty.cwd) && existsSync(fresh.cwd));
  assert.ok(git(['branch', '--list', old.branch], repo).includes(old.branch));
});

test('a reopened minion gets its worktree back from its branch', () => {
  assert.equal(restoreTicketDir(old.cwd, repo, old.branch), true);
  assert.equal(git(['branch', '--show-current'], old.cwd), old.branch);
  assert.equal(restoreTicketDir(old.cwd, repo, old.branch), false);
  assert.equal(restoreTicketDir(join(root, 'nowhere'), null, null), false);
});

test('ad-hoc copies go only once a nightly backup restores, and the backup is private', () => {
  const stale = join(root, 'coordinator.db.bak-machines');
  writeFileSync(stale, 'x');
  assert.match(run(prune, '--apply', '--stale-backups'), /Keeping them/);
  assert.ok(existsSync(stale));

  assert.match(run(backup), /Backed up to .*coordinator-\d{4}-\d\d-\d\d\.db/);
  const mode = execFileSync('stat', ['-c', '%a', join(root, 'backups')], { encoding: 'utf8' }).trim();
  assert.equal(mode, '700');
  assert.match(run(prune, '--stale-backups'), /Would delete: coordinator\.db\.bak-machines/);
  assert.ok(existsSync(stale));
  run(prune, '--apply', '--stale-backups');
  assert.ok(!existsSync(stale));
});

test('the nightly backup drops hand-made before-* copies once they are 7 days old', () => {
  const dir = join(root, 'backups');
  const old = join(dir, 'coordinator-before-old.db');
  const recent = join(dir, 'coordinator-before-recent.db');
  const deploy = join(dir, 'pre-deploy-abc1234.db');
  for (const f of [old, recent, deploy]) writeFileSync(f, 'x');
  const days = (n: number) => (Date.now() - n * DAY) / 1000;
  utimesSync(old, days(8), days(8));
  utimesSync(recent, days(6), days(6));
  utimesSync(deploy, days(30), days(30));
  run(backup);
  assert.ok(!existsSync(old));
  assert.ok(existsSync(recent));
  assert.ok(existsSync(deploy), "deploy.sh's own copies are its to rotate");
});

test('the nightly prune timer deletes stale copies too', () => {
  const unit = readFileSync(join(import.meta.dirname, '..', 'deploy', 'claude-coordinator-prune.service'), 'utf8');
  assert.match(unit, /^ExecStart=.*prune\.sh --apply --stale-backups$/m);
});
