import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fake } from './typed.ts';
import { readProposals } from '../src/review-describe.ts';
import {
  agentKind,
  BACKFILL_KEY,
  backfillRuns,
  BUILT_INS,
  CRITIC_ON_FAIL,
  importAllRubrics,
  VERDICTS,
  orderLine,
  importRubrics,
  IMPORT_KEY,
  kitLine,
  loadStarters,
  nameFor,
  parseWhen,
  readAgentFilesLater,
  renderEntry,
  renderSet,
  repoRubrics,
  ReviewSet,
  rubricsLine,
  splitRubric,
  stageFor,
  whenText,
  withoutGoneAgents,
} from '../src/review-set.ts';

const root = mkdtempSync(join(tmpdir(), 'review-set-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES (3, 'Peek Auras'), (9, 'Genesis Tree');");
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
  assert.deepEqual(
    set.versions(9, 'ui').map((v) => [v.version, v.by, v.note]),
    [
      [4, 'Cara', 'Restored version 1'],
      [3, 'Josh', 'Edited by hand'],
      [2, 'Cara', 'Turned off'],
      [1, 'Josh', 'Made'],
    ],
  );
  // Schemes are apart: the same slug is free in another, and one scheme's list never shows another's.
  set.create(3, { slug: 'ui', name: 'UI' }, 'Cara');
  assert.deepEqual(
    set.list(9).map((x) => x.project_id),
    [9],
  );
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
  assert.deepEqual(
    repoRubrics(repo).map(([p]) => p),
    ['docs/rubrics/ui.md'],
  );

  const settings = new Map<string, unknown>();
  const store = {
    getSetting: <T>(k: string) => (settings.get(k) ?? null) as T | null,
    setSetting: (k: string, v: unknown) => void settings.set(k, v),
    listProjects: () => [
      { id: 9, name: 'Genesis Tree', repo_dir: repo },
      { id: 3, name: 'Peek Auras', repo_dir: join(root, 'none') },
    ],
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
  assert.deepEqual(
    head.split('\n').filter((l) => /^(trial|when):/.test(l)),
    ['when: "diff: public/**"', 'trial: true'],
  );
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

test('the import reads only inside the repo, brings a file the store refuses in switched off, and retries a failure', () => {
  const { set } = fresh();
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'r'), { recursive: true });
  mkdirSync(join(root, 'repo-other'), { recursive: true });
  writeFileSync(join(root, 'repo-other', 'leak.md'), '---\nname: leak\n---\n');
  writeFileSync(join(repo, 'CLAUDE.md'), '- **Rubrics:** r/; ../repo-other/\n');
  writeFileSync(join(repo, 'r', 'bad-model.md'), '---\nname: bad-model\nmodel: gpt\n---\n\n## Pass\n');
  writeFileSync(join(repo, 'r', 'bad-when.md'), '---\nname: bad-when\nwhen: bogus\n---\n\n## Pass\n');
  assert.deepEqual(
    repoRubrics(repo).map(([p]) => p),
    ['r/bad-model.md', 'r/bad-when.md'],
  );
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
  const store = {
    getSetting: <T>(k: string) => (settings.get(k) ?? null) as T | null,
    setSetting: (k: string, v: unknown) => void settings.set(k, v),
    listProjects: () => [{ id: 9, name: 'G', repo_dir: repo }],
    reviews: fake<ReviewSet>({
      get: () => null,
      create: () => {
        throw new Error('disk full');
      },
    }),
  };
  assert.match(importAllRubrics(store)[0], /FAILED r\/bad-model\.md \(disk full\)/);
  assert.equal(settings.get(IMPORT_KEY), undefined);
});

test("the kit's built-ins: on every scheme's page once, switchable, their own text the kit's", () => {
  const { set } = fresh();
  set.ensureBuiltIns(3, 1);
  set.ensureBuiltIns(3, 2);
  const kit = set.list(3);
  assert.deepEqual(
    kit.map((e) => e.slug),
    BUILT_INS.map((b) => b.slug),
    'each once, in the kit order, first on the page',
  );
  assert.deepEqual(
    kit.filter((e) => !e.enabled).map((e) => e.slug),
    ['verifier'],
    'every built-in is on but the opt-in verifier (#1740)',
  );
  assert.ok(kit.every((e) => e.stage === 'ship' && !e.trial && e.source?.startsWith('kit:')));
  assert.equal(set.list(9).length, 0, 'per scheme: another scheme gets its own when its page opens');
  // A scheme switches one and adds to its text; the kit's name, kind and trial are not its to change.
  set.save(3, 'lens-tests', { enabled: false }, 'Josh', 'Turned off');
  set.save(3, 'pre-ship-review', { body: 'Also check the save file format.' }, 'Josh', 'Edited by hand');
  assert.throws(() => set.save(3, 'fresh-eyes', { name: 'Mine' }, 'Josh', 'x'), /kit's.*name/);
  assert.throws(() => set.save(3, 'fresh-eyes', { trial: true }, 'Josh', 'x'), /kit's.*trial/);
  // Restoring a kit entry's first version works: its fixed fields never moved.
  assert.equal(set.restore(3, 'lens-tests', 1, 'Josh').enabled, true);
});

test("every lens in the self-review's lenses.md has a built-in, and no built-in lens is missing from it", () => {
  const md = readFileSync(join(import.meta.dirname, '..', 'kit', 'skills', 'self-review', 'references', 'lenses.md'), 'utf8');
  const table = md.split('### Pick by the diff')[1].split('\n####')[0];
  const lenses = [...table.matchAll(/^\| ([^|]+?)(?:, in `[^`]+`)? \|/gm)].map((m) => m[1]).filter((l) => l !== 'Lens' && !/^-+$/.test(l));
  assert.deepEqual(
    BUILT_INS.filter((b) => b.slug.startsWith('lens-')).map((b) => b.name.replace(/^Lens: /, '')),
    lenses,
  );
});

test('the opt-in verifier (#1740): off says nothing to turns, on is said, per scheme, and its additions reach the Grunt only then', () => {
  const { set } = fresh();
  const dir = join(root, 'kit-verifier');
  set.ensureBuiltIns(3);
  set.ensureBuiltIns(9);
  assert.equal(kitLine(set.list(3), dir), '', 'off is how the kit has it');
  set.save(3, 'verifier', { body: 'Try it in Peek too.' }, 'Josh', 'Edited by hand');
  assert.equal(kitLine(set.list(3), dir), '');
  set.save(3, 'verifier', { enabled: true }, 'Josh', 'Turned on');
  const line = kitLine(set.list(3), dir);
  assert.match(line, /^Kit reviewers: This scheme switched on: Verifier \(/);
  assert.doesNotMatch(line, /switched off/);
  assert.match(line, /verifier\.md` \(Verifier\)/);
  assert.equal(kitLine(set.list(9), dir), '', 'another scheme stays off');
  set.ensureBuiltIns(3);
  assert.equal(set.get(3, 'verifier')?.enabled, true, 'opening the page again keeps the switch');
});

test('who gives the risk label: the pre-ship review, else a calibrated entry marked to; the turn hears which', () => {
  const { set } = fresh();
  const dir = join(root, 'kit-line');
  assert.equal(set.labelGiver(3), 'Pre-ship review', 'a scheme that never opened its page has it on');
  assert.equal(kitLine(set.list(3), dir), '', 'all on as the kit has them: no line');
  set.ensureBuiltIns(3);
  set.save(3, 'pre-ship-review', { enabled: false }, 'Josh', 'Turned off');
  set.save(3, 'fresh-eyes', { enabled: false }, 'Josh', 'Turned off');
  set.save(3, 'finding-checker', { body: 'Check the shader findings twice.' }, 'Josh', 'Edited by hand');
  assert.equal(set.labelGiver(3), null);
  const line = kitLine(set.list(3), dir);
  assert.match(line, /pre-ship review is off: don't run .* give no risk label\. Every ship waits for a person's go/);
  assert.match(line, /switched off: Fresh eyes\./);
  assert.match(line, new RegExp(`${dir}/finding-checker\\.md\` \\(Finding checker\\)`));
  assert.match(readFileSync(join(dir, 'finding-checker.md'), 'utf8'), /shader findings/);
  // On trial it can't give the label; once marked good it can.
  set.create(3, { slug: 'art-judge', name: 'Art judge', trial: true }, 'Josh');
  assert.throws(() => set.save(3, 'art-judge', { gives_label: true }, 'Josh', 'x'), /on trial, so it can't give the risk label/);
  set.save(3, 'art-judge', { trial: false, gives_label: true }, 'Josh', 'Marked good');
  assert.equal(set.labelGiver(3), 'Art judge');
  assert.match(kitLine(set.list(3), dir), /its Art judge \(`art-judge` in the review set\) gives the risk label instead/);
  // Built-ins are no rubrics: the critics' folder holds only the scheme's own entries.
  const rubrics = join(root, 'kit-rubrics');
  assert.equal(renderSet(set.list(3), rubrics), 1);
  assert.deepEqual(readdirSync(rubrics), ['art-judge.md']);
});

test('trial until calibrated: a run that passes takes it off trial, a weak one keeps it advising, and block waits', () => {
  const { set } = fresh();
  set.create(3, { slug: 'ui', name: 'UI', trial: true }, 'Josh');
  assert.throws(() => set.save(3, 'ui', { gate: 'block' }, 'Josh', 'x'), /on trial, so it only advises/);
  let e = set.calibrate(3, 'ui', { hits: 2, notes: 5, false_alarms: 0, controls: 2, model: 'sonnet' }, 'minion #12', Date.UTC(2026, 10, 19));
  assert.equal(e.trial, true, 'under half the notes: stays on trial');
  e = set.calibrate(3, 'ui', { hits: 4, notes: 5, false_alarms: 1, controls: 2, model: 'sonnet' }, 'minion #12', Date.UTC(2026, 10, 19));
  assert.equal(e.trial, true, 'a false alarm: stays on trial');
  e = set.calibrate(3, 'ui', { hits: 5, notes: 5, false_alarms: 0, controls: 0, model: 'sonnet' }, 'minion #12', Date.UTC(2026, 10, 19));
  assert.equal(e.trial, true, 'no controls: a critic that fails everything would pass, so it stays on trial');
  e = set.calibrate(3, 'ui', { hits: 4, notes: 5, false_alarms: 0, controls: 2, model: 'opus' }, 'minion #12', Date.UTC(2026, 10, 19));
  assert.equal(e.trial, false);
  assert.match(renderEntry(e), /^calibrated: "2026-11-19, opus: 4\/5 hits, 0\/2 false alarms"$/m);
  assert.equal(set.versions(3, 'ui')[0].note, 'Calibrated: 4/5 hits, 0/2 false alarms, off trial');
  e = set.save(3, 'ui', { gate: 'block' }, 'Josh', 'Set to block the ship');
  assert.match(renderEntry(e), /^gate: blocks-ready$/m);
  assert.throws(() => set.calibrate(3, 'ui', { hits: 6, notes: 5, false_alarms: 0, controls: 2 }, 'x'), /whole numbers/);
  assert.throws(() => set.calibrate(3, 'ui', { hits: 1, notes: 0, false_alarms: 0, controls: 0 }, 'x'), /whole numbers/);
  // A person putting a blocker that gives the label back on trial gets an advising entry, not a refusal.
  set.save(3, 'ui', { gives_label: true }, 'Josh', 'Gives the label');
  e = set.save(3, 'ui', { trial: true }, 'Josh', 'Put on trial');
  assert.deepEqual([e.trial, e.gate, e.gives_label], [true, 'advise', false]);
});

test('a database phase 1 made gets the phase 2 columns', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO projects VALUES (3, 'Peek Auras');");
  db.exec(
    "CREATE TABLE review_entries (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'critic', extends TEXT, body TEXT NOT NULL DEFAULT '', triggers TEXT NOT NULL DEFAULT '{}', context TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, trial INTEGER NOT NULL DEFAULT 0, model TEXT, effort TEXT, stage TEXT NOT NULL DEFAULT 'work', position INTEGER NOT NULL DEFAULT 0, gate TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE (project_id, slug))",
  );
  db.exec("INSERT INTO review_entries (project_id, slug, name, updated_by, updated_at) VALUES (3, 'ui', 'UI', 'Josh', 1)");
  const set = new ReviewSet(db);
  set.ensureBuiltIns(3);
  assert.equal(set.get(3, 'ui')?.gives_label, false);
  assert.equal(set.save(3, 'ui', { body: 'More.' }, 'Josh', 'x').version, 2);
  assert.equal(set.save(3, 'ui', { panel: 'Taste', on_fail: CRITIC_ON_FAIL }, 'Josh', 'x').panel, 'Taste', 'and the phase 3 ones');
  assert.equal(new ReviewSet(db).list(3).length, BUILT_INS.length + 1, 'a second open adds nothing');
});

test('a lens off with the pre-ship review on: the turn hears only the lens', () => {
  const { set } = fresh();
  set.ensureBuiltIns(3);
  set.save(3, 'lens-tests', { enabled: false }, 'Josh', 'Turned off');
  const line = kitLine(set.list(3), join(root, 'lens-only'));
  assert.doesNotMatch(line, /pre-ship review is off/);
  assert.match(line, /^Kit reviewers: This scheme switched off: Lens: Tests\. .*an off lens stays out of the reviewer's brief/);
});

test('run order, panels and hand-offs: saved, checked, rendered, and told to the turn', () => {
  const { set } = fresh();
  set.create(3, { slug: 'look', name: 'Look', stage: 'work' }, 'Josh');
  set.create(3, { slug: 'taste-a', name: 'Taste A', stage: 'work', panel: 'Taste' }, 'Josh');
  set.create(3, { slug: 'taste-b', name: 'Taste B', stage: 'work', panel: 'Taste' }, 'Josh');
  set.create(3, { slug: 'taste-ref', name: 'Taste referee', kind: 'referee', stage: 'work', panel: 'Taste' }, 'Josh');
  set.create(3, { slug: 'alone', name: 'Alone', stage: 'ship' }, 'Josh');
  assert.equal(orderLine(set.list(3)), 'work: `look` → [panel Taste: `taste-a`, `taste-b` judge at once; referee `taste-ref` merges]', 'a lone entry in a column needs no order');
  let e = set.move(3, 'look', 'down', 'Josh');
  assert.equal(set.list(3).filter((x) => x.stage === 'work')[1].slug, 'look');
  assert.match(set.versions(3, 'look')[0].note, /^Run order: after Taste A$/);
  assert.throws(() => set.move(3, 'alone', 'up', 'Josh'), /already first/);
  e = set.save(
    3,
    'look',
    {
      on_fail: [
        { after: 1, to: 'taste-ref' },
        { after: 3, to: 'person' },
      ],
    },
    'Josh',
    'x',
  );
  assert.match(renderEntry(e), /^on_fail: taste-ref after 1 fail, person after 3 fails$/m);
  assert.match(renderEntry(set.get(3, 'taste-a')!), /^panel: Taste$/m);
  assert.throws(() => set.save(3, 'look', { on_fail: [{ after: 2, to: 'nobody' }] }, 'Josh', 'x'), /isn't in this scheme's review set/);
  assert.throws(() => set.save(3, 'look', { on_fail: [{ after: 2, to: 'look' }] }, 'Josh', 'x'), /to itself/);
  assert.throws(
    () =>
      set.save(
        3,
        'look',
        {
          on_fail: [
            { after: 3, to: 'person' },
            { after: 2, to: 'professor' },
          ],
        },
        'Josh',
        'x',
      ),
    /rising/,
  );
  assert.throws(() => set.save(3, 'look', { panel: 'x'.repeat(41) }, 'Josh', 'x'), /1 to 40/);
  assert.equal(set.save(3, 'taste-b', { panel: '  ' }, 'Josh', 'x').panel, null, 'an empty panel is none');
});

test('the run record: dots, first-round pass rate, a stuck entry, and the ship hold', () => {
  const { set } = fresh();
  set.create(3, { slug: 'ui', name: 'UI', gate: 'block' }, 'Josh');
  set.create(3, { slug: 'copy', name: 'Copy', gate: 'advise' }, 'Josh');
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  set.recordRun(3, 'copy', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  assert.deepEqual(set.holds(3, 40), [{ slug: 'ui', name: 'UI', verdict: 'fail' }], 'an advisory fail holds nothing');
  assert.deepEqual(set.holds(3, 41), [], "another minion's ship isn't held");
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 2, verdict: 'pass' });
  assert.deepEqual(set.holds(3, 40), [], 'a pass in a later round lifts it');
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 3, verdict: 'ask' });
  assert.equal(set.holds(3, 40).length, 1, 'gone to a person still holds');
  set.save(3, 'ui', { trial: true }, 'Josh', 'x');
  assert.deepEqual(set.holds(3, 40), [], 'on trial it only advises');
  assert.throws(() => set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'maybe' }), /verdict is pass, fail, ask/);
  assert.throws(() => set.recordRun(3, 'nope', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' }), /No entry named nope/);
  for (let i = 0; i < 12; i++) set.recordRun(3, 'copy', { ticketId: 50 + i, minion: `#${50 + i}`, round: 1, verdict: 'pass' });
  const rec = set.record(3);
  const copy = rec.get(set.get(3, 'copy')!.id)!;
  assert.equal(copy.runs.length, 10, 'the last 10 runs');
  assert.equal(copy.runs.at(-1)!.minion, '#61', 'oldest first, newest last');
  assert.deepEqual([copy.firsts, copy.rate, copy.stuck], [13, 92, null], '12 of 13 first rounds passed');
  const ui = rec.get(set.get(3, 'ui')!.id)!;
  assert.deepEqual([ui.firsts, ui.rate, ui.stuck], [1, 0, null], 'one first round is too few to call it stuck');
  for (let i = 0; i < 4; i++) set.recordRun(3, 'ui', { ticketId: 70 + i, minion: `#${70 + i}`, round: 1, verdict: 'fail' });
  assert.equal(set.record(3).get(set.get(3, 'ui')!.id)!.stuck, 'fail', 'five first rounds, all failed');
});

test('the run backfill (#1095): history from critic logs sorts before live runs, never holds a ship, runs once and reports what it skipped', () => {
  const { db, set } = fresh();
  set.create(3, { slug: 'ui', name: 'UI', gate: 'block' }, 'Josh');
  const t0 = Date.UTC(2026, 10, 1);
  // A live run recorded today, before the backfill inserts older history with higher ids.
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' }, t0 + 30 * 86_400_000);
  set.recordVerdict(3, 'ui', { person: 'Josh', words: 'Too loose', ticketId: 40, minion: '#40' }, t0 + 31 * 86_400_000);
  const logs = [
    {
      project: 3,
      scheme: 'Peek Auras',
      log: '3/shared/40/critic.md',
      ticketId: 40,
      minion: '#40',
      runs: [
        { slug: 'ui', round: 1, verdict: 'fail', at: t0 },
        { slug: 'ui', round: 2, verdict: 'ask', at: t0 + 60_000 },
        { slug: 'professor', round: 2, verdict: 'pass', at: t0 + 61_000 },
        { slug: 'gone', round: 1, verdict: 'pass', at: t0 },
      ],
      verdicts: [{ slug: 'ui', person: 'Cara', words: 'Ship as is', at: t0 + 120_000 }],
    },
    { project: 3, scheme: 'Peek Auras', log: '3/shared/project/design/x/critic.md', ticketId: null, minion: 'design: x', runs: [{ slug: 'ui', round: 1, verdict: 'pass', at: t0 - 86_400_000 }], verdicts: [] },
  ];
  const settings = new Map<string, unknown>();
  const store = { getSetting: <T>(k: string) => (settings.get(k) ?? null) as T | null, setSetting: (k: string, v: unknown) => void settings.set(k, v), reviews: set };
  // A log for a scheme this database doesn't have under that name (here: id 3 is Peek Auras) is left out whole.
  const elsewhere = { ...logs[1], scheme: 'Delve', minion: 'design: y' };
  assert.deepEqual(backfillRuns(store, [...logs, elsewhere], 5), ['Peek Auras: 4 runs and 1 verdicts from 2 logs; no entry today for gone (3/shared/40/critic.md)', 'not in this database, so left out: Delve']);
  assert.equal(settings.get(BACKFILL_KEY), 5);
  assert.equal(set.get(3, 'professor')!.kind, 'teacher', "a teacher run brings the kit's professor onto the page, as opening it would");
  assert.deepEqual(set.holds(3, 40), [], "an old log's ask doesn't hold the minion's ship: its live pass is what counts");
  const ui = set.record(3).get(set.get(3, 'ui')!.id)!;
  assert.deepEqual(
    ui.runs.map((r) => [r.minion, r.round, r.verdict, r.disagreed]),
    [
      ['design: x', 1, 'pass', false],
      ['#40', 1, 'fail', false],
      ['#40', 2, 'ask', true],
      ['#40', 1, 'pass', true],
    ],
    'by date, the live run last; the run before the person spoke is amber',
  );
  assert.deepEqual([ui.firsts, ui.passes], [3, 2]);
  assert.equal(set.record(3).get(set.get(3, 'professor')!.id)!.passes, 1);
  assert.deepEqual(
    set
      .verdicts(3)
      .get(set.get(3, 'ui')!.id)!
      .map((v) => v.words),
    ['Too loose', 'Ship as is'],
    "newest first by date, so a log's old verdict sits under today's",
  );
  // Once: a second start adds nothing, and a direct second pass finds every log already in.
  assert.deepEqual(backfillRuns(store, logs), []);
  const count = () => (db.prepare("SELECT count(*) AS n FROM review_runs WHERE source = 'backfill'").get() as { n: number }).n;
  assert.equal(count(), 4);
  assert.match(set.backfill(logs)[0], /^Peek Auras: 0 runs and 0 verdicts from 0 logs; 3 already in/);
  assert.equal(count(), 4);
  // A bad row rolls the whole import back.
  assert.throws(
    () =>
      set.backfill([
        {
          project: 3,
          scheme: 'Peek Auras',
          log: 'l',
          ticketId: 1,
          minion: '#1',
          runs: [
            { slug: 'ui', round: 1, verdict: 'pass', at: 1 },
            { slug: 'ui', round: 0, verdict: 'pass', at: 2 },
          ],
          verdicts: [],
        },
      ]),
    /bad run/,
  );
  assert.equal(count(), 4);
});

test('src/review-backfill.json: every run is well formed and in date order per log (#1095)', () => {
  const logs = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'src', 'review-backfill.json'), 'utf8'));
  assert.ok(logs.length > 50);
  for (const l of logs) {
    assert.ok(Number.isInteger(l.project) && l.scheme && l.log.endsWith('critic.md') && l.minion, l.log);
    assert.ok(l.ticketId === null ? l.minion.startsWith('design: ') : /^#\d+$/.test(l.minion), l.log);
    for (const r of l.runs) assert.ok((VERDICTS as readonly string[]).includes(r.verdict) && Number.isInteger(r.round) && r.round >= 1 && Number.isInteger(r.at), `${l.log} ${JSON.stringify(r)}`);
    // A critic's round is one run over every item it judged; only a teacher's runs are one per item.
    const rounds = l.runs.filter((r: { slug: string }) => r.slug !== 'professor').map((r: { slug: string; round: number; at: number }) => `${r.slug} ${r.round} ${r.at}`);
    assert.equal(new Set(rounds).size, rounds.length, `${l.log}: a critic round twice`);
    // A verdict lands only beside its log's runs of that entry, so the "already in" check keeps a replay from doubling it.
    for (const v of l.verdicts) assert.ok(Number.isInteger(v.at) && l.runs.some((r: { slug: string }) => r.slug === v.slug), `${l.log} ${JSON.stringify(v)}`);
    assert.deepEqual(
      l.runs.map((r: { at: number }) => r.at),
      l.runs.map((r: { at: number }) => r.at).sort((a: number, b: number) => a - b),
      l.log,
    );
  }
});

