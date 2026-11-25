import { test } from 'node:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { loadDecisions, tellStale } from '../src/decisions-load.ts';
import assert from 'node:assert/strict';
import type { App } from '../src/http.ts';
import { fake } from './typed.ts';
import { adrDir, assemble, githubHref, inScope, parseAdr, parseDecisions, replay, searchDecisions, type Doc } from '../src/decisions.ts';

const NAMES = ['Cara Minden', 'Josh', 'Alex'];

// The Nov 19 edit to the Citadel-wide instructions, cut to the rule it changed (app_instruction_history 35).
const LAND = `## Who and tone
Casual tone.
Land, not merge (Cara, 2026-11-19, picked "Land" and, for \`fold\`, "Retire it": "fold was just for major builds, but that can probably just become "merge" into the build branch"). In everything people read, a minion's change going onto main is "landing", and "land it" is the go. A part of a page that expands is a "collapsed section".

## Who decides in a scheme (Cara, 2026-11-04: "anyone who is assigned to a scheme should have the same authority to make decisions")
Within a scheme, every member decides.`;
const SHIP = LAND.replace(
  /Land, not merge \(Cara[^\n]*/,
  `Ship, not land or merge (Cara, 2026-11-19: she first picked "Land", then later that day, on #1020's card, picked \`Ship\` over keeping "land", Check in, Accept and Integrate; for \`fold\` she picked "Retire it": "fold was just for major builds, but that can probably just become "merge" into the build branch"). In everything people read, a minion's change going onto main is "shipping", and "ship it" is the go.`,
);

test('parseDecisions reads parenthetical attributions with the rule they back', () => {
  const got = parseDecisions(SHIP, NAMES);
  assert.equal(got.length, 2);
  assert.deepEqual([got[0].who, got[0].date, got[0].rule, got[0].quote, got[0].own], ['Cara', '2026-11-19', 'Ship, not land or merge', 'Ship', true]);
  assert.ok(got[0].quotes.includes('Ship'));
  assert.deepEqual([got[1].rule, got[1].quote, got[1].own], ['Who decides in a scheme', 'anyone who is assigned to a scheme should have the same authority to make decisions', false]);
  assert.equal(got[1].line, 5);
  // At the very start of a text, the rule keeps its first letter.
  assert.equal(parseDecisions('Ship, not land (Cara, 2026-11-19: "Ship"). More.', NAMES)[0].rule, 'Ship, not land');
});

test('two attributions in one paren, a bare quoted one, and a bare mention that is not a decision', () => {
  const t = `- Links are clickable (Cara, 2026-11-09: "no reason to have a link you cant click"; Josh, 2026-11-10, extended it to documents). Any URL is a link.

Cara, 2026-11-15, on #767's card: "2 Rerun CI on flake-only red". Later, Alex, 2026-11-16 was away and nothing was decided.

Cara 2026-11-18 — "Released" should mean actually released.`;
  const got = parseDecisions(t, NAMES);
  assert.deepEqual(
    got.map((d) => [d.who, d.date, d.quote]),
    [
      ['Cara', '2026-11-09', 'no reason to have a link you cant click'],
      ['Josh', '2026-11-10', ''],
      ['Cara', '2026-11-15', '2 Rerun CI on flake-only red'],
      ['Cara', '2026-11-18', 'Released'],
    ],
  );
  assert.equal(got[0].rule, 'Links are clickable');
  assert.equal(got[1].rule, 'Links are clickable');
  // A decision in a list reads as its own item.
  const items = parseDecisions('- Say land (Cara, 2026-11-19: "Land").\n- Old CI rule (Cara, 2026-11-10: "Keep failing").', NAMES);
  assert.deepEqual(
    items.map((d) => d.text),
    ['- Say land (Cara, 2026-11-19: "Land").', '- Old CI rule (Cara, 2026-11-10: "Keep failing").'],
  );
});

test('replay: the Land then Ship edit reverses Land; a rewording or a cut does not', () => {
  const parse = (t: string) => parseDecisions(t, NAMES);
  const revs = replay([{ before: LAND, after: SHIP, at: 1, by: 'Taskmaster' }], parse);
  assert.equal(revs.length, 1);
  assert.equal(revs[0].old.rule, 'Land, not merge');
  assert.equal(revs[0].by.rule, 'Ship, not land or merge');
  // Same person and day, reworded, no words of reversal: the same decision.
  assert.deepEqual(replay([{ before: LAND, after: LAND.replace('"Retire it": "fold', '"Retire it", "fold'), at: 1, by: 'x' }], parse), []);
  // A cut with nothing in its place: hidden, so not a reversal.
  const cut = LAND.replace(/Land, not merge \(Cara[^\n]*\n/, '');
  assert.deepEqual(replay([{ before: LAND, after: cut, at: 1, by: 'x' }], parse), []);
  // A newer decision by someone else on the same rule, in the same place, reverses it.
  const newer = LAND.replace(/Land, not merge \(Cara[^)]*\)/, 'Ship, not land or merge (Josh, 2026-11-20: "ship is the word for main")');
  const r2 = replay([{ before: LAND, after: newer, at: 1, by: 'x' }], parse);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].by.who, 'Josh');
});

