// The wording check (#313, #1021): "fold" is retired, and "merge" is only for a build branch, never main (Cara, 2026-11-19).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { check, SENT_BACK } from '../src/link-check.ts';
import { WORDING_MATCHER, wordingHooks } from '../src/turn-launch.ts';
import { testPins } from './helpers.ts';

const { WORDING } = testPins();
import { checkCall, explain, misusedWords } from '../src/wording.ts';

const flagged = (text: string) => misusedWords(text).map((f) => f.word);

test("flags fold in every sense, the old gos included: Peek Auras #34's handoff, and the brief that asked for this check", () => {
  assert.deepEqual(flagged('**Folding in (core tooling)**'), ['Folding in']);
  assert.deepEqual(flagged('The Taskmaster starts a fold-in minion.'), ['fold-in']);
  assert.deepEqual(flagged('Then refit everything in the fold.'), ['fold']);
  assert.deepEqual(flagged('the fold'), ['fold']);
  const brief =
    "1. **A turn's final reply.** There's already a Stop hook that sends a reply back once when its file links won't open: src/link-check.ts, added in runner.ts `linkCheckHooks`. Follow that pattern, or fold this check into the same hook if that's cleaner. The `SENT_BACK` / `Runner.replaceSentBack` handling has to keep working.";
  assert.deepEqual(flagged(brief), ['fold']);
  assert.equal(misusedWords(brief)[0].sentence, "Follow that pattern, or fold this check into the same hook if that's cleaner.");
  assert.deepEqual(flagged('It folds the old notes in. Then we folded them again.'), ['folds', 'folded']);
  for (const old of ['fold it', 'Looks good, fold it and deploy.', 'fold #196 into build 8', 'Fold 196.', 'It was folded into main yesterday.', 'Fold the PR when CI is green.']) {
    assert.equal(flagged(old).length, 1, old);
  }
});

test('leaves fold alone in words that only contain it, quoted, or as code', () => {
  for (const ok of ['the folder', 'scaffold the page', 'casefold the names', 'case-fold the names', 'unfold, manifold, twofold', 'Use `fold` here.', 'Before:\n```\nthe fold\n```\nafter.', 'Open src/fold-panel.ts and ticket/313-check-for-misused-fold.', '"Fold" is retired.', "The word 'fold' is retired."])
    assert.deepEqual(flagged(ok), [], ok);
});

test('flags merge said of main: gos, "to main", "ready to merge", merged PRs and the merge card', () => {
  for (const [text, word] of [
    ['Merge it?', 'Merge it'],
    ['So merge this.', 'merge this'],
    ['Merge #196 when ready.', 'Merge #196'],
    ['merge PR 12 now', 'merge PR 12'],
    ['Ready to merge.', 'Ready to merge'],
    ['Merge 196.', 'Merge 196'],
    ['PR #12 merged.', 'PR #12 merged'],
    ['PR 12 was merged an hour ago.', 'PR 12 was merged'],
    ['It was merged to main yesterday.', 'merged to main'],
    ['I merged the fix into main.', 'merged the fix into main'],
    ['Review this, then merge it into main.', 'merge it into main'],
    ['Only merged PRs count.', 'merged PRs'],
    ['It asks with a merge card.', 'merge card'],
  ])
    assert.deepEqual(flagged(text), [word], text);
});

test("leaves merge alone for a build, git, and every shape that can't be told from git's", () => {
  for (const ok of [
    'Merge it into Build 3.',
    'PR #12 merged into the build.',
    'Merged into Build 3, not live until the build ships',
    'Merge it, the feeder is green.',
    'Merge them with git.',
    'There was a merge conflict.',
    'merged the branches',
    'the merge commit',
    'Ship it.',
    'Ready to ship.',
    'PR #12 shipped.',
    '`merge it`',
    '"merge it" still counts as a go.',
  ])
    assert.deepEqual(flagged(ok), [], ok);
});

test("flags land said of main: a change going onto main ships (Cara, 2026-11-19, on #1020's card)", () => {
  for (const [text, word] of [
    ['Land it?', 'Land it'],
    ['Should I land #12?', 'land #12'],
    ['land PR 41 now', 'land PR 41'],
    ['Ready to land.', 'Ready to land'],
    ['It landed on main an hour ago.', 'landed on main'],
    ['#12 has landed.', '#12 has landed'],
    ['PR #40 landed.', 'PR #40 landed'],
    ['Only landed PRs count.', 'landed PRs'],
    ['Land 196 now.', 'Land 196'],
    ['It asks with a land card.', 'land card'],
    ['It waits in the land line.', 'land line'],
  ])
    assert.deepEqual(flagged(text), [word], text);
});

test('leaves land alone in code, tool and file names and its other senses', () => {
  for (const ok of ['Ship it.', '#12 has shipped.', 'Call hand_off_land now.', 'tools/land.sh refused it.', 'Its branch is land/ticket-12.', '`land it`', '"land it" still counts as a go.', 'The findings land in this chat.', 'Retries until the write lands.', 'The fix lands in main.py.'])
    assert.deepEqual(flagged(ok), [], ok);
});

test('nearby means the same sentence or within 8 words, not further', () => {
  assert.deepEqual(flagged('The build is green. Merge it.'), []);
  assert.deepEqual(flagged('The build is green and everything else looks fine to me now. Merge it.'), ['Merge it']);
  // Said to be main, nothing near makes it fine.
  assert.deepEqual(flagged('The build is green, so merge the fix into main.'), ['merge the fix into main']);
});

