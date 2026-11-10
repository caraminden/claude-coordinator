// The wording check (#313): "fold" means merging work, and nothing else reaches people (Cara, 2026-11-04).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check, SENT_BACK } from '../src/link-check.ts';
import { WORDING, WORDING_MATCHER, wordingHooks } from '../src/turn-launch.ts';
import { checkCall, misusedWords } from '../src/wording.ts';

const flagged = (text: string) => misusedWords(text).map((f) => f.word);

test('flags fold in any other sense: Peek Auras #34\'s handoff, and the brief that asked for this check', () => {
  assert.deepEqual(flagged('**Folding in (core tooling)**'), ['Folding in']);
  assert.deepEqual(flagged('The Taskmaster starts a fold-in minion.'), ['fold-in']);
  assert.deepEqual(flagged('Then refit everything in the fold.'), ['fold']);
  assert.deepEqual(flagged('the fold'), ['fold']);
  const brief = "1. **A turn's final reply.** There's already a Stop hook that sends a reply back once when its file links won't open: src/link-check.ts, added in runner.ts `linkCheckHooks`. Follow that pattern, or fold this check into the same hook if that's cleaner. The `SENT_BACK` / `Runner.replaceSentBack` handling has to keep working.";
  assert.deepEqual(flagged(brief), ['fold']);
  assert.equal(misusedWords(brief)[0].sentence, "Follow that pattern, or fold this check into the same hook if that's cleaner.");
  assert.deepEqual(flagged('It folds the old notes in. Then we folded them again.'), ['folds', 'folded']);
});

test('allows fold for merging, gos, and words that only contain it', () => {
  for (const ok of [
    'fold it', 'Fold it.', 'Looks good, fold it and deploy.', 'fold #196 into build 8', 'Fold 196.', 'It was folded into main yesterday.',
    'the folder', 'scaffold the page', 'casefold the names', 'unfold, manifold, twofold',
    'Use `fold` here.', 'Before:\n```\nthe fold\n```\nafter.', 'Open src/fold-panel.ts and ticket/313-check-for-misused-fold.',
    '"Fold" means merging work.', 'The word \'fold\' is reserved.',
    'Ready when you are: once the review is green, fold the branch.', 'Fold the PR when CI is green.',
    'We can fold this one when it lands.',
  ]) assert.deepEqual(flagged(ok), [], ok);
});

test('nearby means the same sentence or within 8 words, not further', () => {
  assert.deepEqual(flagged('Main is green. Fold this in.'), []);
  assert.deepEqual(flagged('Main is green and everything else looks fine to me now. Fold this in.'), ['Fold']);
  // "fold it" followed by "into" isn't a go.
  assert.deepEqual(flagged('Fold it into the plan.'), ['Fold']);
});

test('HTML: tags, scripts and code are not prose', () => {
  assert.deepEqual(misusedWords('<details class="fold"><summary>More</summary><code>fold</code><script>fold()</script></details>', true), []);
  assert.deepEqual(misusedWords('<p>Hidden in the <b>fold</b>.</p>', true).map((f) => f.word), ['fold']);
});

const root = mkdtempSync(join(tmpdir(), 'wording-'));
after(() => rmSync(root, { recursive: true, force: true }));
const shared = join(root, 'shared/project');
mkdirSync(shared, { recursive: true });

test('a message, card or note is refused once per sentence, with the sentence and why', () => {
  const cfg = { shared: [shared], sent: join(root, 'sent-1') };
  const msg = { tool_name: 'mcp__thread__message_coordinator', tool_input: { text: 'Please start a fold-in minion for the new data.' } };
  const v = checkCall(msg, cfg);
  assert.equal(v?.hookSpecificOutput.permissionDecision, 'deny');
  const why = v!.hookSpecificOutput.permissionDecisionReason;
  assert.ok(why.includes('"Please start a fold-in minion for the new data."'), why);
  assert.match(why, /means only merging work/);
  assert.match(why, /a collapsed section/);
  // Sent again as it was: through, so a false alarm never loops.
  assert.equal(checkCall(msg, cfg), null);
  // A new sentence in the same turn gets its own refusal; nested card text counts.
  const card = { tool_name: 'mcp__thread__ask_question', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'Fold the legend' }, { label: 'Keep it' }] }] } };
  assert.equal(checkCall(card, cfg)?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(checkCall({ tool_name: 'mcp__coordinator__update_ticket', tool_input: { ticket_id: 3, note: 'merged, fold #3 next' } }, cfg), null);
});

test('only .md and .html writes into a shared folder are checked', () => {
  const cfg = { shared: [shared], sent: join(root, 'sent-2') };
  const write = (file_path: string, content = '# Plan\n\nFolding in (core tooling)\n') => checkCall({ tool_name: 'Write', tool_input: { file_path, content } }, cfg);
  assert.equal(write(join(root, 'elsewhere/plan.md')), null);
  assert.equal(write(join(shared, 'notes.txt')), null);
  assert.equal(write(join(shared, 'handoffs/plan.md'))?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(checkCall({ tool_name: 'Edit', tool_input: { file_path: join(shared, 'r.html'), old_string: 'x', new_string: '<p>It sits below the fold.</p>' } }, cfg)?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(checkCall({ tool_name: 'Bash', tool_input: { command: 'echo the fold' } }, cfg), null);
});

test('the final reply is sent back in the link check\'s send-back, so the rewrite replaces it', async () => {
  const v = await check({ last_assistant_message: 'Done. The legend now sits in a fold.' }, { cwd: root, roots: [root] });
  assert.equal(v?.decision, 'block');
  assert.ok(v!.reason.startsWith(SENT_BACK), v!.reason);
  assert.match(v!.reason, /- "The legend now sits in a fold\." \(fold\)/);
  assert.equal(await check({ last_assistant_message: 'Done, fold it when ready.' }, { cwd: root, roots: [root] }), null);
});

test('the hook script prints a deny decision, or nothing', () => {
  const entry = wordingHooks([shared], join(root, 'sent-script'));
  assert.equal(entry.matcher, WORDING_MATCHER);
  for (const t of ['mcp__thread__message_coordinator', 'mcp__coordinator__message_ticket', 'mcp__thread__propose_plan', 'Write', 'Edit']) assert.match(t, new RegExp(WORDING_MATCHER));
  assert.doesNotMatch('mcp__thread__set_properties', new RegExp(WORDING_MATCHER));
  const [node, script, config] = entry.hooks[0].command.split(' ').map((s: string) => s.slice(1, -1));
  assert.equal(script, WORDING);
  const run = (input: object | string, c = config) => spawnSync(node, [script, c], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  const bad = { hook_event_name: 'PreToolUse', tool_name: 'mcp__thread__propose_plan', tool_input: { summary: 'Plan', plan: 'Fold the new data into the templates.' } };
  const denied = run(bad);
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(existsSync(join(root, 'sent-script')));
  assert.deepEqual([run(bad).status, run(bad).stdout], [0, '']);
  // A check that can't run never holds up the call.
  assert.deepEqual([run('{bad').status, run('{bad').stdout], [0, '']);
  assert.equal(run(bad, '{bad').stdout, '');
});