test('parseAdr: one decision per ADR, its title, date and first quote, and what it says it reverses', () => {
  const adr = `# 0006: A land's CI run that is red only on flakes gets one fresh run

Date: 2026-11-15. Minion #769.
Cara, 2026-11-15, on #767's card: "2 Rerun CI on flake-only red"; on #769's plan card: "Plan approved".

This reverses Cara's 2026-11-10 "Keep failing, log it" (bb475202) for the CI gate.`;
  const d = parseAdr(adr, NAMES)!;
  assert.deepEqual([d.rule, d.date, d.who, d.quote], ["A land's CI run that is red only on flakes gets one fresh run", '2026-11-15', 'Cara', '2 Rerun CI on flake-only red']);
  assert.deepEqual(d.refs, [{ who: 'Cara', date: '2026-11-10', quote: 'Keep failing, log it' }]);
  assert.equal(adrDir('- **Decisions log (ADRs):** `docs/decisions`.'), 'docs/decisions/');
  assert.equal(adrDir('nothing'), 'docs/adr/');
});

test('assemble: counts per source, memory repeats join, history reversals link both ways, named reversals and stale copies', () => {
  const memory = `---
name: land
description: "Cara 2026-11-19 picked \\"land\\", then reversed to \\"ship\\""
---
Current word (Cara, 2026-11-19, on #1020's card): she picked \`Ship\` over keeping "land"; earlier she had picked "Land".`;
  const echo = `---
name: who-decides
---
Members decide (Cara, 2026-11-04: "anyone who is assigned to a scheme should have the same authority to make decisions").`;
  const staleRule = `# Rules\n\n- Say land (Cara, 2026-11-19: "Retire it" and "Land").\n- Old CI rule (Cara, 2026-11-10: "Keep failing, log it").`;
  const adr = `# 0006: Rerun flakes\n\nDate: 2026-11-15.\nCara, 2026-11-15: "Rerun CI".\n\nThis reverses Cara's 2026-11-10 "Keep failing, log it".`;
  const docs: Doc[] = [
    { kind: 'citadel', place: { label: 'Citadel-wide instructions', href: '#/p/2/app-instructions' }, text: SHIP, edits: [{ before: LAND, after: SHIP, at: 5, by: 'Taskmaster' }] },
    { kind: 'repo', place: { label: 'Repo CLAUDE.md and rules', file: '.claude/rules/x.md', href: null }, text: staleRule },
    { kind: 'adr', place: { label: 'ADRs', file: 'docs/adr/0006.md', href: 'https://github.com/o/r/blob/main/docs/adr/0006.md' }, text: adr, adr: true },
    { kind: 'memory', place: { label: 'Memory', file: 'land.md', href: '#/p/2/memory' }, text: memory },
    { kind: 'memory', place: { label: 'Memory', file: 'who-decides.md', href: '#/p/2/memory' }, text: echo },
  ];
  const { decisions, counts } = assemble(docs, NAMES, ['repo', 'memory']);
  assert.deepEqual(
    counts.map((c) => [c.kind, c.count, c.files]),
    [
      ['citadel', 2],
      ['repo', 2],
      ['adr', 1],
      ['memory', 3],
    ].map(([k, n]) => [k, n, k === 'memory' ? 2 : 1]),
  );
  const land = decisions.find((d) => d.rule === 'Land, not merge')!;
  const ship = decisions.find((d) => d.rule === 'Ship, not land or merge')!;
  assert.ok(land.reversed);
  assert.equal(land.reversed.by, ship.id);
  assert.deepEqual(ship.reverses, [land.id]);
  assert.deepEqual(land.places, []);
  // The repo rule still quoting "Retire it" with "Land" on the same day, without saying it was reversed, is a stale copy.
  assert.deepEqual(
    land.reversed.stale.map((p) => p.file),
    ['.claude/rules/x.md'],
  );
  // The memory note repeating "who decides" joins that row.
  const who = decisions.find((d) => d.rule === 'Who decides in a scheme')!;
  assert.deepEqual(
    who.places.map((p) => p.kind),
    ['citadel', 'memory'],
  );
  // Written in this scheme's memory too, so it shows under This scheme as well as Citadel-wide.
  assert.ok(inScope(who, 'scheme') && inScope(who, 'citadel'));
  assert.ok(!inScope(decisions.find((d) => d.rule === 'Rerun flakes')!, 'citadel'));
  // The ADR's "This reverses Cara's 2026-11-10 …" marks the rule that still says it, and lists it as the copy to clean.
  const ci = decisions.find((d) => d.quote === 'Keep failing, log it')!;
  assert.equal(ci.reversed!.by, decisions.find((d) => d.rule === 'Rerun flakes')!.id);
  assert.deepEqual(
    ci.reversed!.stale.map((p) => p.file),
    ['.claude/rules/x.md'],
  );
  // Newest first; the tool's search finds the same entries.
  assert.ok(decisions[0].date >= decisions.at(-1)!.date);
  assert.deepEqual(
    searchDecisions(decisions, 'land merge')
      .map((d) => d.id)
      .slice(0, 2)
      .sort(),
    [land.id, ship.id].sort(),
  );
});