test('HTML: tags, scripts and code are not prose', () => {
  assert.deepEqual(misusedWords('<details class="fold"><summary>More</summary><code>fold</code><script>fold()</script></details>', true), []);
  assert.deepEqual(
    misusedWords('<p>Hidden in the <b>fold</b>.</p>', true).map((f) => f.word),
    ['fold'],
  );
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
  assert.match(why, /no longer says "fold"/);
  assert.match(why, /"ship" for a change going onto main/);
  assert.match(why, /a collapsed section/);
  // Sent again as it was: through, so a false alarm never loops.
  assert.equal(checkCall(msg, cfg), null);
  // A new sentence in the same turn gets its own refusal; nested card text counts.
  const card = { tool_name: 'mcp__thread__ask_question', tool_input: { questions: [{ question: 'Which?', options: [{ label: 'Fold the legend' }, { label: 'Keep it' }] }] } };
  assert.equal(checkCall(card, cfg)?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(checkCall({ tool_name: 'mcp__coordinator__update_ticket', tool_input: { ticket_id: 3, note: 'shipped, ship #3 next' } }, cfg), null);
  const land = checkCall({ tool_name: 'mcp__thread__set_thread_status', tool_input: { note: 'tested, ready to land' } }, cfg)!.hookSpecificOutput.permissionDecisionReason;
  assert.match(land, /"ships" now, not "lands"/);
  assert.match(land, /"ready to ship"/);
  const merge = checkCall({ tool_name: 'mcp__thread__message_coordinator', tool_input: { text: 'PR #40 is ready to merge.' } }, cfg)!.hookSpecificOutput.permissionDecisionReason;
  assert.match(merge, /- "PR #40 is ready to merge\." \(ready to merge\)/);
  assert.match(merge, /"ready to ship"/);
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

test("the final reply is sent back in the link check's send-back, so the rewrite replaces it", async () => {
  const v = await check({ last_assistant_message: 'Done. The legend now sits in a fold.' }, { cwd: root, roots: [root] });
  assert.equal(v?.decision, 'block');
  assert.ok(v!.reason.startsWith(SENT_BACK), v!.reason);
  assert.match(v!.reason, /- "The legend now sits in a fold\." \(fold\)/);
  assert.equal(await check({ last_assistant_message: 'Done, ship it when ready.' }, { cwd: root, roots: [root] }), null);
});

test('the hook script prints a deny decision, or nothing', () => {
  const entry = wordingHooks([shared], join(root, 'sent-script'));
  assert.equal(entry.matcher, WORDING_MATCHER);
  for (const t of ['mcp__thread__message_coordinator', 'mcp__coordinator__message_ticket', 'mcp__thread__propose_plan', 'Write', 'Edit']) assert.match(t, new RegExp(WORDING_MATCHER));
  assert.doesNotMatch('mcp__thread__set_properties', new RegExp(WORDING_MATCHER));
  const [node, script, config] = entry.hooks[0].command
    .split(' ')
    .slice(1)
    .map((s: string) => s.slice(1, -1));
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

const fence = (tag: string, body: string) => `Run this:\n\n\`\`\`${tag}\n${body}\n\`\`\`\n`;

test('flags a <stand-in> in a command block people run, naming it and quoting the rule', () => {
  for (const tag of ['powershell-admin', 'powershell', 'wsl', 'fish', 'bash', 'cmd', 'sh']) {
    assert.deepEqual(flagged(fence(tag, 'ssh <the address>')), ['<the address>'], tag);
  }
  assert.deepEqual(flagged(fence('wsl', 'wsl -d <distro> -- ls <path>')), ['<distro>']);
  const [f] = misusedWords(fence('fish', 'cd <path>'));
  assert.equal(f.sentence, 'cd <path>');
  assert.match(explain([f]), /just put the address into their shell commands/);
  assert.match(explain([f]), /<path>|real value/);
});

test('lets a secret stand-in through', () => {
  for (const ok of ['<token>', '<password>', '<api key>', '<Secret>', '<your-api-key>', '<GitHub token>']) {
    assert.deepEqual(flagged(fence('bash', `curl -H "Authorization: ${ok}" x`)), [], ok);
  }
});

test('lets shell syntax through: redirects, heredocs, <# #> comments, generics; and other fences', () => {
  for (const ok of ['sort < in.txt > out.txt', 'cat <<EOF > f\nhi\nEOF', '<# the address #> ls', '$x = New-Object List<string>', 'cmd <in >out']) {
    assert.deepEqual(flagged(fence('powershell', ok)), [], ok);
  }
  assert.deepEqual(flagged(fence('json', '{"a": "<the address>"}')), []);
  assert.deepEqual(flagged('Use `ssh <the address>` here, or <the address> in prose.'), []);
});

test('the hook sends a reply with a stand-in back once', () => {
  const input = { tool_name: 'mcp__x__send', tool_input: { text: fence('bash', 'ssh <the address>') } };
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  const cfg = { shared: [], sent: join(dir, 'sent.json') };
  assert.match(JSON.stringify(checkCall(input, cfg)), /the address/);
  assert.equal(checkCall(input, cfg), null);
  rmSync(dir, { recursive: true });
});
