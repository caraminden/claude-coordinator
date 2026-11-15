import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findArtifacts, MAX_SHARED_FILES, sharedListable } from '../src/artifacts.ts';
import { coordinatorAccess } from '../src/turn-launch.ts';
import { systemPrompt } from '../src/prompts.ts';
import { mergeMemory, projectSlug } from '../src/sessions.ts';
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

test('Claude Code names the memory folder by turning every non-alphanumeric character into a dash', () => {
  assert.equal(projectSlug('/home/cara/.local/share/claude-coordinator/projects/2/repo'), '-home-cara--local-share-claude-coordinator-projects-2-repo');
});

test('the coordinator adds the shared and memory folders without denying edits there', () => {
  const { addDirs, settings } = coordinatorAccess(repo, tickets, shared, memory) as any;
  assert.deepEqual(addDirs, [repo, tickets, shared, memory]);
  const { deny, allow } = settings.permissions;
  assert.deepEqual(deny.filter((r: string) => r.startsWith('Edit(')), [`Edit(/${repo}/**)`, `Edit(/${tickets}/**)`]);
  assert.ok(!deny.some((r: string) => r.includes(shared) || r.includes(memory)));
  // Still no writing shell: besides the web tools (#210), the only rules are read-only Bash and Read ones (#483).
  const bash = allow.filter((r: string) => r !== 'WebSearch' && r !== 'WebFetch');
  assert.equal(bash.length, allow.length - 2);
  assert.ok(bash.every((r: string) => (r.startsWith('Bash(') || r.startsWith('Read(')) && !/\b(commit|push|checkout)\b/.test(r)));
  // Claude Code refuses allow rules for files under ~/.claude; only its auto-memory folder is writable (#98).
  assert.equal(settings.autoMemoryDirectory, memory);
});

test("the Taskmaster's old memory folds into the repo memory once, keeping what is there", () => {
  const old = join(root, 'merge', 'old');
  const repoMem = join(root, 'merge', 'repo');
  mkdirSync(old, { recursive: true });
  mkdirSync(repoMem, { recursive: true });
  writeFileSync(join(old, 'MEMORY.md'), '- [Naming](naming.md) — names\n- [Shared](shared.md) — same note\n- [Clash](clash.md) — mine\n');
  writeFileSync(join(old, 'naming.md'), 'naming');
  writeFileSync(join(old, 'shared.md'), 'same');
  writeFileSync(join(old, 'clash.md'), 'taskmaster version');
  writeFileSync(join(repoMem, 'MEMORY.md'), '- [Shared](shared.md) — same note\n- [Clash](clash.md) — theirs');
  writeFileSync(join(repoMem, 'shared.md'), 'same');
  writeFileSync(join(repoMem, 'clash.md'), 'repo version');

  assert.equal(mergeMemory(old, repoMem), 2);
  assert.equal(readFileSync(join(repoMem, 'naming.md'), 'utf8'), 'naming');
  assert.equal(readFileSync(join(repoMem, 'clash.md'), 'utf8'), 'repo version');
  assert.equal(readFileSync(join(repoMem, 'taskmaster-clash.md'), 'utf8'), 'taskmaster version');
  assert.equal(readFileSync(join(repoMem, 'MEMORY.md'), 'utf8'), '- [Shared](shared.md) — same note\n- [Clash](clash.md) — theirs\n- [Naming](naming.md) — names\n- [Clash](taskmaster-clash.md) — mine\n');
  // The old folder is set aside, so a note deleted later doesn't come back.
  assert.ok(!existsSync(old));
  assert.equal(readdirSync(join(root, 'merge')).filter((n) => n.startsWith('old-merged-')).length, 1);
  assert.equal(mergeMemory(old, repoMem), 0);
});

test('without a repo there is no memory folder to add', () => {
  const { addDirs } = coordinatorAccess(null, tickets, shared, null);
  assert.deepEqual(addDirs, [tickets, shared]);
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

test('the Files view also lists pictures, clips and sound from the shared folder, never code, data or hidden folders (#676)', async () => {
  mkdirSync(join(shared, '.cache'), { recursive: true });
  mkdirSync(join(shared, 'inbox'), { recursive: true });
  for (const f of ['clip.mp4', 'theme.mp3', 'mockkit.js', '.cache/old.png', 'inbox/log.txt', 'inbox/fixture.json']) writeFileSync(join(shared, f), 'x');
  const found = await findArtifacts(shared, false, sharedListable, MAX_SHARED_FILES);
  // inbox/ also lists the text and data people upload there.
  assert.deepEqual(found.map((f) => f.path).sort(), ['clip.mp4', 'handoff.md', 'inbox/fixture.json', 'inbox/log.txt', 'notes/design.html', 'shot.png', 'theme.mp3']);
});

test('the walk counts only the files it keeps toward its cap, so a folder full of other files hides none', async () => {
  const dir = join(root, 'crowded');
  mkdirSync(join(dir, 'a'), { recursive: true });
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, 'a', `data-${i}.json`), 'x');
  writeFileSync(join(dir, 'z.md'), 'x');
  assert.deepEqual((await findArtifacts(dir, false, sharedListable, 1)).map((f) => f.path), ['z.md']);
});