test('githubHref links GitHub repos and nothing else', () => {
  assert.equal(githubHref('https://github.com/o/r.git', 'main', 'docs/adr/a b.md', 3), 'https://github.com/o/r/blob/main/docs/adr/a%20b.md#L3');
  assert.equal(githubHref('git@github.com:o/r.git', 'abc', 'CLAUDE.md'), 'https://github.com/o/r/blob/abc/CLAUDE.md');
  assert.equal(githubHref('/some/folder', 'main', 'CLAUDE.md'), null);
});

test('loadDecisions: the Land then Ship save shows as a reversal, and its Taskmaster gets one held note for the copy left behind', async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'decisions-')), 'db.sqlite'));
  store.createUser({ name: 'Cara', login: 'cara' });
  const project = store.createProject('Peek', null);
  const tm = store.createTicket({ project_id: project.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara', kind: 'coordinator' });
  const mail: string[] = [];
  const app = fake<App>({ store, claude: fake<App['claude']>({ accounts: () => null, configDir: () => null }), runner: fake<App['runner']>({ leaveMail: (to: number, _a: string, text: string) => mail.push(`${to}|${text}`) }) });
  store.setAppInstructions(LAND, 'Cara');
  store.setProjectInstructions(project.id, '- Say land (Cara, 2026-11-19: "Retire it" and "Land").', 'Cara');
  const first = await loadDecisions(app, store.getProject(project.id)!);
  assert.ok(first.decisions.some((d) => d.rule === 'Land, not merge' && !d.reversed));
  assert.deepEqual(mail, [], 'the first look only records');
  store.setAppInstructions(SHIP, 'Taskmaster');
  const { decisions, counts } = await loadDecisions(app, store.getProject(project.id)!);
  const land = decisions.find((d) => d.rule === 'Land, not merge')!;
  assert.equal(decisions.find((d) => d.id === land.reversed!.by)!.rule, 'Ship, not land or merge');
  assert.equal(land.reversed!.editor, 'Taskmaster');
  assert.deepEqual(
    land.reversed!.stale.map((p) => p.label),
    ['Scheme instructions'],
  );
  assert.ok(counts.find((c) => c.kind === 'kit')!.count > 0, "the kit is read from the server's checkout");
  assert.equal(mail.length, 1);
  assert.match(mail[0], new RegExp(`^${tm.id}\\|.*Land, not merge.*Ship, not land or merge.*Still written in: Scheme instructions`, 's'));
  await loadDecisions(app, store.getProject(project.id)!);
  store.setProjectInstructions(project.id, '- Say land (Cara, 2026-11-19: "Retire it" and "Land"). Again.', 'Cara');
  await loadDecisions(app, store.getProject(project.id)!);
  assert.equal(mail.length, 1, 'told once per reversal');
});

