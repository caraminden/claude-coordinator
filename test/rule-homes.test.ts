// One home per rule (#1162): each registered rule (src/rule-homes.ts) is written in full only in its home. A second
// copy in the prompt, the tool descriptions, the kit or the rule files fails here; turn it into a pointer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsOverlaps } from '../src/instructions-save.ts';
import { RULE_HOMES } from '../src/rule-homes.ts';
import { added, findCopies, overlapsFor, paragraphs, repoHomes, repoSources, schemeRules, type Source } from '../src/rule-overlap.ts';

const root = join(import.meta.dirname, '..');

test('no registered rule has a second copy in the repo', () => {
  const copies = findCopies(repoSources(root), repoHomes(root));
  assert.deepEqual(copies.map((c) => `${c.title}: ${c.label}:${c.line} (${c.phrases.join(', ') || c.run}) ${c.excerpt}`), []);
});

test('every repo home is where the registry says', () => {
  const homes = repoHomes(root);
  for (const r of RULE_HOMES) if (r.home.kind === 'repo') assert.ok((homes.get(r.id) ?? '').length > 100, `${r.id}: ${JSON.stringify(r.home)} not found`);
});

test('a planted second copy is found, by phrases or by a run of words', () => {
  const homes = repoHomes(root);
  const tripwire = homes.get('tripwire')!;
  const planted: Source[] = [
    { label: 'kit/planted.md', text: `# Notes\n\nThe tripwire stops ${tripwire.slice(tripwire.indexOf('rm or mv'), tripwire.indexOf('rm or mv') + 200)}\n` },
    { label: 'kit/cards.md', text: 'Any choice for people gets a card: a go, A or B, or an offer of work ("want me to…").\n' },
    { label: 'src/x.ts', text: "  'Close once nothing is left for a person; never leave it open for an \"are we good?\".',\n", code: true },
  ];
  const got = findCopies(planted, homes).map((c) => `${c.rule} ${c.label}`).sort();
  assert.deepEqual(got, ['cards kit/cards.md', 'closing src/x.ts', 'tripwire kit/planted.md']);
});

test('one phrase alone is a pointer, not a copy; code comments are skipped', () => {
  const homes = repoHomes(root);
  assert.deepEqual(findCopies([{ label: 'a.md', text: 'Ask with a card, as the card rule says ("want me to…" counts).' }], homes), []);
  assert.deepEqual(paragraphs("// a go, A or B, want me to\nconst x = 'y';\n * offer of work, never paste\n", true).map((p) => p.text), ["const x = 'y';"]);
});

test('an edit that repeats a rule or another place lists what already says it', () => {
  const before = '## Replies\nReply when something needs Cara.\n';
  const after = `${before}\n## Tone\nEvery card is for people: a go, A or B, or an offer of work, written so someone new can follow it.\n\nKeep big jobs in small contexts and keep noisy work out of the session, since cost is model calls times context size.\n`;
  const news = added(before, after);
  assert.equal(news.length, 2);
  const others: Source[] = [{ label: 'kit/skills/x/SKILL.md', href: null, text: 'Cost is model calls times context size: keep big jobs in small contexts and keep noisy work out of the session.\n' }];
  const got = overlapsFor(news, others, () => false);
  assert.ok(got.some((o) => o.label === 'Registered rule: When to use a card'), JSON.stringify(got));
  assert.ok(got.some((o) => o.label === 'kit/skills/x/SKILL.md'), JSON.stringify(got));
  // In its own home the rule's phrases belong there.
  assert.ok(!overlapsFor(news, [], () => true).length);
});

// Josh, 2026-11-20 (#1211): "Drop the extra 60% test". Phrases plus word runs only: a paragraph that shares most of
// its words with another, in another order and with no run of RUN_WORDS, is not listed.
test('sharing most words without a run of them is not a repeat', () => {
  const news = added('', 'Session context size times model calls is the cost, so jobs stay small and noisy work stays outside.');
  const others: Source[] = [{ label: 'kit/skills/x/SKILL.md', href: null, text: 'Cost is model calls times context size: keep big jobs in small contexts and keep noisy work out of the session.\n' }];
  assert.deepEqual(overlapsFor(news, others, () => false), []);
});

// #1211: another scheme registers its own rules in its repo's .claude/rule-homes.json; every save of its text (Settings,
// edit_instructions, its Taskmaster's set_project_instructions) runs them through settingsOverlaps.
test("a scheme's own registered rule is checked on its saves, outside its home section", () => {
  const repo = mkdtempSync(join(tmpdir(), 'scheme-rules-'));
  try {
    mkdirSync(join(repo, '.claude'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'art.md'), '# Art\n\n## Palette\n\nEvery sprite uses the sixteen colour dusk palette, outlined in deep plum, with no pure black anywhere in a frame.\n');
    writeFileSync(join(repo, '.claude', 'rule-homes.json'), JSON.stringify([
      { id: 'lunch', title: 'Lunch on Fridays', home: { kind: 'scheme', section: 'Lunch' }, pointer: 'the Lunch section', phrases: ['pizza from marios', 'noon sharp'] },
      { id: 'palette', title: 'The sprite palette', home: { kind: 'repo', file: 'docs/art.md', section: 'Palette' }, pointer: 'the palette (docs/art.md)', phrases: ['dusk palette', 'deep plum'] },
      { id: 'bad', title: 'Escapes the repo', home: { kind: 'repo', file: '../outside.md' }, pointer: 'nowhere', phrases: ['dusk palette', 'deep plum'] },
      { id: 'empty', title: 'No phrases', home: { kind: 'scheme', section: 'X' }, pointer: 'x', phrases: ['', '  '] },
      'not a rule',
    ]));
    const project = { id: 7, name: 'Delve', instructions: '', repo_dir: repo, repo_url: null } as any;
    const store = { appInstructions: () => ({ text: '' }), getProject: () => undefined } as any;
    const check = (text: string, scope: 'scheme' | 'citadel' = 'scheme') => settingsOverlaps({ store }, project, scope, '', text);

    const lunch = check('## Food\n\nOn Fridays we order pizza from Marios and eat at noon sharp in the big room.');
    assert.deepEqual(lunch.map((o) => o.label), ['Registered rule: Lunch on Fridays']);
    assert.match(lunch[0].why, /one home is the Lunch section/);
    // In its own home section, the same words are the rule itself.
    assert.deepEqual(check('## Lunch\n\nOn Fridays we order pizza from Marios and eat at noon sharp in the big room.'), []);
    // A scheme's list is read on saves of that scheme's own text only, not of the Citadel-wide text.
    assert.deepEqual(check('## Food\n\nOn Fridays we order pizza from Marios and eat at noon sharp in the big room.', 'citadel'), []);

    // A repo home: its phrases, and a run of words from the home file itself; the bad entries are skipped, not thrown.
    const art = check('## Art\n\nDraw it in the dusk palette with a deep plum outline.\n\nRemember every sprite uses the sixteen colour dusk palette, outlined in deep plum, with no pure black.');
    assert.deepEqual(art.map((o) => o.label).sort(), ['Registered rule: The sprite palette', 'Registered rule: The sprite palette', 'Scheme repo: docs/art.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a scheme with no rule file, or a broken one, gets only the shared rules', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scheme-rules-'));
  try {
    assert.deepEqual(schemeRules(repo), []);
    assert.deepEqual(schemeRules(null), []);
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude', 'rule-homes.json'), '{ not json');
    assert.deepEqual(schemeRules(repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
