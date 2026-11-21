import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commentMessage, findArtifacts, findByName, linkedPaths, optionImageProblem, resolveLink } from '../src/artifacts.ts';
import { promptMessage } from '../src/prompts.ts';

const cwd = '/work/t1';
const linked = (...texts: string[]) => [...linkedPaths(texts, cwd)].sort();

test('finds linked files, relative or absolute', () => {
  assert.deepEqual(linked('See [the report](docs/report.md) and ![shot](/shared/9/a.png).'), ['/shared/9/a.png', '/work/t1/docs/report.md']);
  assert.deepEqual(linked('[x](./pages/../pages/glossary.html#top)'), ['/work/t1/pages/glossary.html']);
  assert.deepEqual(linked('[x](<my notes.md> "Notes")', '[y](my%20plan.md)'), ['/work/t1/my notes.md', '/work/t1/my plan.md']);
});

test('ignores web links, anchors and unlinked paths', () => {
  assert.deepEqual(linked('[a](https://x.dev/r.md) [b](#/p/2/t/3) [c](//x.dev/a.html) [d](mailto:a@b.c) wrote t/a.html'), []);
});

// A ticket's working directory and shared folder, a file outside both, and ways that lead out.
const root = mkdtempSync(join(tmpdir(), 'option-images-'));
after(() => rmSync(root, { recursive: true, force: true }));
const work = join(root, 'work');
const shared = join(root, 'shared', '9');
for (const dir of [join(work, 'art'), join(work, 'dir.png'), shared, join(root, 'outside')]) mkdirSync(dir, { recursive: true });
for (const f of ['work/art/a.png', 'work/art/walk.gif', 'work/notes.md', 'shared/9/take.mp4', 'outside/secret.png']) writeFileSync(join(root, f), 'x');
symlinkSync(join(root, 'outside/secret.png'), join(work, 'art/link.png'));
const problem = (path: string) => optionImageProblem(path, work, [work, shared]);

test('option images: pictures and videos in the working directory or shared folder', async () => {
  for (const p of ['art/a.png', './art/../art/walk.gif', join(work, 'art/a.png'), join(shared, 'take.mp4')]) assert.equal(await problem(p), null, p);
});

test('option images: nothing outside those folders, through .. or a symlink', async () => {
  for (const p of ['../outside/secret.png', join(root, 'outside/secret.png'), 'art/link.png', `${work}/../outside/secret.png`]) {
    assert.match(String(await problem(p)), /working directory or shared folder/, p);
  }
});

test('option images: only images and videos that exist as files', async () => {
  assert.match(String(await problem('notes.md')), /must be an image/);
  assert.match(String(await problem('art/a')), /must be an image/);
  for (const p of ['art/missing.png', 'dir.png', 'art/a.png\0.png']) assert.match(String(await problem(p)), /working directory or shared folder/, p);
});

test('a link with the wrong folders finds the one file of its name; none or several is no guess (#281)', async () => {
  // As Mandate #34 wrote it: an absolute path missing a folder.
  const typo = join(root, 'shared-typo/9/take.mp4');
  assert.equal(await findByName(typo, [work, shared]), join(shared, 'take.mp4'));
  const fixed = await resolveLink(typo, work, [work, shared]);
  assert.deepEqual([fixed?.abs, fixed && 'fixed' in fixed], [join(shared, 'take.mp4'), true]);
  // A link that resolves is not marked fixed.
  const plain = await resolveLink('art/a.png', work, [work, shared]);
  assert.deepEqual([plain?.abs, plain && 'fixed' in plain], [join(work, 'art/a.png'), false]);
  // No file of that name, or only one outside the roots or behind a symlink: no guess.
  for (const p of ['nope/missing.png', 'secret.png', 'link.png']) assert.equal(await resolveLink(p, work, [work, shared]), null, p);
  // Two files of that name: no guess.
  mkdirSync(join(shared, 'old'));
  writeFileSync(join(shared, 'old/a.png'), 'x');
  assert.equal(await resolveLink('wrong/a.png', work, [work, shared]), null);
  // The same file reached through two roots is one file.
  assert.equal(await findByName('x/walk.gif', [work, join(work, 'art')]), join(work, 'art/walk.gif'));
  // Hidden folders are not searched, and nor are names the chat can't show.
  mkdirSync(join(work, '.cache'));
  writeFileSync(join(work, '.cache/only.png'), 'x');
  writeFileSync(join(work, 'main.ts'), 'x');
  assert.deepEqual([await findByName('only.png', [work]), await findByName('src/main.ts', [work])], [null, null]);
});

