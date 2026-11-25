// The Schedules page's reading of a brief and its list's grouping (#1083).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { briefSkills, briefSummary, groupSchedules } from '../public/schedule-text.js';

test('the summary is the first paragraph that is not a heading, cut at a sentence when long', () => {
  assert.equal(briefSummary('## Idea sweep\n\nLook through the   week\nfor ideas.\n\nThen more.'), 'Look through the week for ideas.');
  const long = `${'First sentence runs on for a while to pass sixty characters easily. '.repeat(2)}${'word '.repeat(60)}`;
  assert.equal(briefSummary(long), 'First sentence runs on for a while to pass sixty characters easily. First sentence runs on for a while to pass sixty characters easily.');
  const noStop = 'word '.repeat(80);
  const cut = briefSummary(noStop);
  assert.ok(cut.endsWith('word…') && cut.length <= 241, cut);
  assert.equal(briefSummary('# Only a heading'), '');
});

test('the skills are the kit and repo skills its brief names, each once', () => {
  assert.deepEqual(briefSkills('Use citadel:research, then citadel:research again and .claude/skills/every-scheme/SKILL.md. Not citadel: alone.'), ['citadel:research', 'every-scheme']);
  assert.deepEqual(briefSkills('No skills here.'), []);
});

test("standard audits come first, then the scheme's own split by category with Other last, paused last", () => {
  const rows = [
    { id: 1, template: 'code-health', category: 'Code', paused: 0, next_run_at: 50 },
    { id: 2, template: null, category: '', paused: 0, next_run_at: 10 },
    { id: 3, template: null, category: 'Ideas', paused: 1, next_run_at: 5 },
    { id: 4, template: null, category: 'Ideas', paused: 0, next_run_at: 30 },
    { id: 5, template: null, category: 'Apps', paused: 0, next_run_at: 40 },
  ];
  const shape = groupSchedules(rows).map(([title, , cats]) => [title, cats.map(([c, xs]) => [c, xs.map((s) => s.id)])]);
  assert.deepEqual(shape, [
    ['Standard audits', [['Code', [1]]]],
    [
      "This scheme's own",
      [
        ['Apps', [5]],
        ['Ideas', [4, 3]],
        ['Other', [2]],
      ],
    ],
  ]);
  assert.deepEqual(groupSchedules([]), []);
});

test('a schedule with no next time reads "–", and is never the next one (WP9)', async () => {
  const { nextSchedule, soon, when } = await import('../public/schedule-text.js');
  assert.equal(soon(null), '–');
  assert.equal(when(null), '–');
  assert.notEqual(soon(1_000_000_000_000), '–');
  const a = { name: 'a', next_run_at: null };
  const b = { name: 'b', next_run_at: 5 };
  const c = { name: 'c', next_run_at: 9 };
  assert.equal(nextSchedule([a, c, b]).name, 'b');
  assert.equal(nextSchedule([a]), null);
});
