// A minion's chat as text (public/chattext.js): the → links a Taskmaster's tool calls get, recaps, durations,
// the short wording of the server's notes and which authors collapse to one line. The notes and authors
// below are the server's own wording (src/routes/*.ts, src/runner.ts), so a drift between the two shows here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setView } from '../public/base.js';
import { firstSentence, machineAuthor, shortDuration, shortNote, ticketActionRef } from '../public/chattext.js';
import { elapsedText } from '../public/wait.js';

test('ticketActionRef links the minion a Taskmaster tool created, messaged or updated, from its result', () => {
  const act = (name, result) => ticketActionRef({ block: { name }, result });
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const rows = [
    // tool, result                                                                    want
    // create_ticket: "Created " + ticketLine, then notes on later lines (src/mcp.ts).
    ['mcp__coordinator__create_ticket', text('Created #15 Fix the bar\nmodel: opus'), { verb: 'Created', number: 15 }],
    ['mcp__coordinator__message_ticket', text('Sent. #12 Usage bar'), { verb: 'Messaged', number: 12 }],
    ['mcp__coordinator__update_ticket', text('Updated. #7 Peek\nbuild: 3'), { verb: 'Updated', number: 7 }],
    // The content may come as a plain string, or split over several parts.
    ['mcp__coordinator__message_ticket', { content: 'Sent. #12 Usage bar' }, { verb: 'Messaged', number: 12 }],
    ['mcp__coordinator__create_ticket', { content: [{ text: 'Created #1234 Big one' }, { text: 'Tagged: ui' }] }, { verb: 'Created', number: 1234 }],
    // A failed call links nothing, even if its text looks right.
    ['mcp__coordinator__create_ticket', { is_error: true, ...text('Created #15 Fix the bar') }, null],
    // Still running: no result yet.
    ['mcp__coordinator__create_ticket', undefined, null],
    // A minion's own thread server, or any other tool, is not a Taskmaster's action on a minion.
    ['mcp__thread__message_coordinator', text('Sent. #12 Usage bar'), null],
    ['Bash', text('Created #15 Fix the bar'), null],
    // update_schedule also says "Updated." but names a schedule, not a minion.
    ['mcp__coordinator__update_schedule', text('Updated. [3] Nightly: every day (`0 3 * * *`), type chore'), null],
    // The number has to be the minion's, at the start: not one quoted later, not "#15b".
    ['mcp__coordinator__create_ticket', text('Saved. See Created #15 Fix'), null],
    ['mcp__coordinator__create_ticket', text('Created #15b'), null],
    ['mcp__coordinator__list_tickets', text('#15 Fix the bar'), null],
    // message_ticket with start_now puts the start first (src/mcp.ts); it was still sent.
    ['mcp__coordinator__message_ticket', text('Started early, its brief first. Sent. #12 Usage bar'), { verb: 'Messaged', number: 12 }],
    ['mcp__coordinator__message_ticket', text('Not started early: it is running. Sent. #12 Usage bar'), { verb: 'Messaged', number: 12 }],
    // Held by the loop guard or left as held mail: not delivered yet, but it is that minion's (Josh, 2026-11-12).
    ['mcp__coordinator__message_ticket', text('Held, not delivered: the loop guard.\n#12 Usage bar'), { verb: 'Held for', number: 12 }],
    ['mcp__coordinator__message_ticket', text('Left as held mail: #12 has been idle over 55 minutes. Do not resend it.\n#12 Usage bar\ntype: bug'), { verb: 'Held for', number: 12 }],
    ['mcp__coordinator__message_ticket', text('Not started early: it is running. Held, not delivered: the loop guard.\n#12 Usage bar'), { verb: 'Held for', number: 12 }],
  ];
  for (const [name, result, want] of rows) assert.deepEqual(act(name, result), want, `${name}: ${JSON.stringify(result)}`);
});

test('firstSentence keeps the first sentence as plain text, cut at a word under the limit', () => {
  const rows = [
    // text, max                                    want
    ['Fixed the bar. Then the tests.', undefined, 'Fixed the bar.'],
    ['Shipped it! Now docs.', undefined, 'Shipped it!'],
    ['Ready to land? Say so.', undefined, 'Ready to land?'],
    // A stop inside a word or number is not the end of the sentence.
    ['Bumped v1.2 to v1.3. Done.', undefined, 'Bumped v1.2 to v1.3.'],
    ['Really?! Yes.', undefined, 'Really?!'],
    // Markdown marks go and line breaks fold to spaces.
    ['**Done**: `npm test` passes.\nNext I land.', undefined, 'Done: npm test passes.'],
    ['## Plan\n\n> Ship   it', undefined, 'Plan Ship it'],
    // No stop at all: the whole (flattened) text.
    ['  no full stop here  ', undefined, 'no full stop here'],
    [null, undefined, ''],
    [undefined, undefined, ''],
    // At the limit it stays whole; one over and it is cut back to the last whole word, with an ellipsis.
    ['one two th', 10, 'one two th'],
    ['one two thr', 10, 'one two…'],
    // A single word longer than the limit is cut mid-word.
    ['abcdefghijkl', 5, 'abcd…'],
    // A minion's number keeps its #, and a > in the text stays; only heading and quote marks at a line's start go.
    ['Merged in #473. Next', 200, 'Merged in #473.'],
    ['#473 is done. Next', 200, '#473 is done.'],
    ['a > b holds. Next', 200, 'a > b holds.'],
    ['## Done\n> Shipped it. Then', 200, 'Done Shipped it.'],
    // The default limit is 200.
    [`${'word '.repeat(39)}words`, undefined, `${'word '.repeat(39)}words`],
    [`${'word '.repeat(39)}wordsx`, undefined, `${'word '.repeat(38)}word…`],
  ];
  for (const [text, max, want] of rows) assert.equal(firstSentence(text, max), want, JSON.stringify([text, max]));
});

