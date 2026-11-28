// Build branches, the app side (specs/build-branches.md, #592): what a build's minions and the Taskmaster are told.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Project, Ticket, TicketKind } from '../src/db.ts';
import { BUILDS_LINE, buildLines, CABALS_LINE, cabalLines, systemPrompt, type BuildRole, type CabalRole, turnContext } from '../src/prompts.ts';
import { landsBuilds } from '../src/workspace.ts';
import { fake } from './typed.ts';

const project = fake<Project>({ id: 2, name: 'Citadel', instructions: '', approval_rules: '', onboarding: 'done', repo_dir: '/repo' });
const minion = fake<Ticket>({ id: 9, number: 12, title: 'A feeder', kind: 'ticket', branch: 'ticket/12-a-feeder', build: 7 });
const prompt = (build: BuildRole | null, builds = false, kind: TicketKind = 'ticket') => systemPrompt(project, { ...minion, kind }, null, null, '/tickets', null, [], true, '', null, [], build, builds);

test('build lines are given only to a minion in a build with its branch made, and the Taskmaster gets the build line only when the scheme can land one', () => {
  assert.deepEqual(buildLines(null), []);
  assert.deepEqual(buildLines({ build: 7, branch: null, owner: false }), [], 'no branch yet (or Delve): nothing');
  assert.ok(buildLines({ build: 7, branch: 'build/7', owner: false }).length > 0);
  const owner = (branch: string | null, preview?: string) => buildLines({ build: 7, branch, owner: true, preview }).join('\n');
  assert.ok(owner(null).includes('git branch build/7 main'), 'the build minion makes the branch first');
  assert.ok(!owner('build/7').includes('git branch build/7 main'), 'made already');
  assert.ok(owner('build/7', 'https://x.example/p/').includes('https://x.example/p/'));
  assert.ok(!buildLines({ build: 7, branch: 'build/7', owner: false, preview: 'https://x.example/p/' }).join('\n').includes('https://x.example/p/'), 'feeders get no preview link');
  assert.ok(!prompt(null).includes('Build 7'), 'no role, no lines');
  assert.ok(prompt(null, true, 'coordinator').includes(BUILDS_LINE));
  assert.ok(!prompt(null, false, 'coordinator').includes(BUILDS_LINE));
});

// Cabals (#2095): an Overseer's steps are the citadel:cabal skill, a member works from the board, and a build begun
// before cabals (its build minion leads no board, like Build 7) keeps today's text.
test("an Overseer gets the skill in place of the build steps, a member the board, and a build with no board today's text", () => {
  const turn = (build: BuildRole | null, cabal: CabalRole | null) => turnContext(project, minion, null, null, '/tickets', null, [], true, '', null, [], build, true, null, null, false, null, [], false, cabal);
  const lead: CabalRole = { lead: true, name: 'Build 8', overseer: "Build 8's Overseer", ref: '#12', build: 8 };
  const member: CabalRole = { ...lead, lead: false };
  const owner = turn({ build: 8, branch: null, owner: true, preview: 'https://x.example/p/' }, lead);
  assert.match(owner, /You are Build 8's Overseer/);
  assert.match(owner, /citadel:cabal/);
  assert.match(owner, /which you make first/);
  assert.match(owner, /to the member who made it while it is open, else to the Plot's fixer/, 'fixes are routed');
  assert.match(owner, /answer them together/, 'asks in batches');
  assert.match(owner, /A full run waits until no member is still merging/);
  assert.ok(owner.includes('https://x.example/p/'), 'the preview link stays');
  assert.ok(!owner.includes('You are the build minion'), 'the old build steps are gone');
  const old = turn({ build: 7, branch: 'build/7', owner: true }, null);
  assert.ok(old.includes('You are the build minion of Plot 7') && !old.includes('Overseer'), "Build 7's minion keeps today's steps");
  const feeder = turn({ build: 7, branch: 'build/7', owner: false }, null);
  assert.ok(feeder.includes('You are a feeder in Plot 7') && !feeder.includes('cabal_board'), "Build 7's feeders keep today's text");
  const inBuild = turn({ build: 8, branch: 'build/8', owner: false }, member);
  assert.match(inBuild, /You are a member of Build 8, a Plot led by Build 8's Overseer \(#12\)/);
  assert.match(inBuild, /ask it with a cabal_board ask to move the claim/);
  assert.ok(!/feeder/i.test(inBuild.replaceAll('a-feeder', '')), 'a member reads no "feeder" (the fixture\'s branch aside)');
  assert.ok(!inBuild.includes('ship to live yourself'), "a build member's work goes into the build");
  assert.ok(inBuild.indexOf('You are a member') < inBuild.indexOf('In Build 8: your base'), 'who it is comes before the branch steps');
  const goalRole: CabalRole = { lead: false, name: 'Worker machines', overseer: "Worker machines' Overseer", ref: 'Delve #4', build: null };
  const goal = cabalLines(goalRole).join('\n');
  assert.match(goal, /led by Worker machines' Overseer \(Delve #4\)/);
  assert.match(goal, /Ask your Overseer on the board/);
  assert.match(goal, /ship to live yourself/);
  assert.deepEqual(cabalLines(null), []);
  assert.ok(
    !cabalLines({ ...lead, name: 'docs sweep', build: null })
      .join('')
      .includes('merging into the build'),
    'a goal cabal has no build to merge into',
  );
  // A goal cabal's member with a build label of its own: still a goal member, and that build's feeder, not its Overseer's.
  const labelled = turn({ build: 7, branch: 'build/7', owner: false }, goalRole);
  assert.match(labelled, /ship to live yourself/);
  assert.ok(labelled.includes('You are a feeder in Build 7') && !labelled.includes("through Worker machines' Overseer"), labelled);
  assert.ok(prompt(null, false, 'coordinator').includes(CABALS_LINE), 'goal cabals whatever the Builds setting');
});

const root = mkdtempSync(join(tmpdir(), 'builds-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('builds switch on when the land script knows --into', async () => {
  assert.equal(await landsBuilds(null), false);
  assert.equal(await landsBuilds(root), false, 'no land.sh');
  mkdirSync(join(root, 'tools'));
  writeFileSync(join(root, 'tools', 'land.sh'), '#!/bin/sh\n# rebase, test, fast-forward main\n');
  assert.equal(await landsBuilds(root), false, "today's land.sh");
  writeFileSync(join(root, 'tools', 'land.sh'), '#!/bin/sh\ncase "$1" in --into) target="$2" ;; esac\n');
  assert.equal(await landsBuilds(root), true);
});
