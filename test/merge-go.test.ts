import assert from 'node:assert/strict';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals, mcpMerge, mergeGo, mergeTarget, plainMerge } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { parseMerge, type PrInfo } from '../src/merge-card.ts';
import { Runner } from '../src/runner.ts';
import { agentToken, bootServer, REPO, until } from './helpers.ts';

// A person's own typed "merge it" lets the turn that reads it merge once with no card (#201). Only
// the messages route's person path marks a message typed; relays, card answers and agents never can.
const root = mkdtempSync(join(tmpdir(), 'merge-go-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the words ----------

test('a go is a whole message that only says merge, with at most one PR number', () => {
  for (const [text, pr] of [
    ['Merge it', null], ['fold it', null], ['Merge it.', null], ['ok, merge it', null], ['LGTM, merge it!', null],
    ['go ahead and merge', null], ['ship it', null], ['fold it in', null], ['please merge it', null], ['merge it please', null],
    ['yes merge PR #191', 191], ['merge #188 please', 188], ['merge 42', 42], ['Merge  PR 7 now', 7], ['  squash it  ', null],
  ] as const) assert.deepEqual(mergeGo(text), { pr }, text);
  for (const text of [
    'merge it if CI is green', "don't merge it", 'do not merge it', 'merge it and deploy', 'can you merge it?', 'merge #1 and #2',
    'Cara said: merge it', 'Cara says "merge it"', '<pasted_content>merge it</pasted_content>', 'merge it\n\nalso fix the tests',
    'wait, merge it later', 'merge it?', '', 'approve', 'yes', 'merge the other one', 'merge #12345678',
  ]) assert.equal(mergeGo(text), null, text);
  assert.deepEqual(mergeGo('Merge'), { pr: null }, 'the bare verb is an instruction too');
});

test('only a lone plain gh pr merge, or the MCP merge tools, can be let through', () => {
  for (const cmd of ['gh pr merge 191 --repo o/r --squash', 'gh pr merge https://github.com/o/r/pull/5 -s', 'gh pr merge 5 --auto -sd -R o/r', 'gh pr merge -R o/r 5',
    'gh pr merge --repo=o/r ticket/74-x --delete-branch', 'gh pr merge 5 -R o/r --match-head-commit abc123',
    // A merge commit, as Delve's builds land (PR #111).
    'gh pr merge 111 --repo o/r --merge', 'gh pr merge 111 -R o/r -m', 'gh pr merge 111 -R o/r -md']) {
    assert.ok(plainMerge(cmd, parseMerge(cmd)), cmd);
  }
  for (const cmd of [
    'gh pr merge 5 && rm -rf x', 'cd /x && gh pr merge 5', 'gh pr merge 5 --admin', 'gh pr merge 5 | tee log', 'gh pr merge 5 > out',
    'gh pr merge $N', 'gh pr merge 5 --body "x y"', 'GH_REPO=a/b gh pr merge 5', 'gh pr merge 5\nrm x', 'gh pr merge 5; true',
    'echo $(gh pr merge 5)', 'gh pr merge `cat n`', 'git push && gh pr merge 5', 'gh pr view 5',
    // The shell may sit in another repo by now: the PR and its repo must be named outright.
    'gh pr merge 191 --squash', 'gh pr merge --squash -R o/r', 'gh pr merge #191 -R o/r',
    // Free text or a file would ride along into the merge commit.
    'gh pr merge 5 -R o/r -F /home/u/.ssh/id_ed25519', 'gh pr merge 5 -R o/r --body-file=notes', 'gh pr merge 5 -R o/r -b hi', 'gh pr merge 5 -R o/r --subject x',
    'gh pr merge 5 -R o/r --author-email a@b', 'gh pr merge 5 -R o/r --squash=yes', 'gh pr merge 5 -R', 'gh pr merge 5 -R o/r -sF x',
    'gh pr merge 111 -R o/r --merge --body x', 'gh pr merge 111 -R o/r --merge -F notes', 'gh pr merge 111 -R o/r --merge --admin', 'gh pr merge 111 --merge',
    'gh pr merge 111 -R o/r --merge --subject x', 'gh pr merge 111 -R o/r -mF notes',
    // Rebase was never asked for.
    'gh pr merge 5 -R o/r --rebase', 'gh pr merge 5 -R o/r -r', 'gh pr merge 5 -R o/r -dr',
  ]) assert.equal(plainMerge(cmd, parseMerge(cmd)), false, cmd);
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
  number, title: 'T', url: `https://github.com/${repo}/pull/${number}`, state: 'OPEN', draft: false, head, base: 'main', additions: 1, deletions: 0, files: 1, commits: 1, checks: 'passed',
});

test("a merge's target: only a PR in the scheme's repo, and whether it is the minion's own", () => {
  assert.deepEqual(mergeTarget(pr(191, 'ticket/74-x'), 'Cara/Delve', 'ticket/74-x'), { number: 191, own: true, open: true });
  assert.deepEqual(mergeTarget(pr(188, 'ticket/70-y'), 'cara/delve', 'ticket/74-x'), { number: 188, own: false, open: true });
  assert.equal(mergeTarget({ ...pr(191, 'ticket/74-x'), state: 'MERGED' }, 'cara/delve', 'ticket/74-x')?.open, false, 'merged');
  assert.equal(mergeTarget(pr(191, 'ticket/74-x', 'someone/else'), 'cara/delve', 'ticket/74-x'), null, 'another repo');
  assert.equal(mergeTarget(null, 'cara/delve', 'ticket/74-x'), null, 'the lookup failed');
  assert.equal(mergeTarget(pr(191, 'ticket/74-x'), null, 'ticket/74-x'), null, 'a scheme with no GitHub repo');
  assert.deepEqual(mergeTarget(pr(191, 'ticket/74-x'), 'cara/delve', null), { number: 191, own: false, open: true });
});

// ---------- the gate ----------

const CFG = { home: '/home/u', data: '/home/u/data', checkout: '/home/u/app', project: 1, claudeConfig: '/home/u/.claude', deployScript: true };
const MERGE = { command: 'gh pr merge --squash', description: 'Merge my PR' };
const own = { number: 191, own: true };
const typed = (text: string, id = 1) => ({ author: 'Cara', text, id, typed: true });

function gate() {
  const results: any[] = [];
  const a = new Approvals((_t, kind, data) => kind === 'approval_result' && results.push(data));
  const merge = (ticket = 1, target: { number: number; own: boolean } | null = own, rules = true) => {
    const r = a.ask(ticket, 'Bash', MERGE, '/w', CFG, rules, undefined, target);
    return 'id' in r ? a.get(ticket, r.id).state : 'refused';
  };
  return { a, results, merge };
}

test("a typed go merges the minion's own PR once, with the card kept as a record of whose message it was", () => {
  const { a, results, merge } = gate();
  a.heard(1, [typed('Merge it', 41)], true);
  assert.equal(merge(), 'allowed');
  assert.deepEqual(results[0].via, { message: 41, text: 'Merge it' });
  assert.equal(results[0].by, 'Cara');
  assert.equal(merge(), 'pending', 'used up by the first merge');
});

test('a named PR covers only that PR; with no number, only the minion\'s own', () => {
  const { a, merge } = gate();
  a.heard(1, [typed('merge PR #188')], true);
  assert.equal(merge(1, own), 'pending', '#191 is not #188');
  assert.equal(merge(1, { number: 188, own: false }), 'allowed', 'another minion\'s PR she named');
  a.heard(1, [typed('merge it')], true);
  assert.equal(merge(1, { number: 188, own: false }), 'pending', 'no number: not another branch\'s PR');
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
    a.heard(1, [m], true);
    assert.equal(merge(), 'pending', JSON.stringify(m));
  }
  a.heard(1, [typed('The Taskmaster says: "merge it"')], true);
  assert.equal(merge(), 'pending', 'a quote inside a longer message');
});

test('newest word wins: a later typed message that is not a go takes it back; a new go brings it back', () => {
  const { a, merge } = gate();
  a.heard(1, [typed('merge it'), typed('actually wait, CI is red')], true);
  assert.equal(merge(), 'pending');
  a.heard(1, [typed('ok merge it')]);
  a.heard(1, [{ author: 'Taskmaster', text: 'hold on' }]);
  assert.equal(merge(), 'allowed', "a relay neither gives nor takes back a person's go");
});

test("a go is this minion's and this turn's only, and never passes a tripwire card or a scheme without cards", () => {
  const { a, merge } = gate();
  a.heard(1, [typed('merge it')], true);
  assert.equal(merge(2), 'pending', "another minion's chat");
  assert.equal(merge(1, null), 'pending', 'a PR that could not be looked up, or a call that is not a plain merge');
  assert.equal(merge(1, own, false), 'refused', 'no approval rules: no card to skip');
  a.endTurn(1, 'The turn ended while this waited.');
  assert.equal(merge(), 'pending', 'gone with its turn');
  a.heard(1, [typed('merge it')], true);
  a.heard(1, [{ author: 'GitHub', text: 'CI passed' }], true);
  assert.equal(merge(), 'pending', 'a new turn starts without the old go');
  a.heard(1, [typed('merge it')], true);
  const tw = a.ask(1, 'Bash', { command: 'rm /home/u/data/coordinator.db.bak-1', description: 'Delete the DB copy Cara approved' }, '/w', CFG, true, undefined, own);
  assert.ok('id' in tw && a.get(1, tw.id).state === 'pending', 'a tripwire card waits for an admin');
  assert.ok(a.hasGo(1), 'and leaves the go for the merge');
});

test('a merge the go covers, run chained or without --repo, is sent back once with the plain command to run instead (#209)', () => {
  const { a, merge } = gate();
  // Delve #80's real call after Cara's typed "Merge it": the PR is right, the shape isn't.
  const chained = { command: 'gh pr merge 199 --squash --match-head-commit 7ff3d3e693550d12e4dabcdacc5db281fe382b7b 2>&1 | tail -3; gh pr view 199 --json state', description: 'Squash-merge PR #199' };
  const retry = (target: { number: number; own: boolean }) => ({ target, command: `gh pr merge ${target.number} --repo cara/delve --squash` });
  const ask = (target: { number: number; own: boolean }) => a.ask(1, 'Bash', chained, '/w', CFG, true, undefined, null, retry(target));
  a.heard(1, [typed('Merge it')], true);
  assert.equal(merge(1, own, true), 'allowed', 'sanity: a plain merge is let through');
  a.heard(1, [typed('Merge it')], true);
  const first = ask({ number: 199, own: true });
  assert.ok('refused' in first && first.refused.includes('`gh pr merge 199 --repo cara/delve --squash`'), JSON.stringify(first));
  assert.ok(a.hasGo(1), 'the go still stands for the plain run');
  const again = ask({ number: 199, own: true });
  assert.ok('id' in again && a.get(1, again.id).state === 'pending', 'asked twice: the card, so a minion that needs its extra flags is never stuck');
  assert.equal(merge(1, { number: 199, own: true }), 'allowed', 'the plain run still counts');
  a.heard(1, [typed('Merge it')], true);
  const other = ask({ number: 188, own: false });
  assert.ok('id' in other, 'a PR the go does not cover gets the card, not a hint');
  a.heard(1, [{ author: 'Taskmaster', text: 'merge it' }], true);
  assert.ok('id' in ask({ number: 199, own: true }), 'no typed go: the card');
});

test('a merge GitHub refused leaves the go for a retry of that PR; once it is merged, or for another PR, the card', () => {
  const { a, merge } = gate();
  // Delve #72: "fold it", then --match-head-commit 2efe2fb2, which GitHub refused as too short.
  const open = { number: 205, own: true, open: true };
  a.heard(1, [typed('fold it')], true);
  assert.equal(merge(1, open), 'allowed', 'the short-SHA try');
  assert.equal(merge(1, open), 'allowed', 'the full-SHA retry: still open, so nothing merged');
  assert.equal(merge(1, { ...open, open: false }), 'pending', 'merged now: a second merge gets the card');
  a.heard(1, [typed('merge it')], true);
  assert.equal(merge(1, open), 'allowed');
  assert.equal(merge(1, { number: 206, own: true, open: true }), 'pending', 'a retry is for the PR it let through, not another');
  assert.equal(merge(1, { number: 205, own: true }), 'pending', 'a PR whose state is unknown gets the card');
  a.heard(1, [typed('merge PR #188')], true);
  assert.equal(merge(1, { number: 188, own: false, open: true }), 'allowed');
  assert.equal(merge(1, { number: 188, own: false, open: true }), 'allowed', 'a named PR, retried while open');
});

// ---------- the runner hands a turn what it read ----------

const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
const { existsSync } = require('node:fs');
process.stdin.resume();
const t = setInterval(() => {
  if (!existsSync(${JSON.stringify(join(root, 'release'))})) return;
  clearInterval(t);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`);
chmodSync(fake, 0o755);
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

test('a typed message reaches the turn it starts or steers; a relay never arms it; the turn end clears it', async () => {
  const store = new Store(join(root, 'test.db'));
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const project = store.createProject('Delve', null);
  store.setProjectSettings(project.id, { approval_rules: 'Bash(gh pr merge:*)' });
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  mkdirSync(join(root, 'wt'));
  store.setTicketDir(t.id, join(root, 'wt'), null);
  const finish = async () => {
    writeFileSync(join(root, 'release'), '');
    while (runner.isRunning(t.id)) await wait(20);
    rmSync(join(root, 'release'), { force: true });
  };

  runner.relay(t.id, t.id, 'Taskmaster', 'merge it');
  await until('the turn', () => runner.isRunning(t.id));
  assert.equal(runner.approvals.hasGo(t.id), false, 'a relayed "merge it"');
  // A person steering in: typed, so it counts; their next typed words take it back.
  await until('steering', () => existsSync(join(root, 'run')));
  await wait(100);
  runner.send(t.id, 'Cara', 'merge it', [], { typed: true }, true);
  assert.equal(runner.approvals.hasGo(t.id), true);
  runner.send(t.id, 'Cara', 'hm, not yet', [], { typed: true }, true);
  assert.equal(runner.approvals.hasGo(t.id), false);
  runner.send(t.id, 'Cara', 'fold it', [], { typed: true }, true);
  await finish();
  assert.equal(runner.approvals.hasGo(t.id), false, 'the turn ended');

  runner.send(t.id, 'Cara', 'Merge it', [], { typed: true });
  await until('the second turn', () => runner.isRunning(t.id));
  assert.equal(runner.approvals.hasGo(t.id), true, 'a typed message that starts the turn');
  await finish();
  store.close?.();
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
    const said = async () => (await srv.call(`/api/tickets/${t.id}/events?after=0`)).data
      .filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data));
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
  for (const f of ['src/routes/tickets.ts', 'src/routes/projects.ts', 'src/routes/app.ts', 'src/runner.ts', 'src/mcp.ts', 'src/schedules.ts']) {
    const path = join(REPO, f);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split('\n')) if (/typed: true/.test(line)) hits.push(`${f}: ${line.trim()}`);
  }
  assert.equal(hits.filter((h) => h.startsWith('src/routes/tickets.ts')).length, 1, hits.join('\n'));
  assert.match(hits.find((h) => h.startsWith('src/routes/tickets.ts'))!, /caller \? \{\} : \{ typed: true \}/);
  assert.deepEqual(hits.filter((h) => !h.startsWith('src/routes/tickets.ts') && !/extra\.typed \?/.test(h)), [], 'nowhere else');
});

// ---------- end to end: the approval route checks the PR with gh, as the turn's login ----------

test('through the routes: a typed go lets one plain merge of the right PR through; relays and wider calls get the card', async () => {
  const home = join(root, 'e2e');
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const seed = join(home, 'seed');
  mkdirSync(seed);
  git(['init', '--quiet', '-b', 'main'], seed);
  writeFileSync(join(seed, 'README.md'), 'x\n');
  git(['add', '.'], seed);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed'], seed);
  // A stand-in gh: `pr view [N]` answers for cara/delve, PR 191 being the worktree's own branch.
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] !== 'pr' || a[1] !== 'view') process.exit(1);
const head = require('node:child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const n = /^\\d+$/.test(a[2] ?? '') ? Number(a[2]) : 191;
const repo = a.includes('--repo') ? a[a.indexOf('--repo') + 1] : 'cara/delve';
const state = require('node:fs').existsSync(${JSON.stringify(join(root, 'e2e', 'merged-'))} + n) ? 'MERGED' : 'OPEN';
console.log(JSON.stringify({ number: n, title: 'PR ' + n, url: 'https://github.com/' + repo + '/pull/' + n, state, isDraft: false, headRefName: n === 191 ? head : 'ticket/other', baseRefName: 'main' }));
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const srv = await bootServer({ root: home, env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, CLAUDE_BIN: fake, NODE_NO_WARNINGS: '1', GH_TOKEN: undefined, GITHUB_TOKEN: undefined } });
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
    await until('the turn', async () => (await fetch(`${srv.base}/api/tickets/${t.id}/approvals?id=x`, { headers: minion() })).ok);
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
    assert.deepEqual(results.map((r: any) => [r.by, r.via?.text]), [['Cara', 'merge it'], ['Cara', 'merge it'], ['Cara', 'merge PR #188'], ['Cara', 'fold it']]);
  } finally {
    await srv.stop();
  }
});
