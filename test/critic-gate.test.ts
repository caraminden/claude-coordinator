import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { commentOnlyFiles, criticRefusal, matchedFiles, missingCritics } from '../src/critic-gate.ts';
import { parseWhen, ReviewSet, whenText } from '../src/review-set.ts';

const root = mkdtempSync(join(tmpdir(), 'critic-gate-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES (3, 'Peek Auras'), (9, 'Genesis Tree');");
  return new ReviewSet(db);
}

test('a !glob in diff: leaves non-UI served files out, and UI modules, css and html still fire (#2246)', () => {
  const t = { diff: ['public/**', '!public/*.mjs'] };
  const hit = (path: string) => matchedFiles({ triggers: t }, [{ path, lines: 4 }]).length;
  assert.equal(hit('public/runner-agent.mjs'), 0);
  assert.equal(hit('public/machine-worker.mjs'), 0);
  assert.equal(hit('public/machine-worker-row.js'), 1);
  assert.equal(hit('public/app.css'), 1);
  assert.equal(hit('public/x/page.html'), 1);
  assert.deepEqual(parseWhen('diff: public/**, !public/*.mjs'), { diff: ['public/**', '!public/*.mjs'] });
});

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
  const files = [
    { path: 'public/app.css', lines: 6 },
    { path: 'public/x/page.html', lines: 5 },
    { path: 'src/server.ts', lines: 400 },
  ];
  assert.deepEqual(
    matchedFiles({ triggers: { diff: ['public/**/*.css', 'public/**/*.html'] } }, files).map((f) => f.path),
    ['public/app.css', 'public/x/page.html'],
  );
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
  assert.deepEqual(
    missingCritics(set.list(3), set.ranOn(3, 40), files).map((m) => m.slug),
    ['ui'],
  );
  set.recordRun(9, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' });
  set.recordRun(3, 'ui', { ticketId: 41, minion: '#41', round: 1, verdict: 'pass' });
  assert.equal(missingCritics(set.list(3), set.ranOn(3, 40), files).length, 1, "another scheme's or another minion's run doesn't count");
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  assert.equal(missingCritics(set.list(3), set.ranOn(3, 40), files).length, 0, "any verdict is a run on record (a blocking fail is holds()'s)");
});

test('the hand-off refusal over a real branch: names the critic and its files, lets a run, a build and a fix through', async () => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'public'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'x\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket/40');
  writeFileSync(join(repo, 'public', 'app.css'), 'a{}\n'.repeat(12));
  git('add', '.');
  git('commit', '-qm', 'css');
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
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket/41');
  writeFileSync(join(repo, 'public', 'app.js'), '// why a is 1\n/* see\n * the glossary\n */\n\nconst a = 1;\n');
  writeFileSync(join(repo, 'public', 'app.css'), '/* red on purpose */\na { color: red; }\n<!-- x -->\n');
  git('add', '.');
  git('commit', '-qm', 'comments');
  const set = fresh();
  set.create(3, { slug: 'ui', name: 'UI critic', triggers: { diff: ['public/**'] }, gate: 'advise' }, 'Josh');
  const ticket = { id: 41, project_id: 3, cwd: repo };
  assert.equal(await criticRefusal(set, ticket, [], false), null, 'comments and blank lines only');
  writeFileSync(join(repo, 'public', 'app.css'), '/* red on purpose */\na { color: red; }\n* { margin: 0 }\n');
  git('add', '.');
  git('commit', '-qm', 'a universal selector is code, not a comment');
  assert.match((await criticRefusal(set, ticket, [], false)) ?? '', /UI critic \(`ui`, \d+ lines in public\/app\.css\)/, 'the code file still asks; the comment-only one is left out');
  assert.doesNotMatch((await criticRefusal(set, ticket, [], false)) ?? '', /app\.js/);
});

test('a JSDoc-only front-end change, a cast and its parentheses included, asks no critic; a code change on the same line does (#2143)', async () => {
  const repo = join(root, 'jsdoc');
  mkdirSync(join(repo, 'public'), { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'public', 'app.js'), 'function f(a) {\n  const el = document.querySelector("#x");\n  el.value = a;\n}\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'ticket/42');
  writeFileSync(join(repo, 'public', 'app.js'), '/** @param {string} a */\nfunction f(a) {\n  const el = /** @type {HTMLInputElement} */ (document.querySelector("#x"));\n  el.value = a;\n}\n');
  git('commit', '-qam', 'types');
  const set = fresh();
  set.create(3, { slug: 'ui', name: 'UI critic', triggers: { diff: ['public/**'] }, gate: 'advise' }, 'Josh');
  const ticket = { id: 42, project_id: 3, cwd: repo };
  assert.equal(await criticRefusal(set, ticket, [], false), null, 'JSDoc and a cast only');
  writeFileSync(join(repo, 'public', 'app.js'), '/** @param {string} a */\nfunction f(a) {\n  const el = /** @type {HTMLInputElement} */ (document.querySelector("#y"));\n  el.value = a;\n}\n');
  git('commit', '-qam', 'code on the cast line');
  assert.match((await criticRefusal(set, ticket, [], false)) ?? '', /UI critic \(`ui`, \d+ lines in public\/app\.js\)/);
});

test('a comment with code beside it, or a new /* */ wrapped round untouched code, is code: it can hide what a page draws', () => {
  const patch = (name: string, hunk: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunk}`;
  const only = (p: string) => [...commentOnlyFiles(p)];
  // Whole comments, a multi-line block included, and blank lines skip.
  assert.deepEqual(only(patch('a.css', '@@ -1,0 +1,4 @@\n+/* new\n+ * note\n+ */\n+\n')), ['a.css']);
  assert.deepEqual(only(patch('a.js', '@@ -3 +3 @@\n-// old\n+// new\n')), ['a.js']);
  assert.deepEqual(only(patch('a.html', '@@ -2,0 +2 @@\n+<!-- note -->\n')), ['a.html']);
  // Code after a comment on the same line.
  assert.deepEqual(only(patch('b.css', '@@ -1,0 +1 @@\n+/* x */ .hide{display:none}\n')), []);
  assert.deepEqual(only(patch('b.html', '@@ -1,0 +1 @@\n+<!-- x --><script src=a.js></script>\n')), []);
  // Lone delimiters added round untouched lines: two hunks, each leaving a comment open or closing one it never opened.
  assert.deepEqual(only(patch('c.css', '@@ -4,0 +5 @@\n+/*\n@@ -9,0 +11 @@\n+*/\n')), []);
  assert.deepEqual(only(patch('c.html', '@@ -4,0 +5 @@\n+<!--\n@@ -9,0 +11 @@\n+-->\n')), []);
  // A removed content line "-- x" shows as "--- x": the hunk's counts read it as a change, not a header.
  assert.deepEqual(only(patch('d.js', '@@ -1,2 +1 @@\n--- x\n-/* y */\n+/* z */\n')), []);
});
