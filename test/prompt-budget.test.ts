import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { systemPrompt, turnContext } from '../src/prompts.ts';

// The starting prompt's size budget (#415): every API call re-reads it, so it only grows by decision.
// Budgets are characters (minion 36,400 on 2026-11-18: #975 added the finishing-work lines, AG-01; Taskmaster 39,500 on 2026-11-19: #1030 added the .env grep habit; 39,700 the same day: #1056 added the design-brief ambition line; minion 37,000 and Taskmaster 40,100 the same day: #1043 added the Shipping line both read, path, go threshold and try-first, in place of each scheme's own shipping paragraph; Taskmaster 40,800 on 2026-11-19: #1154 added the rule-to-hook trigger) (about 4 per token), today's size plus 10% on 2026-11-08, lowered by each cut since (#760; Build 2, 2026-11-17). Raising one is a
// one-line edit here with the reason in the commit message; then refresh the baseline with
// PROMPT_BASELINE=write node --test test/prompt-budget.test.ts
const BUDGET = {
  minion: 34_900 /* +250 on 2026-11-22 for the callers-and-twins and no-multi-file-dump lines (#1644);  -1,096 on 2026-11-22: the citadel-heavy line moved to the kit's heavy-nudge hook (#1577); +450 on 2026-11-19 for the done-lines rule (#1115); +50 for the citadel-where line (#1122, Build 5); -1,750 on 2026-11-22: seven lines moved to their homes (#1574) */,
  taskmaster: 42_000 /* +150 on 2026-11-24 for the mark_urgent line (#1888); +150 on 2026-11-24 for the dated, commit-cited memory line (#1806); +200 on 2026-11-24 for the effortName line, which marks a multi-minion goal for its retro (#1751); +100 for the ship-lessons line (#1119), +300 for the rule-to-hook trigger (#1154), +400 for the ship-line ordering rule (#1358), +100 for the proven-fix clause in the Shipping line (#1398), +200 for the start-everything line (#1488) */,
};

// Today's longest instructions: the Citadel-wide text (11,664) and Delve's scheme text (10,123).
const app = 'x'.repeat(11_664);
const project = { id: 2, name: 'Citadel', instructions: 'y'.repeat(10_123), approval_rules: '', onboarding: 'done', repo_dir: '/repo' } as any;
const minion = { id: 929, number: 415, title: 'Prompt size budget check', kind: 'ticket', branch: 'ticket/415-prompt-size-budget-check' } as any;
const prompts = {
  minion: systemPrompt(project, minion, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app),
  taskmaster: systemPrompt(project, { ...minion, kind: 'coordinator' }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app),
};

/** Each line's length, keyed by how it starts, to say which lines grew since the baseline. */
function lineSizes(prompt: string): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const line of prompt.split('\n')) {
    const key = line.slice(0, 60);
    sizes[key] = (sizes[key] ?? 0) + line.length + 1;
  }
  return sizes;
}

const BASELINE = new URL('prompt-baseline.json', import.meta.url);
if (process.env.PROMPT_BASELINE === 'write') {
  writeFileSync(BASELINE, JSON.stringify({ minion: lineSizes(prompts.minion), taskmaster: lineSizes(prompts.taskmaster) }, null, 1) + '\n');
}
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

