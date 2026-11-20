// The cross-scheme link check (#327): a bare #N links to this scheme's own minion, so "#83" said about
// Peek Auras #83 opened Citadel #83 (Josh, 2026-11-05: "Did you mean to link me to Peek Auras #83?").
// Since #404 only a #N right after another scheme's name counts: 99 of the first 109 send-backs, which
// counted any #N in a paragraph naming one, were this scheme's own minions (Cara picked the fix, 2026-11-08).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check, SENT_BACK } from '../src/link-check.ts';
import { schemeRefs } from '../src/runner.ts';
import { schemeRefsHooks } from '../src/turn-launch.ts';
import { testPins } from './helpers.ts';

const { SCHEME_REFS } = testPins();
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
// The chat reads "Peek Auras #60" as Peek Auras' minion but "#71" and "#83" after it as Citadel's.
const peek = 'Peek Auras #60, #71 and #83 can carry on.';

test('flags a bare #N the chat links here though it sits right after another scheme\'s name', () => {
  const [a, b] = strayRefs(peek, { ...refs, others: [...refs.others, 'Theory of Crafting'] });
  assert.deepEqual([a.n, b.n], [71, 83]);
  assert.equal(b.other, 'Peek Auras');
  assert.equal(b.opens, 'Citadel #83 "Old sidebar spacing" (closed)');
  assert.equal(a.opens, 'nothing: Citadel has no #71');
  // The shapes of the real catches in the first 109 send-backs (#404).
  const all = { ...refs, others: ['Peek Auras', 'Delve', 'Theory of Crafting', 'Threadspace'] };
  const strays = (text: string) => strayRefs(text, all).map((f) => `${f.other} #${f.n}`);
  assert.deepEqual(strays("Then it says whether Peek Auras' #81, #89 and #91 plans need posting again."), ['Peek Auras #81', 'Peek Auras #89', 'Peek Auras #91']);
  assert.deepEqual(strays('The server is healthy, so ToC #60 and ToC #59 can re-run their checks.'), ['Theory of Crafting #60', 'Theory of Crafting #59']);
  assert.deepEqual(strays("Obsidian → Threadspace (Obsidian's new name) #24: done."), ['Threadspace #24']);
  assert.deepEqual(strays('Now also creative work (Threadspace #25, #26).'), ['Threadspace #26']);
  assert.deepEqual(strays('Delve minion #5 and #6 wait; delve\'s #7 / #8 too.'), ['Delve #6', 'Delve #8']);
});

test('a short form counts only written as one, not as the common word its letters spell (#468 S06-8)', () => {
  const sandbox = { ...refs, others: ['Idea Sandbox'] };
  const strays = (text: string) => strayRefs(text, sandbox).map((f) => `${f.other} #${f.n}`);
  assert.deepEqual(strays("This is #12's fix."), []);
  assert.deepEqual(strays('Is #12 done yet?'), []);
  assert.deepEqual(strays('Then IS #12 can carry on.'), ['Idea Sandbox #12']);
});

test('lets through own minions near another scheme\'s name, scoped numbers, PRs, issues and code', () => {
  for (const ok of [
    '#320 landed.',
    'Peek Auras #83 should land tomorrow.',
    'Peek Auras\'s #83 and Delve minion #12 are both waiting.',
    'Peek Auras minions #5 and #6 are waiting.',
    'Minion #83 in Peek Auras is waiting.',
    'Peek Auras is green; PR #10 and issue #4 are ours.',
    'Peek Auras PR #44, #45 and #46 are queued.',
    'Peek Auras asked about `Peek Auras #83, #84`.',
    'Citadel #5 and #6 are ours.',
    // Today's false alarms (#404): this scheme's own minions, mentioned near another scheme's name.
    'I passed #390\'s question to Delve\'s Taskmaster with its write-up.',
    'Transdata is waiting on the kit fix; #236 has it, and #385 told Delve.',
    'Peek Auras\'s Taskmaster says the aura flicker fix is in review: #83 should land tomorrow.',
    'Delve is waiting on #200 and #320.',
  ]) assert.deepEqual(flagged(ok), [], ok);
  assert.deepEqual(strayRefs(peek, { ...refs, others: [] }), []);
  // This scheme's own name before a number is no other scheme's, even when another's name is in it.
  assert.deepEqual(strayRefs('Delve Two #3 and #4 are ours.', { ...refs, scheme: 'Delve Two', others: ['Delve'] }), []);
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
  assert.match(v!.reason, /answer with just KEEP: your first reply then stands as written\.$/);
  assert.equal(await check({ last_assistant_message: peek, prompt_id: 'p1', stop_hook_active: true }, cfg), null);
  assert.equal(await check({ last_assistant_message: '#320 shipped.', prompt_id: 'p2' }, cfg), null);
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
  assert.equal(checkCall({ tool_name: 'mcp__coordinator__message_ticket', tool_input: { text: 'Peek Auras #60 and Peek Auras #83 should land tomorrow.' } }, { ...cfg, sent: join(root, 'sent-2') }), null);
  const re = new RegExp(SCHEME_REFS_MATCHER);
  for (const t of ['mcp__coordinator__message_ticket', 'mcp__thread__message_coordinator', 'mcp__thread__ask_question', 'mcp__thread__propose_plan']) assert.match(t, re);
  assert.doesNotMatch('mcp__coordinator__message_taskmaster', re);
});

test('the hook script prints a deny decision, or nothing', () => {
  const entry = schemeRefsHooks(refsFile, join(root, 'sent-script'));
  assert.equal(entry.matcher, SCHEME_REFS_MATCHER);
  const [node, script, config] = entry.hooks[0].command.split(' ').slice(1).map((s: string) => s.slice(1, -1));
  assert.equal(script, SCHEME_REFS);
  const run = (input: object | string, c = config) => spawnSync(node, [script, c], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const bad = { hook_event_name: 'PreToolUse', tool_name: 'mcp__coordinator__message_ticket', tool_input: { text: peek } };
  assert.equal(JSON.parse(run(bad).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(existsSync(join(root, 'sent-script')));
  assert.deepEqual([run(bad).status, run(bad).stdout], [0, '']);
  assert.deepEqual([run('{bad').status, run('{bad').stdout], [0, '']);
});
