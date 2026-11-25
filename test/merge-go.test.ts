import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals, mcpMerge, mergeGo, mergeTarget, plainMerge, type Go, type GoPlace, type GoStore, type MergeTarget } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { parseMerge, type PrInfo } from '../src/merge-card.ts';
import { Runner } from '../src/runner.ts';
import { agentToken, bootServer, REPO, stopProcs, stopTurns, turnSaved, until, testPins } from './helpers.ts';
testPins();

// A person's own typed "merge it" lets the turn that reads it merge once with no card (#201). Only
// the messages route's person path marks a message typed; relays, card answers and agents never can.
const root = mkdtempSync(join(tmpdir(), 'merge-go-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the words ----------

test('a go is a whole message that only says land (or the older merge or fold), with at most one PR number', () => {
  for (const [text, pr] of [
    ['Ship it', null],
    ['ok, ship it', null],
    ['ship #12', 12],
    ['you can ship 196', 196],
    ['Land it', null],
    ['ok, land it', null],
    ['land #12', 12],
    ['you can land 196', 196],
    ['Land it please.', null],
    ['Merge it', null],
    ['fold it', null],
    ['fold', null],
    ['merge pls', null],
    ['pls merge 205', 205],
    ['Fold it plz', null],
    ['Merge it.', null],
    ['ok, merge it', null],
    ['LGTM, merge it!', null],
    ['go ahead and merge', null],
    ['ship it', null],
    ['fold it in', null],
    ['please merge it', null],
    ['merge it please', null],
    ['yes merge PR #191', 191],
    ['you can fold 196', 196],
    ['ok, you can merge it', null],
    ['merge #188 please', 188],
    ['merge 42', 42],
    ['Merge  PR 7 now', 7],
    ['  squash it  ', null],
  ] as const)
    assert.deepEqual(mergeGo(text), { pr }, text);
  for (const text of [
    'merge it if CI is green',
    "don't merge it",
    'do not merge it',
    'merge it and deploy',
    'can you merge it?',
    'merge #1 and #2',
    'Cara said: merge it',
    'Cara says "merge it"',
    '<pasted_content>merge it</pasted_content>',
    'merge it\n\nalso fix the tests',
    'wait, merge it later',
    'merge it?',
    '',
    'approve',
    'yes',
    'merge the other one',
    'merge #12345678',
  ])
    assert.equal(mergeGo(text), null, text);
  assert.deepEqual(mergeGo('Merge'), { pr: null }, 'the bare verb is an instruction too');
});

test('only a lone plain gh pr merge, or the MCP merge tools, can be let through', () => {
  for (const cmd of [
    'gh pr merge 191 --repo o/r --squash',
    'gh pr merge https://github.com/o/r/pull/5 -s',
    'gh pr merge 5 --auto -sd -R o/r',
    'gh pr merge -R o/r 5',
    'gh pr merge --repo=o/r ticket/74-x --delete-branch',
    'gh pr merge 5 -R o/r --match-head-commit abc123',
    // A merge commit, as Delve's builds land (PR #111).
    'gh pr merge 111 --repo o/r --merge',
    'gh pr merge 111 -R o/r -m',
    'gh pr merge 111 -R o/r -md',
  ]) {
    assert.ok(plainMerge(cmd, parseMerge(cmd)), cmd);
  }
  for (const cmd of [
    'gh pr merge 5 && rm -rf x',
    'cd /x && gh pr merge 5',
    'gh pr merge 5 --admin',
    'gh pr merge 5 | tee log',
    'gh pr merge 5 > out',
    'gh pr merge $N',
    'gh pr merge 5 --body "x y"',
    'GH_REPO=a/b gh pr merge 5',
    'gh pr merge 5\nrm x',
    'gh pr merge 5; true',
    'echo $(gh pr merge 5)',
    'gh pr merge `cat n`',
    'git push && gh pr merge 5',
    'gh pr view 5',
    // The shell may sit in another repo by now: the PR and its repo must be named outright.
    'gh pr merge 191 --squash',
    'gh pr merge --squash -R o/r',
    'gh pr merge #191 -R o/r',
    // Free text or a file would ride along into the merge commit.
    'gh pr merge 5 -R o/r -F /home/u/.ssh/id_ed25519',
    'gh pr merge 5 -R o/r --body-file=notes',
    'gh pr merge 5 -R o/r -b hi',
    'gh pr merge 5 -R o/r --subject x',
    'gh pr merge 5 -R o/r --author-email a@b',
    'gh pr merge 5 -R o/r --squash=yes',
    'gh pr merge 5 -R',
    'gh pr merge 5 -R o/r -sF x',
    'gh pr merge 111 -R o/r --merge --body x',
    'gh pr merge 111 -R o/r --merge -F notes',
    'gh pr merge 111 -R o/r --merge --admin',
    'gh pr merge 111 --merge',
    'gh pr merge 111 -R o/r --merge --subject x',
    'gh pr merge 111 -R o/r -mF notes',
    // Rebase was never asked for.
    'gh pr merge 5 -R o/r --rebase',
    'gh pr merge 5 -R o/r -r',
    'gh pr merge 5 -R o/r -dr',
  ])
    assert.equal(plainMerge(cmd, parseMerge(cmd)), false, cmd);
  assert.equal(mcpMerge('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 5, pull_number: 6 }), null, 'two numbers');
  for (const method of ['merge', 'squash', 'MERGE']) assert.ok(mcpMerge('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 5, merge_method: method }), method);
  assert.ok(mcpMerge('mcp__github__enable_pr_auto_merge', { owner: 'o', repo: 'r', pullNumber: 5, mergeMethod: 'SQUASH' }));
  for (const extra of [{ commit_message: 'x' }, { commit_title: 'x' }, { commitMessage: 'x' }, { merge_method: 'squash', mergeMethod: 'rebase' }]) {
    assert.equal(mcpMerge('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 5, ...extra }), null, JSON.stringify(extra));
  }
  for (const method of ['rebase', 'REBASE', 5, '']) assert.equal(mcpMerge('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 5, merge_method: method }), null, String(method));
  assert.deepEqual(mcpMerge('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: 5 }), { target: '5', repo: 'o/r', method: null, auto: false, admin: false, moved: false });
  assert.equal(mcpMerge('mcp__github__enable_pr_auto_merge', { owner: 'o', repo: 'r', pull_number: 5 })?.auto, true);
  assert.equal(mcpMerge('mcp__github__get_pull_request', { owner: 'o', repo: 'r', pullNumber: 5 }), null);
  assert.equal(mcpMerge('mcp__github__merge_pull_request', { owner: 'o/x', repo: 'r', pullNumber: 5 }), null);
  assert.equal(mcpMerge('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pullNumber: '5' }), null);
});

const pr = (number: number, head: string, repo = 'cara/delve'): PrInfo => ({
  number,
  title: 'T',
  url: `https://github.com/${repo}/pull/${number}`,
  state: 'OPEN',
  draft: false,
  head,
  base: 'main',
  additions: 1,
  deletions: 0,
  files: 1,
  commits: 1,
  checks: 'passed',
});

test("a merge's target: only a PR in the scheme's repo, with its head branch", () => {
  assert.deepEqual(mergeTarget(pr(191, 'ticket/74-x'), 'Cara/Delve'), { number: 191, head: 'ticket/74-x', open: true });
  assert.equal(mergeTarget({ ...pr(191, 'ticket/74-x'), state: 'MERGED' }, 'cara/delve')?.open, false, 'merged');
  assert.equal(mergeTarget({ ...pr(191, 'ticket/74-x'), state: 'CLOSED' }, 'cara/delve')?.open, false, 'closed');
  assert.equal(mergeTarget(pr(191, 'ticket/74-x', 'someone/else'), 'cara/delve'), null, "another repo: a number she named means the scheme's own repo only");
  assert.equal(mergeTarget(null, 'cara/delve'), null, 'the lookup failed');
  assert.equal(mergeTarget(pr(191, 'ticket/74-x'), null), null, 'a scheme with no GitHub repo');
});

// ---------- the gate ----------

const CFG = { home: '/home/u', data: '/home/u/data', checkout: '/home/u/app', project: 1, claudeConfig: '/home/u/.claude', deployScript: true };
const MERGE = { command: 'gh pr merge --squash', description: 'Merge my PR' };
// Delve's minions: #50 a feeder owning PR 196, #42 a category minion with no PR, #5 the build minion.
const FEEDER = { id: 1, number: 50, branch: 'ticket/50-feeder' };
const CATEGORY = { id: 2, number: 42, branch: 'ticket/42-category' };
const BUILD = { id: 3, number: 5, branch: 'build/7' };
const TASKMASTER = { id: 4, number: null, branch: null };
const own = { number: 196, head: 'ticket/50-feeder', open: true };
const typed = (text: string, id = 1) => ({ author: 'Cara', text, id, typed: true });

function gate(store?: GoStore) {
  const results: any[] = [];
  const notes: { ticket: number; text: string }[] = [];
  const a = new Approvals((t, kind, data: any) => (kind === 'approval_result' ? results.push(data) : kind === 'note' && notes.push({ ticket: t, text: data.text })), store);
  const merge = (ticket = FEEDER.id, target: MergeTarget | null = own, rules = true, scheme = 1) => {
    const r = a.ask(ticket, 'Bash', MERGE, '/w', { ...CFG, project: scheme }, rules, undefined, target);
    return 'id' in r ? a.get(ticket, r.id).state : 'refused';
  };
  const say = (text: string, where: GoPlace = FEEDER, id = 1, scheme = 1) => a.said(scheme, where, typed(text, id));
  return { a, results, notes, merge, say };
}

test("a typed go lets its minion's own PR merge until it has merged, with the card kept as a record of whose message it was", () => {
  const { a, results, merge, say } = gate();
  say('Merge it', FEEDER, 41);
  assert.equal(merge(), 'allowed');
  assert.deepEqual(results[0].via, { message: 41, text: 'Merge it', scheme: 1, ticket: 50 });
  assert.equal(results[0].by, 'Cara');
  assert.equal(merge(), 'allowed', 'GitHub refused the first try (a short --match-head-commit): still open, so the retry passes');
  assert.equal(merge(FEEDER.id, { ...own, open: false }), 'pending', 'merged now: a second merge gets the card');
  assert.equal(merge(), 'pending', 'and the go has ended, even if the PR reads open again');
  assert.equal(a.hasGo(1), false);
  say('merge it');
  assert.equal(merge(FEEDER.id, { number: 196, head: 'ticket/50-feeder' }), 'pending', 'a PR whose state is unknown gets the card');
});

test('"fold it" means the PR its branch had when it first let a merge through, not a later PR from that branch', () => {
  const { merge, say } = gate();
  say('fold it');
  assert.equal(merge(), 'allowed');
  assert.equal(merge(BUILD.id, { number: 205, head: FEEDER.branch, open: true }), 'pending', 'a follow-up PR from the same branch, before anyone saw #196 merged');
  assert.equal(merge(), 'allowed', '#196 itself, still open, retried');
});

test('a queued go taken back before any turn read it is gone', () => {
  const { a, merge, say } = gate();
  say('fold 196', CATEGORY, 90);
  say('merge it', FEEDER, 91);
  a.unsaid(1, 90);
  assert.equal(merge(BUILD.id, own), 'allowed', "the feeder's own go still stands");
  a.unsaid(1, 91);
  assert.equal(merge(BUILD.id, own), 'pending');
});

test('Delve #42: a go typed in one minion lets another minion of the scheme merge that PR, at any head, until it merges (#260)', () => {
  const { results, merge, say } = gate();
  say('you can fold 196', CATEGORY, 77);
  assert.equal(merge(BUILD.id, own), 'allowed', 'the build minion folds it with no card');
  assert.deepEqual(results[0].via, { message: 77, text: 'you can fold 196', scheme: 1, ticket: 42 }, 'naming the chat and message the go came from');
  // The build branch moved: #5 re-merges the build tip into 196, pushes a new head, and merges again.
  assert.equal(merge(BUILD.id, { ...own, head: 'ticket/50-feeder' }), 'allowed', 'bound to the PR number, not the head');
  assert.equal(merge(BUILD.id, { number: 197, head: 'ticket/51-other', open: true }), 'pending', 'another PR');
  assert.equal(merge(BUILD.id, { ...own, open: false }), 'pending', 'merged');
  assert.equal(merge(BUILD.id, own), 'pending', 'the go ended with the merge');

  const g = gate();
  g.say('fold it', FEEDER, 78);
  assert.equal(g.merge(BUILD.id, own), 'allowed', '"fold it" in a feeder means the feeder\'s own PR, whoever merges it');
  assert.equal(g.results[0].via.ticket, 50);
  g.say('merge PR 196', TASKMASTER, 79);
  g.say('hold on', FEEDER);
  assert.equal(g.merge(BUILD.id, own), 'allowed', "the Taskmaster chat's go still stands; only the feeder's was taken back");
  assert.deepEqual(g.results[1].via, { message: 79, text: 'merge PR 196', scheme: 1, ticket: null });
});

test('the card stays whenever it is unclear which PR she meant', () => {
  const { merge, say } = gate();
  say('fold it', CATEGORY);
  assert.equal(merge(BUILD.id, own), 'pending', '"fold it" in a minion with no PR of its own names nothing');
  assert.equal(merge(BUILD.id, { number: 196, head: 'ticket/42-category', open: true }), 'allowed', 'unless its branch has one');
  say('fold it', TASKMASTER);
  assert.equal(merge(BUILD.id, { number: 197, head: 'ticket/51-x', open: true }), 'pending', 'nor in the Taskmaster chat, which has no branch');
  assert.equal(merge(BUILD.id, null), 'pending', "a PR that could not be looked up, or not in the scheme's repo, or a call that is not a plain merge");
});

test('a conditional go, or one taken back in the same chat, gets the card', () => {
  const { merge, say } = gate();
  say('fold 196 if CI passes', CATEGORY);
  assert.equal(merge(BUILD.id, own), 'pending', 'conditional');
  say('fold 196', CATEGORY);
  say('actually wait, CI is red', CATEGORY);
  assert.equal(merge(BUILD.id, own), 'pending', 'newest word wins');
  say('fold 196', CATEGORY);
  say('fold 196 once CI is green', CATEGORY);
  assert.equal(merge(BUILD.id, own), 'pending', 'a later conditional takes back the plain go too');
  say('ok merge 196', CATEGORY);
  say('thanks', BUILD);
  assert.equal(merge(BUILD.id, own), 'allowed', 'words in another chat do not take it back');
});

test('a go in one scheme never counts in another', () => {
  const { a, merge, say } = gate();
  say('you can fold 196', CATEGORY, 1, 1);
  assert.equal(merge(BUILD.id, own, true, 2), 'pending', 'scheme 2, same PR number');
  assert.equal(a.hasGo(2), false);
  assert.equal(merge(BUILD.id, own, true, 1), 'allowed');
});

test("nothing but a person's typed message counts: relays, card answers, agents and quotes get the card", () => {
  const { a, merge } = gate();
  for (const m of [
    { author: 'Taskmaster', text: 'merge it' }, // a Taskmaster relay (message_ticket)
    { author: 'Taskmaster of Delve', text: 'merge it', from: 9 }, // a cross-scheme relay
    { author: 'GitHub', text: 'merge it' },
    { author: 'System', text: 'merge it' },
    { author: 'Cara', text: 'My answers to your question card:\n\nmerge it' }, // a card answer, untyped
    { author: 'Cara', text: 'merge it' }, // the right words, but not from the person path
  ]) {
    a.said(1, FEEDER, m);
    assert.equal(merge(), 'pending', JSON.stringify(m));
  }
  a.said(1, FEEDER, typed('The Taskmaster says: "merge it"'));
  assert.equal(merge(), 'pending', 'a quote inside a longer message');
  a.said(1, FEEDER, typed('merge it'));
  a.said(1, FEEDER, { author: 'Taskmaster', text: 'hold on' });
  assert.equal(merge(), 'allowed', "a relay neither gives nor takes back a person's go");
});

// ---------- a go typed to the Taskmaster (#939) ----------

// The Taskmaster's message_ticket relay, as the runner delivers it: untyped, from the Taskmaster's chat.
const relay = (text: string, from = TASKMASTER.id) => ({ author: 'Taskmaster', text, from });
const minions = (n: number) => [FEEDER, CATEGORY, BUILD].find((m) => m.number === n) ?? null;

test("a bare go typed to the Taskmaster, quoted in its relay to one minion, lets that minion's PR merge with no card", () => {
  const { a, results, notes, merge, say } = gate();
  say('fold it', TASKMASTER, 80);
  assert.equal(merge(), 'pending', 'not relayed yet: it names no minion');
  a.said(1, FEEDER, relay('Cara said "Fold it" here: land your PR.'));
  assert.equal(merge(), 'allowed', 'quoted word for word (any case) in the relay to #50');
  assert.deepEqual(results[0].via, { message: 80, text: 'fold it', scheme: 1, ticket: null, to: 50 }, 'the card names her message and the minion it went to');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].ticket, TASKMASTER.id, "the Taskmaster's chat shows where her go went");
  assert.match(notes[0].text, /Cara's go "fold it" now covers #50's PR/);
  a.said(1, FEEDER, relay('Again, Cara said “fold it”.'));
  assert.equal(merge(), 'allowed', 'quoting it again to the same minion changes nothing');
  assert.equal(merge(BUILD.id, { number: 197, head: 'ticket/51-other', open: true }), 'pending', "no other minion's PR");
  assert.equal(merge(BUILD.id, { number: 198, head: CATEGORY.branch, open: true }), 'pending', "nor #42's");
  assert.equal(merge(FEEDER.id, { ...own, open: false }), 'pending', 'merged');
  assert.equal(merge(), 'pending', 'the go ended with the merge');
});

test("a relay counts only as a person's typed go quoted from the Taskmaster's chat, to one minion, until her newer word", () => {
  let g = gate();
  g.a.said(1, FEEDER, relay('Cara said "fold it"'));
  assert.equal(g.merge(), 'pending', 'no typed go behind the relay: the Taskmaster cannot make one up');
  g.say('fold it', TASKMASTER);
  g.a.said(1, FEEDER, relay('Cara says you can fold it now.'));
  assert.equal(g.merge(), 'pending', 'paraphrased, not quoted');
  g.a.said(1, FEEDER, relay('Cara said "merge it"'));
  assert.equal(g.merge(), 'pending', 'quoting words she did not type');
  g.a.said(1, FEEDER, relay('Cara said "fold it"', CATEGORY.id));
  assert.equal(g.merge(), 'pending', "another minion's message_minion quoting it");
  g.a.said(2, FEEDER, relay('Cara said "fold it"'));
  assert.equal(g.merge(FEEDER.id, own, true, 2), 'pending', 'a relay in another scheme');
  g.a.said(1, FEEDER, { ...relay('Cara said "fold it"'), typed: true });
  assert.equal(g.merge(), 'pending', 'a typed message quoting it is not a go either');

  g = gate();
  g.say('merge it', TASKMASTER);
  g.a.said(1, FEEDER, relay('Cara: "merge it"'));
  g.a.said(1, CATEGORY, relay('Cara: "merge it"'));
  assert.equal(g.merge(), 'pending', 'quoted to two minions: it covers neither');
  assert.equal(g.merge(BUILD.id, { number: 198, head: CATEGORY.branch, open: true }), 'pending');
  assert.match(g.notes.at(-1)!.text, /also quoted to #42.*covers neither/);
  g.a.said(1, FEEDER, relay('Cara: "merge it"'));
  assert.equal(g.merge(), 'pending', 'and stays gone');

  g = gate();
  g.say('fold it', TASKMASTER, 1);
  g.a.said(1, FEEDER, relay('Cara: "fold it"'));
  g.say('fold it', TASKMASTER, 2);
  g.a.said(1, CATEGORY, relay('Cara: "fold it"'));
  assert.equal(g.merge(), 'allowed', 'the same words typed again and quoted to another minion leave the first go where it went');
  assert.equal(g.merge(BUILD.id, { number: 198, head: CATEGORY.branch, open: true }), 'allowed', 'and the second covers #42');
  assert.equal(g.notes.filter((n) => /covers neither/.test(n.text)).length, 0);

  g = gate();
  g.say('fold it', TASKMASTER);
  g.say('hm, wait', TASKMASTER);
  g.a.said(1, FEEDER, relay('Cara said "fold it"'));
  assert.equal(g.merge(), 'pending', 'taken back in the Taskmaster chat before the relay');
  g.say('fold it', TASKMASTER);
  g.a.said(1, FEEDER, relay('Cara said "fold it"'));
  g.say('actually CI is red', TASKMASTER);
  assert.equal(g.merge(), 'pending', 'taken back after it: newest word wins');
  g.say('fold it', TASKMASTER);
  g.a.said(1, FEEDER, relay('Cara said "fold it"'));
  g.say('also fix the typo first', FEEDER);
  assert.equal(g.merge(), 'pending', "a newer typed word in the minion's own chat takes it back too");
  g.say('fold it', TASKMASTER);
  g.a.said(1, FEEDER, relay('Cara said "fold it"'));
  g.say('thanks', CATEGORY);
  assert.equal(g.merge(), 'allowed', 'words in a third chat do not');
});

test('in the Taskmaster chat "#N" names minion N; "PR N" names a PR; a bare number names nothing', () => {
  const { a, results, merge } = gate();
  const toTaskmaster = (text: string, id = 1) => a.said(1, TASKMASTER, typed(text, id), minions);
  toTaskmaster('ship #50', 81);
  assert.equal(merge(), 'allowed', "#50's own PR, with no relay");
  assert.deepEqual(results[0].via, { message: 81, text: 'ship #50', scheme: 1, ticket: null, to: 50 });
  a.said(1, CATEGORY, relay('Cara said "land #50"'));
  assert.equal(merge(BUILD.id, { number: 199, head: CATEGORY.branch, open: true }), 'pending', 'a relay never moves a go that names its minion');
  assert.equal(merge(), 'allowed');

  const g = gate();
  const tm = (text: string) => g.a.said(1, TASKMASTER, typed(text), minions);
  tm('ok, fold #42');
  assert.equal(g.merge(BUILD.id, { number: 199, head: CATEGORY.branch, open: true }), 'allowed', "#42's PR");
  assert.equal(g.merge(), 'pending', 'not #50s');
  tm('fold 50');
  assert.equal(g.merge(), 'pending', 'a bare number: minion or PR is a guess, so the card');
  assert.match(g.notes.at(-1)!.text, /"fold 50" names no minion with a branch, so it covers nothing/, 'and the Taskmaster chat says why');
  assert.equal(g.merge(BUILD.id, { number: 50, head: 'ticket/9-x', open: true }), 'pending', 'and not PR 50 either');
  tm('merge #77');
  assert.equal(g.merge(BUILD.id, { number: 77, head: 'ticket/77-x', open: true }), 'pending', 'no minion #77: nothing');
  tm('merge PR #196');
  assert.equal(g.merge(), 'allowed', '"PR #196" is the PR');
  g.say('fold #196', CATEGORY);
  g.say('hold on', TASKMASTER);
  assert.equal(g.merge(BUILD.id, own), 'allowed', 'in a minion\'s own chat "#196" is still the PR');
});

test('a go outlives its turn and a restart, and never passes a tripwire card or a scheme without cards', () => {
  const kept = new Map<number, Go[]>();
  const store: GoStore = { get: (s) => structuredClone(kept.get(s) ?? []), set: (s, g) => kept.set(s, structuredClone(g)) };
  const { a, merge, say } = gate(store);
  say('merge it');
  a.endTurn(FEEDER.id, 'The turn ended while this waited.');
  assert.equal(gate(store).merge(), 'allowed', 'a new Approvals over the same store: a restart keeps it');
  assert.equal(merge(FEEDER.id, own, false), 'refused', 'no approval rules: no card to skip');
  const tw = a.ask(1, 'Bash', { command: 'rm /home/u/data/coordinator.db.bak-1', description: 'Delete the DB copy Cara approved' }, '/w', CFG, true, undefined, own);
  assert.ok('id' in tw && a.get(1, tw.id).state === 'pending', 'a tripwire card waits for an admin');
  assert.ok(a.hasGo(1), 'and leaves the go for the merge');
});

test('a merge the go covers, run chained or without --repo, is sent back once with the plain command to run instead (#209)', () => {
  const { a, merge, say } = gate();
  // Delve #80's real call after Cara's typed "Merge it": the PR is right, the shape isn't.
  const chained = { command: 'gh pr merge 196 --squash --match-head-commit 7ff3d3e693550d12e4dabcdacc5db281fe382b7b 2>&1 | tail -3; gh pr view 196 --json state', description: 'Squash-merge PR #196' };
  const retry = (target: MergeTarget) => ({ target, command: `gh pr merge ${target.number} --repo cara/delve --squash` });
  const ask = (target: MergeTarget, ticket = FEEDER.id) => a.ask(ticket, 'Bash', chained, '/w', CFG, true, undefined, null, retry(target));
  say('Merge it');
  const first = ask(own);
  assert.ok('refused' in first && first.refused.includes('`gh pr merge 196 --repo cara/delve --squash`'), JSON.stringify(first));
  assert.ok(a.hasGo(1), 'the go still stands for the plain run');
  const again = ask(own, BUILD.id);
  assert.ok('id' in again && a.get(BUILD.id, again.id).state === 'pending', 'asked twice, by any minion: the card, so a minion that needs its extra flags is never stuck');
  assert.equal(merge(), 'allowed', 'the plain run still counts');
  const other = ask({ number: 188, head: 'ticket/other', open: true });
  assert.ok('id' in other, 'a PR the go does not cover gets the card, not a hint');
});

// ---------- the runner records what people type ----------

const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync } = require('node:fs');
process.stdin.resume();
const t = setInterval(() => {
  if (!existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(t);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

test('a typed go is recorded for the scheme when sent, steered or not; a relay never; the turn end and a restart keep it', async () => {
  const store = new Store(join(root, 'test.db'));
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  const project = store.createProject('Delve', null);
  store.setProjectSettings(project.id, { approval_rules: 'Bash(gh pr merge:*)' });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  mkdirSync(join(root, 'wt'));
  store.setTicketDir(t.id, join(root, 'wt'), 'ticket/1-t');
  const finish = async () => {
    writeFileSync(join(root, 'release'), '');
    while (runner.isRunning(t.id)) await wait(20);
    rmSync(join(root, 'release'), { force: true });
  };

  runner.relay(t.id, t.id, 'Taskmaster', 'merge it');
  await until('the turn', () => runner.isRunning(t.id));
  assert.equal(runner.approvals.hasGo(project.id), false, 'a relayed "merge it"');
  // A person steering in: typed, so it counts; their next typed words take it back.
  await until('steering', () => existsSync(join(root, 'run')));
  await wait(100);
  runner.send(t.id, 'Cara', 'merge it', [], { typed: true }, true);
  assert.equal(runner.approvals.hasGo(project.id), true);
  runner.send(t.id, 'Cara', 'hm, not yet', [], { typed: true }, true);
  assert.equal(runner.approvals.hasGo(project.id), false);
  runner.send(t.id, 'Cara', 'fold it', [], { typed: true }, true);
  // "Send after this turn", then taken back before any turn read it: its go goes with it.
  runner.send(t.id, 'Cara', 'merge 300', [], { typed: true });
  const queued = store.listEvents(t.id).findLast((e) => e.kind === 'user_message' && JSON.parse(e.data).text === 'merge 300')!;
  assert.equal(store.getSetting<Go[]>(`merge_goes:${project.id}`)!.length, 2);
  assert.equal(runner.unqueue(t.id, queued.id, 'Cara'), true);
  await finish();
  assert.equal(runner.approvals.hasGo(project.id), true, 'the turn ended, the go stands');
  assert.equal(
    new Runner(
      store,
      () => {},
      () => ({}),
      fake,
    ).approvals.hasGo(project.id),
    true,
    'kept in settings: a restart keeps it',
  );
  assert.deepEqual(
    store.getSetting<Go[]>(`merge_goes:${project.id}`)!.map((g) => [g.text, g.ticket, g.number, g.branch]),
    [['fold it', t.id, t.number, 'ticket/1-t']],
  );
  (store as Store & { close?: () => void }).close?.();
});

test('the runner hands a go typed to the Taskmaster to the minion its relay quotes it to, or that it names (#939)', async () => {
  const store = new Store(join(root, 'relay.db'));
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  const project = store.createProject('Delve', null);
  const coordinator = store.getCoordinator(project.id) ?? store.createTicket({ project_id: project.id, title: 'Taskmaster', permission_mode: 'bypassPermissions', created_by: 'Cara', kind: 'coordinator' });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  store.setTicketDir(t.id, join(root, 'wt-relay'), `ticket/${t.number}-t`);
  const goes = () => store.getSetting<Go[]>(`merge_goes:${project.id}`) ?? [];
  const tm = { id: coordinator.id, number: coordinator.number, branch: null };
  runner.approvals.said(project.id, tm, { author: 'Cara', text: 'fold it', id: 1, typed: true });
  runner.relay(t.id, t.id, 'Taskmaster', 'Cara said "fold it"', false, false);
  assert.deepEqual(
    goes().map((g) => [g.text, g.to, g.branch]),
    [['fold it', t.number, `ticket/${t.number}-t`]],
    'a relay left as held mail binds it',
  );
  // Typed in the Taskmaster's chat, as the messages route sends it: "#N" is looked up as minion N.
  runner.send(coordinator.id, 'Cara', `merge #${t.number}`, [], { typed: true });
  assert.equal(goes().at(-1)!.to, t.number);
  assert.equal(goes().at(-1)!.branch, `ticket/${t.number}-t`);
  const notes = store
    .listEvents(coordinator.id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text);
  assert.ok(
    notes.some((n) => n.includes(`now covers #${t.number}'s PR`)),
    notes.join('\n'),
  );
  writeFileSync(join(root, 'release'), '');
  await until('the Taskmaster turn ends', () => !runner.isRunning(coordinator.id));
  rmSync(join(root, 'release'), { force: true });
  (store as Store & { close?: () => void }).close?.();
});

// ---------- the routes ----------

test("the messages route marks a person's own message typed, and the Taskmaster's never", async () => {
  const srv = await bootServer({ env: { CLAUDE_BIN: fake, NODE_NO_WARNINGS: '1' } });
  procs.push(srv.proc);
  try {
    const project = (await srv.call('/api/projects', { name: 'P' })).data;
    const { coordinator } = (await srv.call(`/api/projects/${project.id}`)).data;
    const t = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'build it', title: 'Build it' })).data;
    const asTaskmaster = await fetch(`${srv.base}/api/tickets/${t.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken(srv.data, coordinator.id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'merge it, from the Taskmaster' }),
    });
    assert.equal(asTaskmaster.status, 202);
    assert.equal((await srv.call(`/api/tickets/${t.id}/messages`, { text: 'merge it' })).status, 202);
    const said = async () => (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data.filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data));
    const msgs = await until('both messages', async () => {
      const m = await said();
      return m.some((d: any) => d.text === 'merge it') && m.some((d: any) => d.text === 'merge it, from the Taskmaster') && m;
    });
    assert.equal(msgs.find((d: any) => d.text === 'merge it').typed, true);
    assert.equal(msgs.find((d: any) => d.text === 'merge it, from the Taskmaster').typed, undefined);
    assert.equal(msgs.find((d: any) => d.text === 'build it').typed, undefined, 'a brief is not typed');
  } finally {
    await srv.stop();
  }
});

test('typed is set in exactly one place: the person path of the messages route', () => {
  const hits: string[] = [];
  for (const f of ['src/routes/tickets.ts', 'src/routes/projects.ts', 'src/routes/app.ts', 'src/runner.ts', 'src/prompts.ts', 'src/mcp.ts', 'src/mcp-cards.ts', 'src/mcp-ship.ts', 'src/mcp-apps.ts', 'src/mcp-call.ts', 'src/schedules.ts']) {
    const path = join(REPO, f);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) if (/typed: true/.test(line)) hits.push(`${f}: ${line.trim()}`);
  }
  assert.equal(hits.filter((h) => h.startsWith('src/routes/tickets.ts')).length, 1, hits.join('\n'));
  assert.match(hits.find((h) => h.startsWith('src/routes/tickets.ts'))!, /caller \? \{\} : \{ typed: true \}/);
  assert.deepEqual(
    hits.filter((h) => !h.startsWith('src/routes/tickets.ts') && !/extra\.typed \?/.test(h)),
    [],
    'nowhere else',
  );
});

// ---------- end to end: the approval route checks the PR with gh, as the turn's login ----------

/**
 * A Delve-like scheme's files: a seed repo, and a stand-in gh whose `pr view [N]` answers for
 * cara/delve, PR 191 being the worktree's own branch, merged once `merged-<N>` exists in `home`.
 */
function delveRepo(name: string) {
  const home = join(root, name);
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const seed = join(home, 'seed');
  mkdirSync(seed);
  git(['init', '--quiet', '-b', 'main'], seed);
  writeFileSync(join(seed, 'README.md'), 'x\n');
  git(['add', '.'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed'], seed);
  writeFileSync(
    join(bin, 'gh'),
    `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] !== 'pr' || a[1] !== 'view') process.exit(1);
const head = require('node:child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const n = /^\\d+$/.test(a[2] ?? '') ? Number(a[2]) : 191;
const repo = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : 'cara/delve';
const state = require('node:fs').existsSync(${JSON.stringify(join(home, 'merged-'))} + n) ? 'MERGED' : 'OPEN';
console.log(JSON.stringify({ number: n, title: 'PR ' + n, url: 'https://github.com/' + repo + '/pull/' + n, state, isDraft: false, headRefName: n === 191 ? head : 'ticket/other', baseRefName: 'main' }));
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`, CLAUDE_BIN: fake, NODE_NO_WARNINGS: '1', GH_TOKEN: undefined, GITHUB_TOKEN: undefined };
  return { home, seed, env, git };
}

type Srv = Awaited<ReturnType<typeof bootServer>>;
/**
 * Wait until a minion's turn runs, then answer with its token. Not before: creating a minion returns while its turn's
 * start may still be async, and a token minted before the turn's own (its nonce) stops working once that exists (#1794).
 */
async function turnAuth(srv: Srv, id: number) {
  const auth = () => ({ Authorization: `Bearer ${agentToken(srv.data, id)}`, 'Content-Type': 'application/json' });
  await until('the turn', async () => turnSaved(srv.data, id) && (await srv.call(`/api/tickets/${id}`)).data.ticket?.status === 'running' && (await fetch(`${srv.base}/api/tickets/${id}/approvals?id=x`, { headers: auth() })).ok);
  return auth();
}

test('through the routes: a typed go lets one plain merge of the right PR through; relays and wider calls get the card', async () => {
  const { home, seed, env, git } = delveRepo('e2e');
  const srv = await bootServer({ root: home, env });
  procs.push(srv.proc);
  try {
    const project = (await srv.call('/api/projects', { name: 'Delve', source: 'folder', folder: seed })).data;
    assert.ok(project.repo_dir, JSON.stringify(project));
    assert.equal((await srv.call(`/api/projects/${project.id}`, { approval_rules: 'Bash(gh pr merge:*)' }, 'PATCH')).status, 200);
    const { coordinator } = (await srv.call(`/api/projects/${project.id}`)).data;
    const created = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'build it' })).data;
    const t = created.ticket ?? created;
    git(['remote', 'set-url', 'origin', 'https://github.com/cara/delve.git'], project.repo_dir);
    const minion = () => ({ Authorization: `Bearer ${agentToken(srv.data, t.id)}`, 'Content-Type': 'application/json' });
    await turnAuth(srv, t.id);
    const ask = async (command: string) => (await fetch(`${srv.base}/api/tickets/${t.id}/approvals`, { method: 'POST', headers: minion(), body: JSON.stringify({ tool_name: 'Bash', input: { command, description: 'Merge the PR' } }) })).json();
    const merge = async (command: string) => {
      const r = await ask(command);
      assert.ok(r.id, JSON.stringify(r));
      // A go settles the card before the POST answers; a long-poll on a waiting one would hold for 25 s.
      const settled = (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data.find((e: any) => e.kind === 'approval_result' && JSON.parse(e.data).id === r.id);
      return settled ? JSON.parse(settled.data).state : 'pending';
    };
    const say = async (text: string) => assert.equal((await srv.call(`/api/tickets/${t.id}/messages`, { text })).status, 202);
    const steered = async (text: string) => until(`"${text}" steered`, async () => (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data.some((e: any) => e.kind === 'user_message' && JSON.parse(e.data).text === text));

    // The Taskmaster relaying her words is not a go.
    await fetch(`${srv.base}/api/tickets/${t.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(srv.data, coordinator.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'merge it' }) });
    assert.equal(await merge('gh pr merge 191 -R cara/delve --squash'), 'pending', 'a relay');

    await say('merge it');
    await steered('merge it');
    // Delve #80's real call (#209): its PR, but chained and with no --repo: sent back once with the plain command.
    const hint = await ask('gh pr merge 191 --squash --match-head-commit 7ff3d3e693550d12e4dabcdacc5db281fe382b7b 2>&1 | tail -3; gh pr view 191 --json state');
    assert.match(hint.refused ?? '', /Run exactly `gh pr merge 191 --repo cara\/delve --squash`/, JSON.stringify(hint));
    assert.equal(await merge('cd .. && gh pr merge 191 -R cara/delve --squash'), 'pending', 'not a lone plain merge, and already sent back once');
    assert.equal(await merge('gh pr merge 191 --squash'), 'pending', 'no repo named: the shell may be in another one');
    assert.equal(await merge('gh pr merge 188 -R cara/delve --squash'), 'pending', "no number named: not another branch's PR");
    assert.equal(await merge('gh pr merge -R someone/else 191'), 'pending', 'another repo');
    assert.equal(await merge('gh pr merge 191 -R cara/delve -F README.md'), 'pending', 'a file in the merge commit');
    assert.equal(await merge('gh pr merge 191 -R cara/delve --squash --match-head-commit 2efe2fb2'), 'allowed', 'its own PR');
    assert.equal(await merge('gh pr merge 191 -R cara/delve --squash --match-head-commit 2efe2fb20f139cc9e77834436066a504c2793977'), 'allowed', 'GitHub refused the short SHA, so the retry passes');
    writeFileSync(join(home, 'merged-191'), '');
    assert.equal(await merge('gh pr merge 191 -R cara/delve --squash'), 'pending', 'once it has merged');
    rmSync(join(home, 'merged-191'));

    await say('merge PR #188');
    await steered('merge PR #188');
    assert.equal(await merge('gh pr merge 191 -R cara/delve --squash'), 'pending', 'she named #188, not its own');
    assert.equal(await merge('gh pr merge https://github.com/cara/delve/pull/188 --squash'), 'allowed');

    // A merge commit, as Delve's builds land; with a body it rides along, so it gets the card.
    await say('fold it');
    await steered('fold it');
    // A cd hides the PR from the card's lookup; the worktree's answer still finds the go's own PR.
    assert.match((await ask('cd .. && gh pr merge --merge 2>&1')).refused ?? '', /`gh pr merge 191 --repo cara\/delve --merge`/);
    assert.equal(await merge('gh pr merge 191 -R cara/delve --merge --body done'), 'pending', 'a body');
    assert.equal(await merge('gh pr merge 191 -R cara/delve --merge'), 'allowed');
    const results = (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data.filter((e: any) => e.kind === 'approval_result').map((e: any) => JSON.parse(e.data));
    assert.deepEqual(
      results.map((r: any) => [r.by, r.via?.text]),
      [
        ['Cara', 'merge it'],
        ['Cara', 'merge it'],
        ['Cara', 'merge PR #188'],
        ['Cara', 'fold it'],
      ],
    );
  } finally {
    await srv.stop();
  }
});

test("through the routes: Delve #42's go in one minion lets the build minion merge that PR with no card, naming where it came from (#260)", async () => {
  const { home, seed, env, git } = delveRepo('across');
  const srv = await bootServer({ root: home, env });
  procs.push(srv.proc);
  try {
    const project = (await srv.call('/api/projects', { name: 'Delve', source: 'folder', folder: seed })).data;
    assert.equal((await srv.call(`/api/projects/${project.id}`, { approval_rules: 'Bash(gh pr merge:*)' }, 'PATCH')).status, 200);
    const minion = async (message: string) => {
      const created = (await srv.call(`/api/projects/${project.id}/tickets`, { message })).data;
      return created.ticket ?? created;
    };
    const category = await minion('the enchanting category');
    const build = await minion('build 7');
    git(['remote', 'set-url', 'origin', 'https://github.com/cara/delve.git'], project.repo_dir);
    const auth = await turnAuth(srv, build.id);
    const merge = async (command: string) => {
      const r = await (await fetch(`${srv.base}/api/tickets/${build.id}/approvals`, { method: 'POST', headers: auth, body: JSON.stringify({ tool_name: 'Bash', input: { command, description: 'Fold the PR' } }) })).json();
      assert.ok(r.id, JSON.stringify(r));
      const settled = (await srv.call(`/api/tickets/${build.id}/events?after=0`)).data.find((e: any) => e.kind === 'approval_result' && JSON.parse(e.data).id === r.id);
      return settled && JSON.parse(settled.data);
    };
    assert.equal(await merge('gh pr merge 188 --repo cara/delve --merge'), undefined, 'no go yet: the card');
    assert.equal((await srv.call(`/api/tickets/${category.id}/messages`, { text: 'you can fold 188' })).status, 202);
    const said = await until('the go', async () => (await srv.call(`/api/tickets/${category.id}/events?after=0`)).data.find((e: any) => e.kind === 'user_message' && JSON.parse(e.data).text === 'you can fold 188'));
    const r = await merge('gh pr merge 188 --repo cara/delve --merge --match-head-commit 2efe2fb20f139cc9e77834436066a504c2793977');
    assert.deepEqual([r?.state, r?.by, r?.via], ['allowed', 'Cara', { message: said.id, text: 'you can fold 188', scheme: project.id, ticket: category.number }]);
    assert.equal((await merge('gh pr merge 188 --repo cara/delve --merge --match-head-commit 7ff3d3e693550d12e4dabcdacc5db281fe382b7b'))?.state, 'allowed', 'a new head after the go');
    assert.equal(await merge('gh pr merge 189 --repo cara/delve --merge'), undefined, 'another PR');
    writeFileSync(join(home, 'merged-188'), '');
    assert.equal(await merge('gh pr merge 188 --repo cara/delve --merge'), undefined, 'merged: the go has ended');
  } finally {
    await srv.stop();
  }
});

// ---------- replays of real Delve merges: each one once showed Cara a card she shouldn't have had to click ----------

test('Delve replays: a typed fold survives restarts mid-turn, a refused merge and its retry; chained calls get the plain command (#209)', async () => {
  const { home, seed, env, git } = delveRepo('replay');
  let srv = await bootServer({ root: home, env });
  procs.push(srv.proc);
  try {
    const project = (await srv.call('/api/projects', { name: 'Delve', source: 'folder', folder: seed })).data;
    assert.equal((await srv.call(`/api/projects/${project.id}`, { approval_rules: 'Bash(gh pr merge:*)' }, 'PATCH')).status, 200);
    const created = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'build the enchanting table' })).data;
    const t = created.ticket ?? created;
    git(['remote', 'set-url', 'origin', 'https://github.com/cara/delve.git'], project.repo_dir);
    const minion = () => ({ Authorization: `Bearer ${agentToken(srv.data, t.id)}`, 'Content-Type': 'application/json' });
    const attached = () => turnAuth(srv, t.id);
    const ask = async (command: string) => (await fetch(`${srv.base}/api/tickets/${t.id}/approvals`, { method: 'POST', headers: minion(), body: JSON.stringify({ tool_name: 'Bash', input: { command, description: 'Fold the PR' } }) })).json();
    const merge = async (command: string) => {
      const r = await ask(command);
      assert.ok(r.id, JSON.stringify(r));
      const settled = (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data.find((e: any) => e.kind === 'approval_result' && JSON.parse(e.data).id === r.id);
      return settled ? JSON.parse(settled.data).state : 'pending';
    };
    const restart = async () => {
      await srv.stop({ keepTurns: true });
      srv = await bootServer({ root: home, env });
      procs.push(srv.proc);
      await attached();
    };
    await attached();

    // #63 (10-31): "Fold it", then two other minions' deploys restarted the server before the merge.
    assert.equal((await srv.call(`/api/tickets/${t.id}/messages`, { text: 'Fold it' })).status, 202);
    await until('"Fold it" steered', async () => (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data.some((e: any) => e.kind === 'user_message' && JSON.parse(e.data).text === 'Fold it'));
    await restart();
    await restart();
    // #63 and #72: a --match-head-commit GitHub refused (made up, or too short), then the retry.
    assert.equal(await merge('gh pr merge 191 --repo cara/delve --merge --match-head-commit f6670d1f5c1f9fa3a7b8c1a5e2d0f0b4c3a2e1d0'), 'allowed', 'the go outlived both restarts');
    await restart();
    assert.equal(await merge('gh pr merge 191 --repo cara/delve --merge'), 'allowed', 'nothing merged, so the retry needs no card, after another restart too');
    // #80: the merge chained to its own check and without --repo: sent back with the plain command.
    assert.match((await ask('gh pr merge 191 --merge --match-head-commit 7ff3d3e 2>&1 | tail -3; gh pr view 191 --json state')).refused ?? '', /`gh pr merge 191 --repo cara\/delve --merge`/);
    writeFileSync(join(home, 'merged-191'), '');
    assert.equal(await merge('gh pr merge 191 --repo cara/delve --merge'), 'pending', 'merged: a second merge gets the card');
  } finally {
    await srv.stop();
  }
});