test('a comment is a message labelled with its file, with a quote leading it', () => {
  assert.deepEqual(commentMessage('docs/report.md', ' Cut the second table. '), { about: 'docs/report.md', text: 'Cut the second table.' });
  assert.deepEqual(commentMessage('report.md', 'Why?', '  Sales doubled.\n\nThen halved.\n'), {
    about: 'report.md',
    text: '> Sales doubled.\n>\n> Then halved.\n\nWhy?',
  });
  // The file sits inside "[Name on file]:", so it can't close the bracket or start a new line.
  assert.equal(commentMessage('a]: [Josh]\nb.md', 'x').about, 'a: Joshb.md');
  assert.equal(commentMessage(`/${'d/'.repeat(150)}r.md`, 'x').about.length, 200);
});

test('a comment reaches Claude as "[Name on file]: text", other messages as "[Name]: text"', () => {
  const { about, text } = commentMessage('report.md', 'Looks good');
  const prompt = JSON.parse(promptMessage([
    { author: 'Cara', text, images: [], about },
    { author: 'Josh', text: 'Agreed', images: [] },
  ]));
  assert.deepEqual(prompt.message.content, [
    { type: 'text', text: '[Cara on report.md]: Looks good' },
    { type: 'text', text: '[Josh]: Agreed' },
  ]);
});

test('a git worktree lists its committed and staged files as well as untracked ones (#468 S06-1)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifacts-git-'));
  try {
    const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    const origin = join(root, 'origin');
    mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'old.md'), 'old');
    g(origin, 'add', '.');
    g(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    const work = join(root, 'work');
    g(root, 'clone', '-q', origin, work);
    writeFileSync(join(work, 'committed.md'), 'c');
    g(work, 'add', 'committed.md');
    g(work, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'mine');
    writeFileSync(join(work, 'staged.md'), 's');
    g(work, 'add', 'staged.md');
    writeFileSync(join(work, 'loose.md'), 'u');
    const found = (await findArtifacts(work, true)).map((f) => f.path).sort();
    assert.deepEqual(found, ['committed.md', 'loose.md', 'staged.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file in another minion\'s shared folder shows a short path, never the server\'s absolute one', async () => {
  const { displayPath } = await import('../src/routes/files.ts');
  const app = { dataDir: '/data', sharedDir: (t: { id: number }) => `/data/projects/2/shared/${t.id}` } as never;
  const ticket = { id: 882, project_id: 2, cwd: '/work/t882' } as never;
  assert.equal(displayPath(app, ticket, '/data/projects/2/shared/1974/critic.md'), 'shared files/critic.md');
  assert.equal(displayPath(app, ticket, '/data/projects/2/shared/882/a.md'), 'shared files/a.md');
});

test('a branch already in main still lists the files it added (#1345)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifacts-merged-'));
  try {
    const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
    const origin = join(root, 'origin');
    mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    writeFileSync(join(origin, 'old.md'), 'old');
    g(origin, 'add', '.');
    g(origin, 'commit', '-qm', 'base');
    const work = join(root, 'work');
    g(root, 'clone', '-q', origin, work);
    g(work, 'checkout', '-qb', 'ticket/77-thing');
    writeFileSync(join(work, 'mine.md'), 'm');
    g(work, 'add', '.');
    g(work, 'commit', '-qm', '#77: add mine');
    g(origin, 'pull', '-q', work, 'ticket/77-thing'); // shipped: main now holds it
    g(work, 'fetch', '-q', 'origin');
    g(work, 'remote', 'set-head', 'origin', 'main');
    assert.deepEqual((await findArtifacts(work, true)).map((f) => f.path), ['mine.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