test("loadDecisions reads a repo's rules but never through a symlink", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'decisions-'));
  const store = new Store(join(dir, 'db.sqlite'));
  store.createUser({ name: 'Cara', login: 'cara' });
  const project = store.createProject('Linked', null);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'rules', 'real.md'), '- Real rule (Cara, 2026-11-19: "kept").\n');
  writeFileSync(join(dir, 'outside.md'), '- Outside rule (Cara, 2026-11-19: "leaked").\n');
  symlinkSync(join(dir, 'outside.md'), join(repo, '.claude', 'rules', 'link.md'));
  symlinkSync(dir, join(repo, '.claude', 'rules', 'folder'));
  store.setProjectRepoDir(project.id, repo);
  const app = fake<App>({ store, claude: fake<App['claude']>({ accounts: () => null, configDir: () => null }), runner: fake<App['runner']>({ leaveMail: () => {} }) });
  const { decisions } = await loadDecisions(app, store.getProject(project.id)!);
  const rules = decisions.filter((d) => d.places.some((p) => p.kind === 'repo')).map((d) => d.rule);
  assert.deepEqual(rules, ['Real rule']);
});

test('a first look whose git history could not be read records nothing, so the next load does not mail every old reversal (2ME8)', () => {
  const settings = new Map<string, unknown>();
  const mail: string[] = [];
  const app = {
    store: { getSetting: (k: string) => settings.get(k), setSetting: (k: string, v: unknown) => void settings.set(k, v), getOverlord: () => ({ id: 1 }) },
    runner: { leaveMail: (_id: number, _from: string, text: string) => void mail.push(text) },
  } as unknown as Parameters<typeof tellStale>[0];
  const reversed = { id: 'a', rule: 'r', quote: '', who: 'Cara', date: '2026-11-01', reversed: { by: 'b', byText: 'later', stale: [{ label: 'CLAUDE.md', file: 'CLAUDE.md', line: 3 }] } } as unknown as Parameters<typeof tellStale>[2]['decisions'][number];
  const list = { decisions: [reversed], counts: [] } as unknown as Parameters<typeof tellStale>[2];
  tellStale(app, { id: 7 } as Parameters<typeof tellStale>[1], list, true);
  assert.equal(settings.has('decisions_told:7'), false, 'a failed history read is not recorded as a first look');
  tellStale(app, { id: 7 } as Parameters<typeof tellStale>[1], list);
  assert.deepEqual(settings.get('decisions_told:7'), ['a'], 'the next look, with its history read, is the first');
  assert.equal(mail.length, 0, 'and mails nothing');
});
