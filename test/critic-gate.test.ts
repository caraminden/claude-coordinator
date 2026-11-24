import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { criticRefusal, matchedFiles, missingCritics } from '../src/critic-gate.ts';
import { parseWhen, ReviewSet, whenText } from '../src/review-set.ts';

const root = mkdtempSync(join(tmpdir(), 'critic-gate-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES (3, 'Peek Auras'), (9, 'Genesis Tree');");
  return new ReviewSet(db);
}

test('a when: line takes lines, only with diff globs', () => {
  const t = parseWhen('diff: public/**/*.css, docs/** | lines: 10 | ask');
  assert.deepEqual(t, { diff: ['public/**/*.css', 'docs/**'], lines: 10, ask: true });
  assert.equal(whenText(t), 'diff: public/**/*.css, docs/** | lines: 10 | ask');
  assert.throws(() => parseWhen('diff: a/** | lines: ten'), /whole number/);
  const set = fresh();
  assert.throws(() => set.create(3, { slug: 'ui', name: 'UI', triggers: { lines: 10 } }, 'Josh'), /goes with diff/);
  assert.throws(() => set.create(3, { slug: 'ui', name: 'UI', triggers: { diff: ['a/**'], lines: 0 } }, 'Josh'), /from 1/);
});

test('matching: globs, then the lines threshold over the matched files only', () => {
  const files = [{ path: 'public/app.css', lines: 6 }, { path: 'public/x/page.html', lines: 5 }, { path: 'src/server.ts', lines: 400 }];
  assert.deepEqual(matchedFiles({ triggers: { diff: ['public/**/*.css', 'public/**/*.html'] } }, files).map((f) => f.path), ['public/app.css', 'public/x/page.html']);
  assert.equal(matchedFiles({ triggers: { diff: ['public/**/*.css', 'public/**/*.html'], lines: 11 } }, files).length, 2, '6 + 5 lines reach 11');
  assert.equal(matchedFiles({ triggers: { diff: ['public/**/*.css', 'public/**/*.html'], lines: 12 } }, files).length, 0, "the server file's lines don't count");
  assert.equal(matchedFiles({ triggers: { diff: ['web/**'] } }, files).length, 0);
  assert.equal(matchedFiles({ triggers: { creative: 'new art' } }, files).length, 0, 'no diff globs, no match');
  assert.equal(matchedFiles({ triggers: { diff: ['public/**'] } }, [{ path: 'public/icon.png', lines: 0 }]).length, 1, 'a binary file matches with no lines threshold');
});

test('which critics a ship needs a run of: on, off trial, kind critic, not yet run by this minion', () => {
  const set = fresh();
  set.create(3, { slug: 'ui', name: 'UI critic', triggers: { diff: ['public/**'] } }, 'Josh');
  set.create(3, { slug: 'look', name: 'Look', triggers: { diff: ['public/**'] }, trial: true }, 'Josh');
  set.create(3, { slug: 'off', name: 'Off', triggers: { diff: ['public/**'] }, enabled: false }, 'Josh');
  set.create(3, { slug: 'rev', name: 'Reviewer', kind: 'reviewer', triggers: { diff: ['public/**'] } }, 'Josh');
  set.create(9, { slug: 'ui', name: 'Other scheme', triggers: { diff: ['public/**'] } }, 'Josh');
  const files = [{ path: 'public/a.css', lines: 3 }];
  assert.deepEqual(missingCritics(set.list(3), set.ranOn(3, 40), files).map((m) => m.slug), ['ui']);
  set.recordRun(9, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' });
  set.recordRun(3, 'ui', { ticketId: 41, minion: '#41', round: 1, verdict: 'pass' });
  assert.equal(missingCritics(set.list(3), set.ranOn(3, 40), files).length, 1, "another scheme's or another minion's run doesn't count");
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  assert.equal(missingCritics(set.list(3), set.ranOn(3, 40), files).length, 0, 'any verdict is a run on record (a blocking fail is holds()\'s)');
});

test('the hand-off refusal over a real branch: names the critic and its files, lets a run, a build and a fix through', async () => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'public'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket/40');
  writeFileSync(join(repo, 'public', 'app.css'), 'a{}\n'.repeat(12));
  git('add', '.'); git('commit', '-qm', 'css');
  const set = fresh();
  set.create(3, { slug: 'ui', name: 'UI critic', triggers: { diff: ['public/**/*.css'], lines: 10 }, gate: 'block' }, 'Josh');
  const ticket = { id: 40, project_id: 3, cwd: repo };
  const why = await criticRefusal(set, ticket, [], false);
  assert.match(why ?? '', /^Not handed off: this change matches UI critic \(`ui`, 12 lines in public\/app\.css\)/);
  assert.match(why ?? '', /citadel:critique/);
  assert.match(why ?? '', /needs a pass/, 'a blocking critic says it needs a pass');
  assert.equal(await criticRefusal(set, ticket, ['--build'], false), null, "a build's own ship: its feeders ran theirs");
  assert.equal(await criticRefusal(set, ticket, [], true), null, "a rolled-back deploy's fix doesn't wait");
  assert.equal(await criticRefusal(set, { ...ticket, project_id: 9 }, [], false), null, 'a scheme with no critic on');
  set.save(3, 'ui', { triggers: { diff: ['public/**/*.css'], lines: 13 } }, 'Josh', 'x');
  assert.equal(await criticRefusal(set, ticket, [], false), null, 'under its lines threshold');
  set.save(3, 'ui', { triggers: { diff: ['public/**/*.css'] } }, 'Josh', 'x');
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' });
  assert.equal(await criticRefusal(set, ticket, [], false), null, 'its run is on record');
  assert.equal(await criticRefusal(set, { ...ticket, cwd: join(root, 'nowhere') }, [], false), null, "a diff git can't read never holds a ship");
});

test('a change that only touches comments or blank lines in a file asks no critic of it (Cara, 2026-11-24, "Skip comment-only edits")', async () => {
  const repo = join(root, 'comments');
  mkdirSync(join(repo, 'public'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'public', 'app.js'), 'const a = 1;\n');
  writeFileSync(join(repo, 'public', 'app.css'), 'a { color: red; }\n');
  git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket/41');
  writeFileSync(join(repo, 'public', 'app.js'), '// why a is 1\n/* see\n * the glossary\n */\n\nconst a = 1;\n');
  writeFileSync(join(repo, 'public', 'app.css'), '/* red on purpose */\na { color: red; }\n<!-- x -->\n');
  git('add', '.'); git('commit', '-qm', 'comments');
  const set = fresh();
  set.create(3, { slug: 'ui', name: 'UI critic', triggers: { diff: ['public/**'] }, gate: 'advise' }, 'Josh');
  const ticket = { id: 41, project_id: 3, cwd: repo };
  assert.equal(await criticRefusal(set, ticket, [], false), null, 'comments and blank lines only');
  writeFileSync(join(repo, 'public', 'app.css'), '/* red on purpose */\na { color: red; }\n* { margin: 0 }\n');
  git('add', '.'); git('commit', '-qm', 'a universal selector is code, not a comment');
  assert.match((await criticRefusal(set, ticket, [], false)) ?? '', /UI critic \(`ui`, \d+ lines in public\/app\.css\)/, 'the code file still asks; the comment-only one is left out');
  assert.doesNotMatch((await criticRefusal(set, ticket, [], false)) ?? '', /app\.js/);
});