test('shortDuration rounds to seconds, then minutes and seconds, then minutes, then hours and minutes', () => {
  const S = 1000;
  const rows = [
    // ms           want
    [0, '0s'],
    [45 * S, '45s'],
    // Rounded to the nearest second, so 59.6s is already a minute.
    [59.4 * S, '59s'],
    [59.6 * S, '1m'],
    [60 * S, '1m'],
    [107 * S, '1m 47s'],
    [599 * S, '9m 59s'],
    [599.6 * S, '10m'],
    // From 10 minutes the seconds go, rounded into the minutes.
    [600 * S, '10m'],
    [629 * S, '10m'],
    [630 * S, '11m'],
    [3540 * S, '59m'],
    // From an hour: hours and minutes.
    [3600 * S, '1h 0m'],
    [3900 * S, '1h 5m'],
    [2 * 3600 * S + 29 * 60 * S, '2h 29m'],
    // Just under an hour mark rounds up into it: never "60m" or "1h 60m".
    [3570 * S, '1h 0m'],
    [3599 * S, '1h 0m'],
    [7170 * S, '2h 0m'],
  ];
  for (const [ms, want] of rows) assert.equal(shortDuration(ms), want, `${ms}ms`);
});

test('shortNote shortens the notes the server writes often and leaves the rest alone', () => {
  const rows = [
    // note as the server writes it                                                       short form
    // src/routes/tickets.ts: a person renames a minion, or the minion itself does ("Claude").
    ['Cara renamed this minion from "Usage bar" to "Usage bar: hours".', '✎ Cara renamed it “Usage bar: hours”'],
    ['Claude renamed this minion from "Usage bar" to "Usage bar: hours".', '✎ Renamed “Usage bar: hours”'],
    // Older threads said "ticket"; a title may span lines.
    ['Cara renamed this ticket from "Old" to "Two\nlines".', '✎ Cara renamed it “Two\nlines”'],
    // src/db.ts: the build migration's rename keeps its reason, shorter (Josh, 2026-11-12).
    ['Citadel renamed this minion from "Usage bar (Build 3)" to "Usage bar": its build shows in the minions list, so the title no longer carries it.', '✎ Citadel renamed it “Usage bar” (its build is in the list now)'],
    // src/runner.ts: a restart that couldn't resume the turn says why, and the reason stays.
    ['The server restarted during this turn, so it was interrupted. It was set to be dismissed, so it was not resumed.', '⚠ Interrupted by a server restart. It was set to be dismissed, so it was not resumed.'],
    // Model and effort: "from the next turn" while a turn runs, "from now on" otherwise.
    ['Cara set this minion to Opus 5.5 from the next turn.', '⚙ Cara: Opus 5.5 next turn'],
    ['Cara set this minion to high effort from now on.', '⚙ Cara: high effort'],
    ['Claude set this minion to the default model from now on.', '⚙ Claude: the default model'],
    ['Cara set this thread to low effort from the next turn.', '⚙ Cara: low effort next turn'],
    // src/routes/projects.ts: scheme instructions, approval rules and plugin folders.
    ["Cara updated the scheme instructions; they apply from each minion's next turn.", '📋 Cara updated the scheme instructions'],
    ["Cara cleared the scheme instructions; they apply from each minion's next turn.", '📋 Cara cleared the scheme instructions'],
    ["Cara updated the project instructions; they apply from each thread's next turn.", '📋 Cara updated the scheme instructions'],
    ["Josh updated the Citadel-wide instructions; they apply from each minion's next turn in every scheme.", '📋 Josh updated the Citadel-wide instructions'],
    ["Josh cleared the Citadel-wide instructions; they apply from each minion's next turn in every scheme.", '📋 Josh cleared the Citadel-wide instructions'],
    ["Cara set the approval rules to: Bash(gh pr merge:*), mcp__github__merge_pull_request. They apply from each minion's next turn.", '🔒 Cara set the approval rules: Bash(gh pr merge:*), mcp__github__merge_pull_request'],
    ["Cara set the approval rules to: none. They apply from each minion's next turn.", '🔒 Cara set the approval rules: none'],
    ["Josh set the plugin folders to: /srv/plugins/a, /srv/plugins/b. They apply from each minion's next turn.", '🔒 Josh set the plugin folders: /srv/plugins/a, /srv/plugins/b'],
    ['Cara reopened this minion.', '↻ Cara reopened it'],
    ['Cara reopened this ticket.', '↻ Cara reopened it'],
    // Older threads' wording of a restart, and their restore notes, which are hidden now.
    ['The server restarted during this turn, so it was interrupted.', '⚠ Interrupted by a server restart'],
    ["Restored this thread's Claude session from the app's database (it was missing on disk).", null],
    // Other notes, and near misses of the ones above, stay as they are.
    ['Stopped by user.', 'Stopped by user.'],
    ['Cara turned the Workflow tool on for this minion from now on.', 'Cara turned the Workflow tool on for this minion from now on.'],
    ["Cara set this minion's extra plugin folders to /srv/a from now on.", "Cara set this minion's extra plugin folders to /srv/a from now on."],
    ['Cara set this minion to Opus 5.5 later.', 'Cara set this minion to Opus 5.5 later.'],
    ['Cara reopened this minion', 'Cara reopened this minion'],
    ["Cara set the approval rules to: none. They apply from each minion's next turn. Ask Cody first.", "Cara set the approval rules to: none. They apply from each minion's next turn. Ask Cody first."],
    ['Cara renamed this minion from "A" to "B"', 'Cara renamed this minion from "A" to "B"'],
    ['Note: The server restarted during this turn, so it was interrupted.', 'Note: The server restarted during this turn, so it was interrupted.'],
    ["Note: Restored this thread's Claude session from the app's database", "Note: Restored this thread's Claude session from the app's database"],
  ];
  for (const [text, want] of rows) assert.equal(shortNote(text), want, text);
});

