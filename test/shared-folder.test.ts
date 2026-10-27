import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findArtifacts } from '../src/artifacts.ts';
import { coordinatorAccess, systemPrompt } from '../src/runner.ts';
import { projectSlug } from '../src/sessions.ts';
import { projectSharedDir } from '../src/workspace.ts';

const root = mkdtempSync(join(tmpdir(), 'shared-folder-'));
after(() => rmSync(root, { recursive: true, force: true }));

const repo = join(root, 'projects', '2', 'repo');
const tickets = join(root, 'projects', '2', 'tickets');
const shared = projectSharedDir(root, 2);
const memory = join(root, '.claude', 'projects', projectSlug(repo), 'memory');
const project = { id: 2, name: 'Demo', repo_dir: repo, instructions: '' } as any;
const ticket = { id: 9, kind: 'ticket', number: 3, title: 'Try it', branch: 'ticket/3-try-it' } as any;
const coordinator = { ...ticket, kind: 'coordinator' };

test('the project shared folder sits beside the per-ticket ones and cannot clash with them', () => {
  assert.equal(shared, join(root, 'projects', '2', 'shared', 'project'));
});

test('Claude Code names the memory folder by turning every non-alphanumeric character into a dash', () => {
  assert.equal(projectSlug('/home/cara/.local/share/claude-coordinator/projects/2/repo'), '-home-cara--local-share-claude-coordinator-projects-2-repo');
});

test('the coordinator adds the shared and memory folders without denying edits there', () => {
  const { addDirs, settings } = coordinatorAccess(repo, tickets, shared, memory) as any;
  assert.deepEqual(addDirs, [repo, tickets, shared, memory]);
  const { deny, allow } = settings.permissions;
  assert.deepEqual(deny.filter((r: string) => r.startsWith('Edit(')), [`Edit(/${repo}/**)`, `Edit(/${tickets}/**)`]);
  assert.ok(!deny.some((r: string) => r.includes(shared) || r.includes(memory)));
  // Still no shell: the only Bash rules are the read-only ones.
  assert.ok(allow.every((r: string) => r.startsWith('Bash(') && !/\b(commit|push|checkout)\b/.test(r)));
});

test('without a repo there is no memory folder to add', () => {
  const { addDirs } = coordinatorAccess(null, tickets, shared, null);
  assert.deepEqual(addDirs, [tickets, shared]);
});

test('threads and the coordinator are told where the shared folder is and what goes in it', () => {
  for (const t of [ticket, coordinator]) {
    const prompt = systemPrompt(project, t, join(root, 'shared', '9'), shared, tickets, memory);
    const line = prompt.split('\n').find((l) => l.startsWith(shared));
    assert.ok(line, `${t.kind} prompt names ${shared}`);
    assert.match(line, /handoffs, specs and notes/i);
    assert.match(line, /scratch files, build output and secrets/);
  }
  assert.ok(!systemPrompt(project, ticket, null, null, tickets, null).includes('every thread in the project'));
});

test('only the coordinator is told about its memory folder', () => {
  assert.ok(systemPrompt(project, coordinator, null, shared, tickets, memory).includes(memory));
  assert.ok(!systemPrompt(project, ticket, null, shared, tickets, null).includes('Claude Code memory'));
});

test('the Shared group lists documents and pages only', async () => {
  mkdirSync(join(shared, 'notes'), { recursive: true });
  for (const f of ['handoff.md', 'notes/design.html', 'data.csv', 'shot.png', 'run.ts']) writeFileSync(join(shared, f), 'x');
  const found = await findArtifacts(shared, false);
  assert.deepEqual(found.map((f) => f.path).sort(), ['handoff.md', 'notes/design.html']);
});