test("a teacher's record counts every round after its fix, not just first rounds, and is never stuck (#1089)", () => {
  const { set } = fresh();
  set.create(3, { slug: 'prof', name: 'Prof', kind: 'teacher' }, 'Josh');
  const verdicts = ['fail', 'fail', 'fail', 'fail', 'pass', 'fail'];
  verdicts.forEach((v, i) => set.recordRun(3, 'prof', { ticketId: 80 + i, minion: `#${80 + i}`, round: 3, verdict: v }));
  const rec = set.record(3).get(set.get(3, 'prof')!.id)!;
  assert.deepEqual([rec.firsts, rec.passes, rec.rate, rec.stuck], [6, 1, 17, null], 'one of six fixes held, all after round 1, and five fails call no teacher stuck');
  set.create(3, { slug: 'critic', name: 'Critic' }, 'Josh');
  set.recordRun(3, 'critic', { ticketId: 90, minion: '#90', round: 3, verdict: 'pass' });
  assert.equal(set.record(3).get(set.get(3, 'critic')!.id)!.firsts, 0, "a critic's later rounds still don't count");
  // A teacher's pass is one fixed item's next round, not a verdict on the work: it doesn't lift its critic's ship hold.
  set.save(3, 'critic', { gate: 'block', on_fail: [{ after: 2, to: 'prof' }] }, 'Josh', 'x');
  set.recordRun(3, 'critic', { ticketId: 91, minion: '#91', round: 3, verdict: 'fail' });
  set.recordRun(3, 'prof', { ticketId: 91, minion: '#91', round: 3, verdict: 'pass' });
  assert.deepEqual(
    set.holds(3, 91).map((x) => x.slug),
    ['critic'],
  );
});

