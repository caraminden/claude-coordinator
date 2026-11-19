import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { importAllRubrics, importRubrics, IMPORT_KEY, loadStarters, nameFor, parseWhen, renderEntry, renderSet, repoRubrics, ReviewSet, rubricsLine, splitRubric, stageFor, whenText } from '../src/review-set.ts';

const root = mkdtempSync(join(tmpdir(), 'review-set-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES (3, \'Peek Auras\'), (9, \'Genesis Tree\');');
  return { db, set: new ReviewSet(db) };
}

// A rubric shaped like the schemes' real ones: quoted when, extends, calibration and a person's note kept.
const UI = `---
name: ui
extends: citadel:critique/rubrics/ui-screenshots
judges: Genesis Tree's web views
when: "diff: app/web/**, **/*.css"
calibrated: "2026-11-10, sonnet: 5/5 hits"
---
# UI

## Blockers

- Text clipped in the tree view.

## Notes

Josh, 2026-11-12: "the tree's labels never truncate".
`;

test('when: parses every part the format allows and writes back the same text', () => {
  const t = parseWhen('diff: a/**, b/** | creative: a new icon | schedule: monthly | in-app: after a reply | type: bug, feature | ask');
  assert.deepEqual(t, { diff: ['a/**', 'b/**'], creative: 'a new icon', schedule: 'monthly', in_app: 'after a reply', types: ['bug', 'feature'], ask: true });
  assert.equal(whenText(t), 'diff: a/**, b/** | creative: a new icon | schedule: monthly | in-app: after a reply | type: bug, feature | ask');
  assert.throws(() => parseWhen('nightly'), /isn't a when: part/);
  assert.equal(stageFor({ diff: ['x'] }), 'work');
  assert.equal(stageFor({ schedule: 'monthly' }), 'schedule');
  assert.equal(stageFor({}), 'ask');
  assert.equal(nameFor('ui-screenshots'), 'UI screenshots');
});

test('a rubric file splits into columns and a body, and renders back with its keys, sections and notes', () => {
  const { fields, body } = splitRubric(UI);
  assert.deepEqual(fields, { slug: 'ui', extends: 'ui-screenshots', triggers: { diff: ['app/web/**', '**/*.css'] } });
  assert.match(body, /^---\njudges: Genesis Tree's web views\ncalibrated: "2026-11-10, sonnet: 5\/5 hits"\n---\n\n# UI/);
  const text = renderEntry({ slug: 'ui', extends: 'ui-screenshots', triggers: fields.triggers!, model: null, effort: null, body, context: { guides: [{ label: 'Style guide', href: 'https://example.com/g' }] }, trial: true });
  // The extends line names the kit starter, so the critic reads the kit's current text under it (Q9).
  assert.match(text, /^---\nname: ui\nextends: citadel:critique\/rubrics\/ui-screenshots\nwhen: "diff: app\/web\/\*\*, \*\*\/\*.css"\ntrial: true\njudges:/);
  assert.match(text, /Josh, 2026-11-12: "the tree's labels never truncate"\./);
  assert.match(text, /## Context\n\n- Guide: \[Style guide\]\(https:\/\/example.com\/g\)\n$/);
  // And the render splits back to the same fields.
  assert.deepEqual(splitRubric(text).fields, fields);
});

test('every save is a version; History restores one as a new version, and stale saves are refused', () => {
  const { set } = fresh();
  const e = set.create(9, { slug: 'ui', name: 'UI', triggers: { diff: ['app/web/**'] }, body: '# UI' }, 'Josh');
  assert.equal(e.version, 1);
  assert.equal(e.stage, 'work');
  const off = set.save(9, 'ui', { enabled: false }, 'Cara', 'Turned off');
  assert.deepEqual([off.version, off.enabled, off.updated_by], [2, false, 'Cara']);
  // A save that changes nothing makes no version.
  assert.equal(set.save(9, 'ui', { enabled: false }, 'Cara', 'Turned off').version, 2);
  assert.throws(() => set.save(9, 'ui', { body: 'mine' }, 'Josh', 'Edited', 1), /stale: ui is at version 2 now \(Cara saved it\)/);
  set.save(9, 'ui', { body: '# UI, sharper' }, 'Josh', 'Edited by hand', 2);
  const back = set.restore(9, 'ui', 1, 'Cara');
  assert.deepEqual([back.version, back.enabled, back.body], [4, true, '# UI']);
  assert.deepEqual(set.versions(9, 'ui').map((v) => [v.version, v.by, v.note]), [[4, 'Cara', 'Restored version 1'], [3, 'Josh', 'Edited by hand'], [2, 'Cara', 'Turned off'], [1, 'Josh', 'Made']]);
  // Schemes are apart: the same slug is free in another, and one scheme's list never shows another's.
  set.create(3, { slug: 'ui', name: 'UI' }, 'Cara');
  assert.deepEqual(set.list(9).map((x) => x.project_id), [9]);
  assert.throws(() => set.create(9, { slug: 'ui', name: 'Again' }, 'Cara'), /already has an entry named ui/);
  assert.throws(() => set.create(9, { slug: 'Bad Slug', name: 'x' }, 'Cara'), /kebab-case/);
  assert.throws(() => set.save(9, 'ui', { kind: 'judge' as any }, 'Cara', 'x'), /kind is one of/);
});

test('a turn gets only the enabled entries as rubric files, and an empty set leaves no folder', () => {
  const { set } = fresh();
  set.create(9, { slug: 'ui', name: 'UI', body: '# UI' }, 'Josh');
  set.create(9, { slug: 'claims', name: 'Claims', body: '# Claims', enabled: false }, 'Josh');
  const dir = join(root, 'turn', 'review-set');
  assert.equal(renderSet(set.list(9), dir), 1);
  assert.deepEqual(readdirSync(dir), ['ui.md']);
  assert.match(readFileSync(join(dir, 'ui.md'), 'utf8'), /^---\nname: ui\nwhen: ask\n---\n\n# UI\n$/);
  assert.equal(renderSet([], dir), 0);
  assert.throws(() => readdirSync(dir), /ENOENT/);
});

test('the kit starters load, without the format example', () => {
  const s = loadStarters();
  assert.ok(s.some((x) => x.slug === 'ui-screenshots' && /front-end changes/.test(x.judges)));
  assert.ok(!s.some((x) => x.slug === 'example'));
});

test("the one-off import moves each scheme's Rubrics line files in once, keeping their text", () => {
  const { set } = fresh();
  const repo = join(root, 'genesis');
  mkdirSync(join(repo, 'docs', 'rubrics'), { recursive: true });
  writeFileSync(join(repo, 'CLAUDE.md'), '## Project facts\n\n- **Rubrics:** `docs/rubrics/`\n- **Retros:** none\n');
  writeFileSync(join(repo, 'docs', 'rubrics', 'ui.md'), UI);
  writeFileSync(join(repo, 'docs', 'rubrics', 'README.md'), '# How these work\n');
  assert.deepEqual(rubricsLine('- **Rubrics:** none yet'), []);
  assert.deepEqual(rubricsLine('- **Rubrics:** docs/rubrics/; docs/extra.md.'), ['docs/rubrics/', 'docs/extra.md']);
  assert.deepEqual(repoRubrics(repo).map(([p]) => p), ['docs/rubrics/ui.md']);

  const settings = new Map<string, unknown>();
  const store = {
    getSetting: <T>(k: string) => (settings.get(k) ?? null) as T | null,
    setSetting: (k: string, v: unknown) => void settings.set(k, v),
    listProjects: () => [{ id: 9, name: 'Genesis Tree', repo_dir: repo }, { id: 3, name: 'Peek Auras', repo_dir: join(root, 'none') }],
    reviews: set,
  };
  assert.deepEqual(importAllRubrics(store, 1), ['Genesis Tree: imported docs/rubrics/ui.md']);
  const e = set.get(9, 'ui')!;
  assert.deepEqual([e.name, e.extends, e.source, e.stage, e.trial], ['UI', 'ui-screenshots', 'docs/rubrics/ui.md', 'work', false]);
  assert.equal(set.versions(9, 'ui')[0].note, 'Imported from docs/rubrics/ui.md');
  // The rendered file says what the repo file said.
  assert.deepEqual(splitRubric(renderEntry(e)), splitRubric(UI));
  // Once per database: a second start imports nothing, even after an entry is deleted by hand.
  assert.equal(settings.get(IMPORT_KEY), 1);
  assert.deepEqual(importAllRubrics(store), []);
});

test("a body's own frontmatter can't override the keys a person sets (trial, when): a minion saves only the body", () => {
  const { set } = fresh();
  set.create(9, { slug: 'x', name: 'X', triggers: { diff: ['public/**'] }, trial: true }, 'Cara');
  const e = set.save(9, 'x', { body: '---\ntrial: false\nwhen: ask\njudges: the page\n---\n\n## Pass\n\n- ok' }, 'minion', 'learned');
  const head = renderEntry(e).split('\n---\n')[0];
  assert.deepEqual(head.split('\n').filter((l) => /^(trial|when):/.test(l)), ['when: "diff: public/**"', 'trial: true']);
  assert.match(head, /^judges: the page$/m);
});

test('context and triggers of the wrong shape are refused, so a bad save never breaks rendering', () => {
  const { set } = fresh();
  set.create(9, { slug: 'x', name: 'X' }, 'Cara');
  assert.throws(() => set.save(9, 'x', { context: { paths: 'src/x' } as any }, 'Cara', ''), /context is/);
  assert.throws(() => set.save(9, 'x', { triggers: { diff: 'public/**' } as any }, 'Cara', ''), /triggers is/);
  assert.equal(set.get(9, 'x')!.version, 1);
  assert.doesNotThrow(() => renderEntry(set.get(9, 'x')!));
});

test("the import reads only inside the repo, brings a file the store refuses in switched off, and retries a failure", () => {
  const { set } = fresh();
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'r'), { recursive: true });
  mkdirSync(join(root, 'repo-other'), { recursive: true });
  writeFileSync(join(root, 'repo-other', 'leak.md'), '---\nname: leak\n---\n');
  writeFileSync(join(repo, 'CLAUDE.md'), '- **Rubrics:** r/; ../repo-other/\n');
  writeFileSync(join(repo, 'r', 'bad-model.md'), '---\nname: bad-model\nmodel: gpt\n---\n\n## Pass\n');
  writeFileSync(join(repo, 'r', 'bad-when.md'), '---\nname: bad-when\nwhen: bogus\n---\n\n## Pass\n');
  assert.deepEqual(repoRubrics(repo).map(([p]) => p), ['r/bad-model.md', 'r/bad-when.md']);
  const { added, failed } = importRubrics(set, 9, repoRubrics(repo), 'Citadel');
  assert.equal(added.length, 2);
  assert.deepEqual(failed, []);
  for (const slug of ['bad-model', 'bad-when']) {
    const e = set.get(9, slug)!;
    assert.equal(e.enabled, false);
    assert.match(e.body, /## Pass/);
    assert.match(set.versions(9, slug)[0].note, /, off: /);
  }
  // Nothing marked done while a file failed outright, so the next start tries it again.
  const settings = new Map<string, unknown>();
  const store = { getSetting: <T>(k: string) => (settings.get(k) ?? null) as T | null, setSetting: (k: string, v: unknown) => void settings.set(k, v), listProjects: () => [{ id: 9, name: 'G', repo_dir: repo }], reviews: { get: () => null, create: () => { throw new Error('disk full'); } } as any };
  assert.match(importAllRubrics(store)[0], /FAILED r\/bad-model\.md \(disk full\)/);
  assert.equal(settings.get(IMPORT_KEY), undefined);
});
