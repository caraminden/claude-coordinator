// The cross-scheme link check (#327): a bare #N links to this scheme's own minion, so "#83" said about
// Peek Auras #83 opened Citadel #83 (Josh, 2026-11-05: "Did you mean to link me to Peek Auras #83?").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check, SENT_BACK } from '../src/link-check.ts';
import { SCHEME_REFS, schemeRefs, schemeRefsHooks } from '../src/runner.ts';
import { checkCall, SCHEME_REFS_MATCHER, strayRefs, type SchemeRefs } from '../src/scheme-refs.ts';
import type { Project, Ticket } from '../src/db.ts';

const refs: SchemeRefs = {
  scheme: 'Citadel',
  others: ['Peek Auras', 'Delve'],
  minions: {
    83: { title: 'Old sidebar spacing', closed: true },
    300: { title: 'Aura colours in the legend', closed: false },
    320: { title: 'Usage bar in the top bar', closed: false },
    327: { title: 'Catch bare #N for other schemes', closed: false },
  },
};
const flagged = (text: string) => strayRefs(text, refs).map((f) => f.n);
const peek = 'Peek Auras\'s Taskmaster says the aura flicker fix is in review: #83 should land tomorrow.';

test('flags a bare #N about another scheme that opens a closed minion here (the Peek Auras #83 case)', () => {
  const [f] = strayRefs(peek, refs);
  assert.equal(f.n, 83);
  assert.equal(f.other, 'Peek Auras');
  assert.equal(f.opens, 'Citadel #83 "Old sidebar spacing" (closed)');
  // Missing here, or open but about something else.
  assert.deepEqual(flagged('Delve is waiting on #200 and #320.'), [200, 320]);
});

test('lets through own minions, scoped numbers, PRs, issues and code', () => {
  for (const ok of [
    '#320 landed.',
    '#83 was closed long ago.',
    'Peek Auras #83 should land tomorrow.',
    'Peek Auras\'s #83 and Delve minion #12 are both waiting.',
    'Minion #83 in Peek Auras is waiting.',
    'Peek Auras is green; PR #10 and issue #4 are ours.',
    'Peek Auras asked about `#83`.',
    // Open here, and the paragraph is about what its title says.
    'Peek Auras wanted the same aura colours, so #300 covers both.',
    // Past the newest number: likely a minion started this turn.
    'Started #400 for the Delve handoff.',
    // Another paragraph names the scheme, not this one.
    'Peek Auras is fine.\n\n#83 stays closed.',
  ]) assert.deepEqual(flagged(ok), [], ok);
  assert.deepEqual(strayRefs(peek, { ...refs, others: [] }), []);
});

test('the snapshot holds the scheme\'s numbered minions and the other schemes\' names', () => {
  const p = (id: number, name: string) => ({ id, name }) as Project;
  const t = (number: number | null, title: string, status = 'idle') => ({ number, title, status }) as Ticket;
  assert.deepEqual(schemeRefs(p(2, 'Citadel'), [p(1, 'Delve'), p(2, 'Citadel')], [t(null, 'Taskmaster'), t(5, 'Five', 'closed'), t(6, 'Six')]), {
    scheme: 'Citadel', others: ['Delve'], minions: { 5: { title: 'Five', closed: true }, 6: { title: 'Six', closed: false } },
  });
});

const root = mkdtempSync(join(tmpdir(), 'scheme-refs-'));
after(() => rmSync(root, { recursive: true, force: true }));
const refsFile = join(root, 'scheme-refs.json');
writeFileSync(refsFile, JSON.stringify(refs));

test('the final reply is sent back once, naming what the link opens; the second try goes through', async () => {
  const cfg = { cwd: root, roots: [root], nudged: join(root, 'nudged'), refs: refsFile };
  const v = await check({ last_assistant_message: peek, prompt_id: 'p1' }, cfg);
  assert.equal(v?.decision, 'block');
  assert.ok(v!.reason.startsWith(SENT_BACK), v!.reason);
  assert.match(v!.reason, /#83 here opens Citadel #83 "Old sidebar spacing" \(closed\)\. Meant Peek Auras's\? Write "Peek Auras #83"\./);
  assert.equal(await check({ last_assistant_message: peek, prompt_id: 'p1', stop_hook_active: true }, cfg), null);
  assert.equal(await check({ last_assistant_message: '#320 landed.', prompt_id: 'p2' }, cfg), null);
  // No snapshot, no check.
  assert.equal(await check({ last_assistant_message: peek }, { cwd: root, roots: [root] }), null);
});

test('message_ticket and cards are refused once per number; message_taskmaster is left alone', () => {
  const cfg = { refs: refsFile, sent: join(root, 'sent-1') };
  const msg = { tool_name: 'mcp__coordinator__message_ticket', tool_input: { ticket_id: 9, text: peek } };
  const v = checkCall(msg, cfg);
  assert.equal(v?.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(v!.hookSpecificOutput.permissionDecisionReason, /Write "Peek Auras #83"/);
  assert.equal(checkCall(msg, cfg), null);
  assert.equal(checkCall({ tool_name: 'mcp__coordinator__message_ticket', tool_input: { text: 'Peek Auras #83 should land tomorrow.' } }, { ...cfg, sent: join(root, 'sent-2') }), null);
  const re = new RegExp(SCHEME_REFS_MATCHER);
  for (const t of ['mcp__coordinator__message_ticket', 'mcp__thread__message_coordinator', 'mcp__thread__ask_question', 'mcp__thread__propose_plan']) assert.match(t, re);
  assert.doesNotMatch('mcp__coordinator__message_taskmaster', re);
});

test('the hook script prints a deny decision, or nothing', () => {
  const entry = schemeRefsHooks(refsFile, join(root, 'sent-script'));
  assert.equal(entry.matcher, SCHEME_REFS_MATCHER);
  const [node, script, config] = entry.hooks[0].command.split(' ').map((s: string) => s.slice(1, -1));
  assert.equal(script, SCHEME_REFS);
  const run = (input: object | string, c = config) => spawnSync(node, [script, c], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const bad = { hook_event_name: 'PreToolUse', tool_name: 'mcp__coordinator__message_ticket', tool_input: { text: peek } };
  assert.equal(JSON.parse(run(bad).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(existsSync(join(root, 'sent-script')));
  assert.deepEqual([run(bad).status, run(bad).stdout], [0, '']);
  assert.deepEqual([run('{bad').status, run('{bad').stdout], [0, '']);
});