test("a blocking entry's fail is lifted by a later pass from what judges in its place: its panel's referee or its hand-off", () => {
  const { set } = fresh();
  set.create(3, { slug: 'layout', name: 'Layout', gate: 'block', panel: 'Taste' }, 'Josh');
  set.create(3, { slug: 'taste-ref', name: 'Taste referee', kind: 'referee', panel: 'Taste' }, 'Josh');
  set.create(3, { slug: 'copy', name: 'Copy', gate: 'block' }, 'Josh');
  set.create(3, { slug: 'tone', name: 'Tone' }, 'Josh');
  set.save(3, 'copy', { on_fail: [{ after: 1, to: 'tone' }] }, 'Josh', 'x');
  set.recordRun(3, 'taste-ref', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' });
  set.recordRun(3, 'layout', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  set.recordRun(3, 'copy', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  assert.deepEqual(
    set.holds(3, 40).map((h) => h.slug),
    ['layout', 'copy'],
    'a pass from before the fail lifts nothing',
  );
  set.recordRun(3, 'taste-ref', { ticketId: 40, minion: '#40', round: 1, verdict: 'pass' });
  set.recordRun(3, 'tone', { ticketId: 41, minion: '#41', round: 2, verdict: 'pass' });
  assert.deepEqual(
    set.holds(3, 40).map((h) => h.slug),
    ['copy'],
    "the referee's merged pass governs the panel; another minion's hand-off pass doesn't count",
  );
  set.recordRun(3, 'tone', { ticketId: 40, minion: '#40', round: 2, verdict: 'pass' });
  assert.deepEqual(set.holds(3, 40), [], 'the hand-off passed it');
});

test("hand-offs to an entry switched off drop out of the rubric, and a kit reviewer's file carries people's verdicts", () => {
  const { set } = fresh();
  set.ensureBuiltIns(3);
  set.create(3, { slug: 'copy', name: 'Copy' }, 'Josh');
  set.create(3, { slug: 'tone', name: 'Tone' }, 'Josh');
  set.save(
    3,
    'copy',
    {
      on_fail: [
        { after: 1, to: 'tone' },
        { after: 3, to: 'person' },
      ],
    },
    'Josh',
    'x',
  );
  set.save(3, 'tone', { enabled: false }, 'Josh', 'x');
  const dir = join(root, 'dangling');
  renderSet(set.list(3), dir, new Map());
  assert.match(readFileSync(join(dir, 'copy.md'), 'utf8'), /^on_fail: person after 3 fails$/m);
  set.recordVerdict(3, 'pre-ship-review', { person: 'Josh', words: 'Style nits are not blockers here.', ticketId: 40, minion: '#40' }, Date.UTC(2026, 10, 19));
  const kdir = join(root, 'kit-verdicts');
  kitLine(set.list(3), kdir, set.verdicts(3));
  assert.match(readFileSync(join(kdir, 'pre-ship-review.md'), 'utf8'), /## Verdicts[\s\S]*Style nits are not blockers here/);
});

test("people's verdicts: recorded by a minion, an amber dot, read by the next run unless switched off, and removable", () => {
  const { set } = fresh();
  const e = set.create(3, { slug: 'ui', name: 'UI' }, 'Josh');
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  set.recordRun(3, 'ui', { ticketId: 41, minion: '#41', round: 1, verdict: 'fail' });
  const v = set.recordVerdict(3, 'ui', { person: 'Josh', words: 'The tight spacing there is on purpose.', ticketId: 40, minion: '#40' }, Date.UTC(2026, 10, 19));
  const runs = set.record(3).get(e.id)!.runs;
  assert.deepEqual(
    runs.map((r) => r.disagreed),
    [true, false],
    "only that minion's run turns amber",
  );
  const verdicts = set.verdicts(3);
  assert.equal(verdicts.get(e.id)![0].words, 'The tight spacing there is on purpose.');
  const text = renderEntry(e, { verdicts: verdicts.get(e.id) });
  assert.match(text, /## Verdicts\n\nPeople disagreed with this entry's verdicts\. Judge the way they did:\n\n- Josh, 2026-11-19, on #40: "The tight spacing there is on purpose\."/);
  const off = set.save(3, 'ui', { context: { verdicts: false } }, 'Josh', 'x');
  assert.doesNotMatch(renderEntry(off, { verdicts: verdicts.get(e.id) }), /## Verdicts/, 'switched off, the runs stop reading them');
  const dir = join(root, 'verdicts-set');
  set.save(3, 'ui', { context: {} }, 'Josh', 'x');
  renderSet(set.list(3), dir, set.verdicts(3));
  assert.match(readFileSync(join(dir, 'ui.md'), 'utf8'), /on purpose/, "the turn's rubric file carries them");
  assert.throws(() => set.recordVerdict(3, 'ui', { person: 'Josh', words: ' ', ticketId: 40, minion: '#40' }), /own words/);
  set.removeVerdict(3, 'ui', v.id);
  assert.equal(set.verdicts(3).get(e.id), undefined);
  assert.throws(() => set.removeVerdict(3, 'ui', v.id), /No verdict/);
});

test("the requester's words: off by default, the minion's first message in the brief when on", () => {
  const { db, set } = fresh();
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, ticket_id INTEGER, kind TEXT, data TEXT)');
  db.prepare('INSERT INTO events (ticket_id, kind, data) VALUES (?, ?, ?)').run(40, 'note', '{}');
  db.prepare('INSERT INTO events (ticket_id, kind, data) VALUES (?, ?, ?)').run(40, 'user_message', JSON.stringify({ author: 'Cara', text: 'Make the tree glow.\nSoftly.' }));
  db.prepare('INSERT INTO events (ticket_id, kind, data) VALUES (?, ?, ?)').run(40, 'user_message', JSON.stringify({ author: 'Josh', text: 'Later words' }));
  const words = set.requesterWords(40);
  assert.deepEqual(words, { author: 'Cara', text: 'Make the tree glow.\nSoftly.' });
  assert.equal(set.requesterWords(99), null);
  const e = set.create(3, { slug: 'ui', name: 'UI' }, 'Josh');
  assert.doesNotMatch(renderEntry(e, { requester: words }), /requester's words/);
  const on = set.save(3, 'ui', { context: { requester: true } }, 'Josh', 'x');
  assert.match(renderEntry(on, { requester: words }), /## The requester's words\n\nWhat Cara asked this minion for, in their own words \(the brief may quote them\):\n\n> Make the tree glow\.\n> Softly\./);
});

test("the describe agent may change a scheme entry's gate, panel and hand-offs, never a kit entry's", () => {
  const { set } = fresh();
  set.ensureBuiltIns(3);
  set.create(3, { slug: 'ui', name: 'UI', body: '# UI' }, 'Josh');
  const reply = JSON.stringify({
    note: 'ok',
    edits: [
      { slug: 'ui', settings: { panel: 'Taste', on_fail: [{ after: 1, to: 'person' }], gate: 'advise' }, why: 'Panel' },
      { slug: 'finding-checker', settings: { gate: 'block' } },
      { slug: 'ui', body: 'second edit of the same entry is dropped' },
    ],
  });
  const { proposals } = readProposals(reply, set.list(3));
  assert.equal(proposals.length, 1, 'a settings-only edit of a kit entry proposes nothing');
  assert.deepEqual(proposals[0].settings, { gate: 'advise', panel: 'Taste', on_fail: [{ after: 1, to: 'person' }] });
  assert.deepEqual(proposals[0].settings_before, { gate: null, panel: null, on_fail: null });
  assert.equal(proposals[0].after, '# UI', 'the body is kept when the edit leaves it out');
  const moved = readProposals(JSON.stringify({ note: 'ok', edits: [{ slug: 'ui', settings: { position: 7 } }] }), set.list(3)).proposals[0];
  assert.deepEqual([moved.settings, moved.settings_before], [{ position: 7 }, { position: set.get(3, 'ui')!.position }], 'and its run order');
});

test('a critic hands a second fail to its teacher entry: the file keeps the step, the teacher says kind and has no column', () => {
  const { set } = fresh();
  set.create(9, { slug: 'art-teacher', name: 'Art teacher', kind: 'teacher', body: '# Fixes\n\nChange the generator, never the PNG.', triggers: {}, stage: 'work' }, 'Cara');
  set.create(
    9,
    {
      slug: 'art',
      name: 'Art',
      kind: 'critic',
      triggers: { creative: 'new art' },
      stage: 'work',
      on_fail: [
        { after: 2, to: 'art-teacher' },
        { after: 3, to: 'person' },
      ],
    },
    'Cara',
  );
  const dir = join(root, 'teacher-set');
  assert.equal(renderSet(set.list(9), dir), 2);
  assert.match(readFileSync(join(dir, 'art.md'), 'utf8'), /\non_fail: art-teacher after 2 fails, person after 3 fails\n/);
  const t = readFileSync(join(dir, 'art-teacher.md'), 'utf8');
  assert.match(t, /^---\nname: art-teacher\nkind: teacher\nwhen: set by the extending rubric\n/);
  assert.equal(orderLine(set.list(9)), '', 'a teacher is in no column order');
  // Switched off, the step drops out instead of sending the critic nowhere.
  set.save(9, 'art-teacher', { enabled: false }, 'Cara', 'off');
  renderSet(set.list(9), dir);
  assert.match(readFileSync(join(dir, 'art.md'), 'utf8'), /\non_fail: person after 3 fails\n/);
});

test("a scheme's agent files: kind from name, description or kind:, one entry each unless a same-named one exists, and the turn hears them", async () => {
  assert.equal(agentKind('art-critic', ''), 'critic');
  assert.equal(agentKind('claim-referee', 'Judges claims'), 'referee');
  assert.equal(agentKind('art-professor', 'Judges nothing'), 'teacher', 'the name wins over the description');
  assert.equal(agentKind('helper', 'Reviews migrations before a ship'), 'reviewer');
  assert.equal(agentKind('balance-tuner', 'Tunes numbers'), null);
  assert.equal(agentKind('art-critic', '', 'none'), null, 'kind: none leaves a critic off');
  assert.equal(agentKind('balance-tuner', '', 'audit'), 'audit');
  const repo = join(root, 'agents-repo');
  const dir = join(repo, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Shader_Critic.md'), '---\nname: shader-critic\ndescription: "Judges shaders"\n---\n\nYou judge shaders.\n');
  writeFileSync(join(dir, 'art-professor.md'), '---\ndescription: Teaches art fixes\n---\nTeach.\n');
  writeFileSync(join(dir, 'tuner.md'), '---\ndescription: Tunes\nkind: checker\n---\nCheck.\n');
  writeFileSync(join(dir, 'notes.txt'), 'not an agent');
  const files = await readAgentFilesLater(repo);
  assert.deepEqual(
    files.map((f) => [f.slug, f.kind, f.path, f.description]),
    [
      ['shader-critic', 'critic', '.claude/agents/Shader_Critic.md', 'Judges shaders'],
      ['art-professor', 'teacher', '.claude/agents/art-professor.md', 'Teaches art fixes'],
      ['tuner', 'checker', '.claude/agents/tuner.md', 'Tunes'],
    ],
  );
  assert.equal(files[0].text.trim(), 'You judge shaders.');
  assert.deepEqual(await readAgentFilesLater(null), []);
  assert.deepEqual(await readAgentFilesLater(join(root, 'no-such-repo')), []);

  const { set } = fresh();
  set.create(3, { slug: 'art-professor', name: 'Art professor', kind: 'teacher', body: 'Fix palettes first.' }, 'Josh');
  set.ensureAgents(3, files);
  set.ensureAgents(3, files);
  const own = set.list(3).filter((e) => e.source?.startsWith('agent:'));
  assert.deepEqual(
    own.map((e) => [e.slug, e.kind, e.source]),
    [
      ['shader-critic', 'critic', 'agent:.claude/agents/Shader_Critic.md'],
      ['tuner', 'checker', 'agent:.claude/agents/tuner.md'],
    ],
    "once each; the same-named entry stays the scheme's",
  );
  assert.throws(() => set.save(3, 'shader-critic', { kind: 'reviewer' }, 'Josh', 'x'), /agent file \.claude\/agents\/Shader_Critic\.md/);
  set.save(3, 'shader-critic', { body: 'Look at banding.' }, 'Josh', 'Edited by hand');
  set.save(3, 'tuner', { enabled: false }, 'Josh', 'Turned off');
  // The file's text is its own: it isn't a rubric in the set or the run order.
  assert.equal(renderSet(set.list(3), join(root, 'agents-set')), 1, 'only the same-named rubric entry');
  assert.deepEqual(readdirSync(join(root, 'agents-set')), ['art-professor.md']);
  assert.doesNotMatch(orderLine(set.list(3)), /shader-critic|tuner/);
  const kdir = join(root, 'agents-kit');
  const line = kitLine(set.list(3), kdir);
  assert.match(line, /switched off its own agents .*tuner.*\.claude\/agents\/tuner\.md/);
  assert.match(line, /own reviewing agents, whose text is their file: .*shader-critic/);
  assert.match(readFileSync(join(kdir, 'shader-critic.md'), 'utf8'), /\.claude\/agents\/Shader_Critic\.md[\s\S]*Look at banding/);
  // A file named like a reserved slug stays off rather than break the page; a kind: edit in a file reaches its entry.
  writeFileSync(join(dir, 'audits.md'), '---\ndescription: Audits\n---\nx\n');
  writeFileSync(join(dir, 'tuner.md'), '---\ndescription: Tunes\nkind: teacher\n---\nTeach.\n');
  set.ensureAgents(3, await readAgentFilesLater(repo));
  assert.equal(set.get(3, 'audits'), null);
  assert.equal(set.get(3, 'tuner')!.kind, 'teacher');
  // A critic's hand-off to a repo teacher that's on stays in its rubric; back on trial, a repo blocker only advises.
  set.save(3, 'tuner', { enabled: true }, 'Josh', 'On');
  set.create(
    3,
    {
      slug: 'look',
      name: 'Look',
      on_fail: [
        { after: 2, to: 'tuner' },
        { after: 3, to: 'person' },
      ],
    },
    'Josh',
  );
  renderSet(set.list(3), join(root, 'agents-set'));
  assert.match(readFileSync(join(root, 'agents-set', 'look.md'), 'utf8'), /on_fail: tuner after 2 fails, person after 3 fails/);
  set.save(3, 'shader-critic', { gate: 'block' }, 'Josh', 'Blocks');
  assert.equal(set.save(3, 'shader-critic', { trial: true }, 'Josh', 'Trial').gate, 'advise');
});

test('lessons (#1158): a kind refuted 3 times with no 30-day gap reaches the reviewer as why it was wrong; 30 days quiet expires it; 30 at most', () => {
  const { set } = fresh();
  const day = 86_400_000;
  const t0 = Date.UTC(2026, 10, 1);
  const by = { ticketId: null, minion: '#4' };
  // A scheme that never opened its page: the first refute makes the pre-ship review's row.
  set.recordRefutes(3, { ...by, refuted: [{ kind: 'Missing build step.', why: 'the repo has no build step: Node runs the TypeScript' }] }, t0);
  set.recordRefutes(3, { ...by, refuted: [{ kind: 'missing  build step', why: 'the repo has no build step: Node runs the TypeScript' }] }, t0 + 10 * day);
  assert.deepEqual(set.lessons(3, t0 + 11 * day), [], 'two refutes make no lesson');
  assert.deepEqual(
    set.lessons(3, t0 + 11 * day, true).map((l) => [l.kind, l.count]),
    [['missing build step', 2]],
    'the same words count together',
  );
  // One minion's review counts once per kind: three findings on one diff, or its later rounds, are one hit.
  set.recordRefutes(3, { ticketId: 7, minion: '#7', refuted: [1, 2, 3].map(() => ({ kind: 'untested helper', why: 'the helper is tested through its caller' })) }, t0 + 10 * day);
  set.recordRefutes(3, { ticketId: 7, minion: '#7', refuted: [{ kind: 'untested helper', why: 'the helper is tested through its caller' }] }, t0 + 10 * day);
  assert.deepEqual(
    set.lessons(3, t0 + 11 * day, true).map((l) => [l.kind, l.count]),
    [
      ['missing build step', 2],
      ['untested helper', 1],
    ],
  );
  set.removeLesson(3, 'untested helper');
  set.recordRefutes(3, { ...by, refuted: [{ kind: 'missing build step', why: 'there is no build: package.json has no build script' }] }, t0 + 20 * day);
  const [l] = set.lessons(3, t0 + 21 * day);
  assert.deepEqual([l.kind, l.count, l.last, l.why], ['missing build step', 3, t0 + 20 * day, 'there is no build: package.json has no build script']);
  assert.deepEqual(set.lessons(9, t0 + 21 * day), [], "another scheme's reviewer reads none of this one's");

  // The reviewer reads it in the pre-ship review's additions file, as a reason, never a ban.
  const dir = join(root, 'lessons');
  const line = kitLine(set.list(3), dir, new Map(), set.lessons(3, t0 + 21 * day));
  assert.match(line, new RegExp(`${dir}/pre-ship-review\\.md\` \\(Pre-ship review\\)`));
  const file = readFileSync(join(dir, 'pre-ship-review.md'), 'utf8');
  assert.match(file, /^- missing build step: refuted 3 times, last 2026-11-21\. It was wrong because there is no build: package\.json has no build script\.$/m);
  assert.match(file, /when this diff makes the reason untrue, raise the finding/);
  set.save(3, 'pre-ship-review', { enabled: false }, 'Josh', 'Turned off');
  assert.doesNotMatch(kitLine(set.list(3), dir, new Map(), set.lessons(3, t0 + 21 * day)), /pre-ship-review\.md/, 'no reviewer runs, so no lessons file');
  set.save(3, 'pre-ship-review', { enabled: true }, 'Josh', 'Turned on');

  // Thirty days with no hit expires it; a hit after that starts the count again.
  assert.equal(set.lessons(3, t0 + 50 * day).length, 1);
  assert.deepEqual(set.lessons(3, t0 + 51 * day, true), [], 'expired after 30 days without a hit');
  set.recordRefutes(3, { ...by, refuted: [{ kind: 'missing build step', why: 'the repo has no build step at all' }] }, t0 + 60 * day);
  assert.deepEqual(
    set.lessons(3, t0 + 60 * day, true).map((l) => l.count),
    [1],
  );

  // Never "don't look at X"; bad input refused whole.
  assert.throws(() => set.recordRefutes(3, { ...by, refuted: [{ kind: 'unused helper', why: "Don't flag helpers in tools/" }] }), /a fact about the repo/);
  assert.throws(() => set.recordRefutes(3, { ...by, refuted: [{ kind: 'x', why: 'a long enough reason here' }] }), /kind is/);
  assert.throws(() => set.recordRefutes(3, { ...by, refuted: [] }), /1 to 25/);

  // At most 30 lessons, most hits first.
  for (let k = 0; k < 32; k++) for (let n = 0; n < 3 + (k % 3); n++) set.recordRefutes(3, { ticketId: 100 + n, minion: `#${100 + n}`, refuted: [{ kind: `kind ${k}`, why: `reason number ${k} holds here` }] }, t0 + 61 * day);
  const capped = set.lessons(3, t0 + 61 * day);
  assert.equal(capped.length, 30);
  assert.equal(capped[0].count, 5);
  assert.equal(set.lessons(3, t0 + 61 * day, true).length, 33, 'the minion still sees every kind counting');
  set.removeLesson(3, 'Kind 2');
  assert.ok(!set.lessons(3, t0 + 61 * day, true).some((x) => x.kind === 'kind 2'), 'a person removes one, and its count starts again');
  assert.throws(() => set.removeLesson(3, 'kind 2'), /No lesson/);
});

test('RV3: a changed `when` moves the column only when the entry sat where its old triggers put it', () => {
  const { set } = fresh();
  set.create(3, { slug: 'asked', name: 'Asked', triggers: {} }, 'Cara');
  assert.equal(set.get(3, 'asked')!.stage, 'ask');
  // The page sends the stage it opened with along with the new `when`: that is no pick.
  assert.equal(set.save(3, 'asked', { triggers: { diff: ['src/**'] }, stage: 'ask' }, 'Cara', 'when').stage, 'work');
  assert.equal(set.save(3, 'asked', { triggers: { schedule: 'weekly' } }, 'Cara', 'when').stage, 'schedule');
  // A critic a person put in "Before ship" stays there when its triggers change.
  set.create(3, { slug: 'ship-critic', name: 'Ship critic', triggers: { diff: ['src/**'] }, stage: 'ship' }, 'Cara');
  assert.equal(set.save(3, 'ship-critic', { triggers: { diff: ['public/**'] } }, 'Cara', 'when').stage, 'ship');
  // A person choosing another column in the same save is the pick.
  assert.equal(set.save(3, 'asked', { triggers: { diff: ['a/**'] }, stage: 'ship' }, 'Cara', 'both').stage, 'ship');
});

test('RV4: an agent file that is gone, or set to kind: none, is left out of what the turn is told', () => {
  const { set } = fresh();
  const files = [
    { path: '.claude/agents/auditor.md', slug: 'auditor', description: 'audits', kind: 'critic', text: '' },
    { path: '.claude/agents/judge.md', slug: 'judge', description: 'judges', kind: 'critic', text: '' },
  ];
  set.ensureAgents(3, files);
  set.create(3, { slug: 'own', name: 'Own' }, 'Cara');
  const all = set.list(3);
  const dir = join(root, 'rv4-kit');
  assert.match(kitLine(withoutGoneAgents(all, files), dir), /`auditor` \(\.claude\/agents\/auditor\.md\)/);
  const left = withoutGoneAgents(all, files.slice(1));
  assert.deepEqual(left.map((e) => e.slug).sort(), ['judge', 'own']);
  const line = kitLine(left, dir);
  assert.doesNotMatch(line, /auditor/);
  assert.match(line, /judge/);
});

test('RV8: removing a person\'s verdict clears "a person disagreed" on its run, unless another verdict on that minion stands', () => {
  const { set } = fresh();
  set.create(3, { slug: 'ui', name: 'UI' }, 'Josh');
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 1, verdict: 'fail' });
  const a = set.recordVerdict(3, 'ui', { person: 'Josh', words: 'Too loose', ticketId: 40, minion: '#40' });
  const b = set.recordVerdict(3, 'ui', { person: 'Cara', words: 'Too tight', ticketId: 40, minion: '#40' });
  const amber = () =>
    set
      .record(3)
      .get(set.get(3, 'ui')!.id)!
      .runs.map((r) => r.disagreed);
  assert.deepEqual(amber(), [true]);
  set.removeVerdict(3, 'ui', a.id);
  assert.deepEqual(amber(), [true], "Cara's verdict still stands");
  set.removeVerdict(3, 'ui', b.id);
  assert.deepEqual(amber(), [false]);
  // A later run of the same minion doesn't hide which run the verdict marked.
  const c = set.recordVerdict(3, 'ui', { person: 'Josh', words: 'Still loose', ticketId: 40, minion: '#40' });
  set.recordRun(3, 'ui', { ticketId: 40, minion: '#40', round: 2, verdict: 'pass' });
  set.removeVerdict(3, 'ui', c.id);
  assert.deepEqual(amber(), [false, false]);
});