test('machineAuthor names the machines that write to a chat and returns null for a person', () => {
  const rows = [
    // author as the server stores it                                   shown as
    // Another scheme's Taskmaster (src/routes/projects.ts); to Citadel's it also says whose ask it is.
    ['Taskmaster of Delve', 'Delve Taskmaster'],
    ['Taskmaster of Delve, for Josh, a Citadel member', 'Delve Taskmaster, for Josh, a Citadel member'],
    ['Taskmaster of Delve, for no one, not a Citadel member', 'Delve Taskmaster, for no one, not a Citadel member'],
    // A scheme name with a comma comes quoted, and stays whole.
    ['Taskmaster of "Rock, Paper", for Cara, a Citadel member', '"Rock, Paper" Taskmaster, for Cara, a Citadel member'],
    // A minion messaging its Taskmaster (src/routes/tickets.ts): "#N Title".
    ['#12 Usage bar', '#12 Usage bar'],
    // The app itself, GitHub, and a contraption's ask from before #316 (src/contraption-asks.ts).
    ['Citadel', 'Citadel'],
    ['GitHub', 'GitHub'],
    ['Contraption Peek, for Josh, a Citadel member', 'Contraption Peek, for Josh, a Citadel member'],
    ['Contraption Peek, for Josh, not a Citadel member', 'Contraption Peek, for Josh, not a Citadel member'],
    // People, and names that only look close.
    ['Cara', null],
    ['Josh', null],
    ['#12', null],
    ['Taskmaster of', null],
    ['Contraption Peek', null],
    ['github', null],
    ['', null],
    [undefined, null],
    [null, null],
  ];
  for (const [author, want] of rows) assert.equal(machineAuthor(author), want, String(author));
});

test('machineAuthor shows this scheme\'s own Taskmaster by the scheme\'s name, from the view', (t) => {
  t.after(() => setView(null));
  // The scheme isn't loaded yet: just "Taskmaster".
  setView({ kind: 'thread', projectId: 5, projects: [] });
  assert.equal(machineAuthor('Taskmaster'), 'Taskmaster');
  assert.equal(machineAuthor('Coordinator'), 'Taskmaster');
  // Old threads stored "Coordinator"; both read as the scheme's Taskmaster.
  setView({ kind: 'project', projectId: 2, projects: [{ id: 2, name: 'Citadel' }] });
  assert.equal(machineAuthor('Taskmaster'), 'Citadel Taskmaster');
  assert.equal(machineAuthor('Coordinator'), 'Citadel Taskmaster');
});

test('elapsedText (wait.js) counts a running turn in whole seconds, then minutes with two-digit seconds, then hours', () => {
  const S = 1000;
  const rows = [
    // ms           want
    // A start stamped a moment in the future (clock skew) reads as 0s, not a negative time.
    [-5 * S, '0s'],
    [0, '0s'],
    // Whole seconds, rounded down.
    [999, '0s'],
    [59.999 * S, '59s'],
    [60 * S, '1m 00s'],
    [65 * S, '1m 05s'],
    [3599.999 * S, '59m 59s'],
    [3600 * S, '1h 0m'],
    [3659 * S, '1h 0m'],
    [3660 * S, '1h 1m'],
    [7199 * S, '1h 59m'],
    [25 * 3600 * S, '25h 0m'],
  ];
  for (const [ms, want] of rows) assert.equal(elapsedText(ms), want, `${ms}ms`);
});