/** The lines that grew or are new since the baseline, biggest growth first. */
function growth(was: Record<string, number>, now: Record<string, number>): string[] {
  return Object.entries(now)
    .map(([key, n]) => ({ key, n, d: n - (was[key] ?? 0) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => b.d - a.d)
    .slice(0, 10)
    .map((x) => `  +${x.d} ${x.key in was ? '' : '(new) '}"${x.key}…"`);
}

for (const role of ['minion', 'taskmaster'] as const) {
  test(`a ${role}'s starting prompt stays within its budget`, () => {
    const size = prompts[role].length;
    assert.ok(
      size <= BUDGET[role],
      [
        `A ${role}'s starting prompt is ${size} characters, over its budget of ${BUDGET[role]} (about ${Math.round((size - BUDGET[role]) / 4)} tokens over).`,
        'Each 1k tokens in it costs about $27 a week. Trim it, or raise the budget in this file with the reason in the commit message.',
        'What grew since test/prompt-baseline.json:',
        ...growth(baseline[role], lineSizes(prompts[role])),
      ].join('\n'),
    );
  });
}

// Build branches (#592): the build minion's steps and the Taskmaster's test for a build fit the same budgets.
test("a build minion's and a Taskmaster's prompt with builds on stay within the budgets too", () => {
  // With an open PR too, the longest minion prompt (#760: the PR line's details come only then).
  const owner = systemPrompt(project, { ...minion, build: 7 }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app, null, [], { build: 7, branch: null, owner: true }, true, null, null, true);
  const taskmaster = systemPrompt(project, { ...minion, kind: 'coordinator' }, '/shared/929', '/shared/project', '/tickets', '/memory', [], true, app, null, [], null, true);
  assert.ok(owner.length <= BUDGET.minion, `build minion: ${owner.length} > ${BUDGET.minion}`);
  assert.ok(taskmaster.length <= BUDGET.taskmaster, `Taskmaster: ${taskmaster.length} > ${BUDGET.taskmaster}`);
});

test('saving instructions says what they cost, the same in the settings page and the Taskmaster tools', async () => {
  const { instructionCost } = await import('../src/prompt-cost.ts');
  const page = (await import('../public/prompt-cost.js')).instructionCost;
  assert.equal(instructionCost('x'.repeat(11_664)), 'These instructions are about 2.9k tokens; each 1k costs about $27 a week across minions.');
  assert.equal(instructionCost('x'.repeat(400)), 'These instructions are about 100 tokens; each 1k costs about $27 a week across minions.');
  assert.equal(instructionCost('  '), '');
  for (const n of [0, 400, 11_664, 32_000]) assert.equal(page('x'.repeat(n)), instructionCost('x'.repeat(n)));
});

// The kit's skill and agent descriptions (#708): Claude Code lists every one in the prefix each call re-reads,
// next to the built-in prompt, so they get a budget too. Characters of name + description, today's size
// plus about 5% on 2026-11-14. This never asks for shorter text: a skill with a longer description is a
// deliberate decision, made by raising the number with the reason in the commit message.
const KIT_BUDGET = 10_850; // +200 on 2026-11-24 for citadel:citadel-words, Citadel's glossary every scheme reads (#1773); +200 for the desktop-app skill (#1148, Build 6); +250 on 2026-11-19 for citadel:briefing (#1108); +300 for the trigger-eval descriptions (#1110); +200 on 2026-11-20 for the citadel:scout agent (#1156); +100 on 2026-11-23 for measured trigger fixes (#1744: research 55->85%, critique 60->87%)

/** A skill's or agent's `name` and `description` frontmatter, a folded or plain description joined on one line. */
function listing(file: string): string {
  const front = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const name = front.match(/^name:\s*(.*)$/m)?.[1] ?? '';
  const desc = front.match(/^description:\s*(?:[>|][-+]?)?\s*((?:.*)(?:\n[ \t]+.*)*)/m)?.[1] ?? '';
  return `${name}: ${desc.replace(/\s*\n\s*/g, ' ').trim()}`;
}

test("the kit's skill and agent descriptions stay within their budget", () => {
  const kit = new URL('../kit/', import.meta.url);
  const files = [
    ...readdirSync(new URL('skills/', kit)).map((d) => new URL(`skills/${d}/SKILL.md`, kit)),
    ...readdirSync(new URL('agents/', kit))
      .filter((f) => f.endsWith('.md'))
      .map((f) => new URL(`agents/${f}`, kit)),
  ].filter((f) => existsSync(f));
  const sizes = files.map((f) => ({ f: f.pathname.split('/kit/')[1], n: listing(f.pathname).length })).sort((a, b) => b.n - a.n);
  const total = sizes.reduce((s, x) => s + x.n, 0);
  assert.ok(
    total <= KIT_BUDGET,
    [
      `The kit's skill and agent descriptions are ${total} characters, over their budget of ${KIT_BUDGET} (about ${Math.round((total - KIT_BUDGET) / 4)} tokens over).`,
      'Every minion API call re-reads them; each 1k tokens costs about $27 a week (#699: reads plus rewrites, measured by #1263). A longer description is a deliberate choice: raise KIT_BUDGET in this file with the reason in the commit message.',
      'Longest now:',
      ...sizes.slice(0, 5).map((x) => `  ${x.n} ${x.f}`),
    ].join('\n'),
  );
});

// The tool definitions loaded up front (src/mcp.ts ALWAYS_LOAD) sit in the same prefix: characters of name, description and
// input schema, in a plain scheme, Citadel's (deploys), one with apps, and both. 12,900 at most before #1275, whose plan and
// ship tools are held to 3,700 characters (1k tokens at reports/quality-push-2026-11/tokens.md's 3.7 a token, the handoff's bar),
// plus 150 for hand_off_land's fix_proof (#1398: the proof field Cara's "Fixes ship; data still asks" needs, at its tersest).
const TOOLS_BUDGET = 13_500; // +250 for ask_question's twin-card refusal and its not_duplicate flag (#1508); down from 16,950 on 2026-11-22: ask_question, message_coordinator, hand_off_land and close_self keep their first sentence, the rest moved to their results and refusals (#1575; 13,151 that day)
const ADDED_BUDGET = 3_350; // down from 3,850 with #1575 (3,072 that day); +100 for hand_off_land's probe (#1741: the live check a 600+ line ship names, its shapes in its refusal)

test("a minion's always-loaded tool definitions stay within their budget", () => {
  for (const env of [{}, { COORDINATOR_DEPLOYS: '1' }, { COORDINATOR_HOME_CONTRAPTIONS: 'peek-auras' }, { COORDINATOR_DEPLOYS: '1', COORDINATOR_HOME_CONTRAPTIONS: 'peek-auras' }]) {
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
    const r = spawnSync(process.execPath, ['src/mcp.ts'], { input, encoding: 'utf8', env: { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1', COORDINATOR_APP_INSTRUCTIONS: '', COORDINATOR_DEPLOYS: '', COORDINATOR_HOME_CONTRAPTIONS: '', TMPDIR: '', ...env } }); // no TMPDIR: no held tool list (src/tool-hold.ts) left behind
    const tools = JSON.parse(r.stdout.split('\n')[0]).result.tools.filter((t: any) => t._meta?.['anthropic/alwaysLoad']);
    assert.deepEqual(tools.map((t: any) => t.name).sort(), ['ask_question', 'close_self', 'hand_off_land', 'message_coordinator', 'plan', 'set_properties', 'set_thread_status'], JSON.stringify(env));
    const sizes = tools.map((t: any) => ({ name: t.name, n: JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }).length }));
    const total = sizes.reduce((s: number, x: any) => s + x.n, 0);
    const added = sizes.filter((x: any) => x.name === 'plan' || x.name === 'hand_off_land').reduce((s: number, x: any) => s + x.n, 0);
    const lines = sizes.sort((a: any, b: any) => b.n - a.n).map((x: any) => `  ${x.n} ${x.name}`);
    assert.ok(added <= ADDED_BUDGET, [`plan and hand_off_land (${JSON.stringify(env)}) are ${added} characters, over the ${ADDED_BUDGET} (1k tokens) #1275 added them for. Trim them.`, ...lines].join('\n'));
    assert.ok(
      total <= TOOLS_BUDGET,
      [`A minion's always-loaded tools (${JSON.stringify(env)}) are ${total} characters, over their budget of ${TOOLS_BUDGET}.`, 'Every minion API call re-reads them; each 1k tokens costs about $22 a week. Trim, or raise TOOLS_BUDGET with the reason in the commit message.', ...lines].join('\n'),
    );
  }
});

// #760: a minion hears about ci-failures and dispatched-workflow watching only while its branch has an open PR.
test('the PR line says more only with an open PR', () => {
  const args = ['/shared/929', '/shared/project', '/tickets', '/memory', [], true, app] as const;
  // In the turn message since #878, so opening a PR no longer changes system-prompt.md.
  const without = turnContext(project, minion, ...args);
  const withPr = turnContext(project, minion, ...args, null, [], null, false, null, null, true);
  assert.equal(systemPrompt(project, minion, ...args), systemPrompt(project, minion, ...args, null, [], null, false, null, null, true));
  // One PR line either way; only its open-PR form carries ci-failures.
  for (const p of [without, withPr]) assert.equal(p.split('"[GitHub]: ..."').length, 2);
  assert.doesNotMatch(without, /ci-failures/);
  assert.match(withPr, /ci-failures/);
});
