import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { GithubWatcher, decide, githubRepo, turnSpans, verdict, type Check, type PrSnapshot, type Remark } from '../src/github.ts';

const root = mkdtempSync(join(tmpdir(), 'github-'));
after(() => rmSync(root, { recursive: true, force: true }));

const SHA = 'abc1234def5678';
const T = Date.parse('2026-10-27T12:00:00Z');

function pr(fields: Partial<PrSnapshot> = {}): PrSnapshot {
  return { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', headSha: SHA, closedAt: null, closedBy: null, checks: [], remarks: [], ...fields };
}
const check = (name: string, status: Check['status']): Check => ({ name, status, url: `https://ci/${name}` });
function remark(id: number, fields: Partial<Remark> = {}): Remark {
  return { key: `comment:${id}`, kind: 'comment', author: 'josh', bot: false, body: 'Looks good', url: `https://github.com/o/r/pull/12#issuecomment-${id}`, createdAt: T, ...fields };
}
const opts = (fields: Partial<Parameters<typeof decide>[2]> = {}) => ({ baseline: false, self: 'cara', spans: [], ...fields });

test('the first look records what is already there without sending it', () => {
  const seen = new Set<string>();
  const first = decide(pr({ checks: [check('build', 'failed')], remarks: [remark(1)] }), seen, opts({ baseline: true }));
  assert.deepEqual(first.messages, []);
  assert.deepEqual(first.handled.sort(), ['baseline', `ci:${SHA}:failed`, 'comment:1']);
  // Nothing changed since: nothing to say.
  assert.deepEqual(decide(pr({ checks: [check('build', 'failed')], remarks: [remark(1)] }), seen, opts()).messages, []);
});

test('each comment is sent once, with author, excerpt and link', () => {
  const seen = new Set(['baseline']);
  const long = 'x'.repeat(500);
  const d = decide(pr({ remarks: [remark(2, { body: `Please\n  rename ${long}` })] }), seen, opts());
  assert.equal(d.messages.length, 1);
  assert.match(d.messages[0], /^josh commented on PR #12: "Please rename x+…" https:\/\/github.com\/o\/r\/pull\/12#issuecomment-2$/);
  assert.ok(d.messages[0].length < 300);
  assert.deepEqual(decide(pr({ remarks: [remark(2)] }), seen, opts()).messages, []);
});

test('reviews and line comments read as such; an empty COMMENTED review is only their wrapper', () => {
  const d = decide(pr({ remarks: [
    remark(3, { key: 'review:3', kind: 'review', state: 'CHANGES_REQUESTED', body: 'A few things' }),
    remark(4, { key: 'review:4', kind: 'review', state: 'COMMENTED', body: '' }),
    remark(5, { key: 'line:5', kind: 'line', path: 'src/app.ts', body: 'Typo here' }),
    remark(6, { key: 'review:6', kind: 'review', state: 'APPROVED', body: '' }),
  ] }), new Set(['baseline']), opts());
  assert.deepEqual(d.messages.map((m) => m.replace(/ https:\S+$/, '')), [
    'josh requested changes on PR #12: "A few things"',
    'josh commented on src/app.ts in PR #12: "Typo here"',
    'josh approved PR #12',
  ]);
  assert.equal(d.handled.length, 4);
});

test("the account's own remarks during the ticket's turns are skipped; others' and later ones are not", () => {
  const spans: [number, number][] = [[T - 60_000, T + 60_000]];
  const d = decide(pr({ remarks: [
    remark(7, { author: 'Cara' }), // its own turn's comment (logins match case-insensitively)
    remark(8, { author: 'josh' }), // someone else, mid-turn: still news
    remark(9, { author: 'cara', createdAt: T + 60_000 + 10_000 }), // just after the turn: within the margin
    remark(10, { author: 'cara', createdAt: T + 10 * 60_000 }), // Cara herself, later
  ] }), new Set(['baseline']), opts({ spans }));
  assert.deepEqual(d.messages.map((m) => m.split(':')[0]), ['josh commented on PR #12', 'cara commented on PR #12']);
  assert.match(d.messages[1], /issuecomment-10$/);
  // Skipped ones are handled for good, not looked at again.
  assert.deepEqual(d.handled.sort(), ['comment:10', 'comment:7', 'comment:8', 'comment:9']);
});

test('a turn still running covers everything after it started', () => {
  const d = decide(pr({ remarks: [remark(11, { author: 'cara', createdAt: T + 3600_000 })] }), new Set(['baseline']), opts({ spans: [[T, Infinity]] }));
  assert.deepEqual(d.messages, []);
  assert.deepEqual(d.handled, ['comment:11']);
});

test('without knowing the account, every remark during a turn is skipped', () => {
  const d = decide(pr({ remarks: [remark(12)] }), new Set(['baseline']), opts({ self: null, spans: [[T - 1000, T + 1000]] }));
  assert.deepEqual(d.messages, []);
});

test('bots are skipped', () => {
  const d = decide(pr({ remarks: [remark(13, { author: 'copilot-pull-request-reviewer', bot: true })] }), new Set(['baseline']), opts());
  assert.deepEqual(d.messages, []);
  assert.deepEqual(d.handled, ['comment:13']);
});

test('CI: nothing while pending, a failure at once, a pass once everything finishes, each once per commit', () => {
  const seen = new Set(['baseline']);
  assert.equal(verdict([]), null);
  assert.deepEqual(decide(pr({ checks: [check('build', 'pending'), check('lint', 'passed')] }), seen, opts()).messages, []);

  const failed = decide(pr({ checks: [check('build', 'failed'), check('lint', 'pending')] }), seen, opts()).messages;
  assert.deepEqual(failed, [`CI failed on abc1234 in PR #12 (1 still running) — build: https://ci/build`]);
  assert.deepEqual(decide(pr({ checks: [check('build', 'failed'), check('lint', 'failed')] }), seen, opts()).messages, []);

  // A re-run that passes on the same commit is news; so is a new commit's failure.
  const passed = decide(pr({ checks: [check('build', 'passed'), check('lint', 'passed')] }), seen, opts()).messages;
  assert.deepEqual(passed, ['CI passed on abc1234 in PR #12 (2 checks).']);
  const next = decide(pr({ headSha: 'fff0000', checks: [check('build', 'failed'), check('lint', 'failed')] }), seen, opts()).messages;
  assert.equal(next[0], 'CI failed on fff0000 in PR #12 — 2 checks:\n- build: https://ci/build\n- lint: https://ci/lint');
});

test('merged or closed by someone is sent once; by the ticket\'s own turn it is not', () => {
  const merged = pr({ state: 'MERGED', closedAt: T, closedBy: 'josh', checks: [check('build', 'failed')] });
  const seen = new Set(['baseline']);
  // A closed PR's CI no longer matters.
  assert.deepEqual(decide(merged, seen, opts()).messages, ['PR #12 was merged by josh.']);
  assert.deepEqual(decide(merged, seen, opts()).messages, []);

  const own = pr({ state: 'CLOSED', closedAt: T, closedBy: 'cara' });
  assert.deepEqual(decide(own, new Set(['baseline']), opts({ spans: [[T - 5000, T + 5000]] })).messages, []);
  assert.deepEqual(decide(own, new Set(['baseline']), opts()).messages, ['PR #12 was closed by cara without merging.']);
});

test('turn spans: start to end, a start without an end runs to the next start, the last open one to openEnd', () => {
  assert.deepEqual(turnSpans([
    { at: 1, start: true }, { at: 2, start: false },
    { at: 3, start: false }, // a second end marker (stopped, then claude's error)
    { at: 4, start: true }, { at: 6, start: true },
  ], Infinity), [[1, 2], [4, 6], [6, Infinity]]);
});

test('GitHub remotes', () => {
  assert.equal(githubRepo('https://github.com/caraminden/claude-coordinator\n'), 'caraminden/claude-coordinator');
  assert.equal(githubRepo('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubRepo('git@github.com:o/my.repo.git'), 'o/my.repo');
  assert.equal(githubRepo('ssh://git@github.com/o/r'), 'o/r');
  assert.equal(githubRepo('/home/cara/src/r'), null);
  assert.equal(githubRepo('https://gitlab.com/o/r'), null);
});

test('the watcher sends new events into the ticket once, remembering them across a restart', async () => {
  const dbPath = join(root, 'watch.db');
  let store = new Store(dbPath);
  const project = store.createProject('P', null);
  const ticket = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(ticket.id, root, 'ticket/1-t');
  const t = store.getTicket(ticket.id)!;

  let snapshot = pr({ checks: [check('build', 'pending')], remarks: [remark(1)] });
  const sent: string[] = [];
  const watcher = (s: Store) => new GithubWatcher(s, (_id, text) => sent.push(text), async () => ({ pr: snapshot, self: 'cara' }));

  await watcher(store).poll(t, root, 'o/r');
  assert.deepEqual(sent, []); // the first look only records

  // A turn ran and its comment landed mid-turn; Josh's review came after it.
  const start = Date.now();
  store.addEvent(ticket.id, 'claude', { type: 'system', subtype: 'init', session_id: 's' });
  store.addEvent(ticket.id, 'claude', { type: 'result', subtype: 'success', is_error: false });
  const w = watcher(store);
  snapshot = pr({
    checks: [check('build', 'failed')],
    remarks: [remark(1), remark(2, { author: 'cara', createdAt: start }), remark(3, { key: 'review:3', kind: 'review', state: 'APPROVED', body: 'Nice', createdAt: start + 3600_000 })],
  });
  await w.poll(t, root, 'o/r');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^CI failed on abc1234 in PR #12 — build: https:\/\/ci\/build\n\njosh approved PR #12: "Nice" \S+$/);
  await w.poll(t, root, 'o/r');
  assert.equal(sent.length, 1);

  // A restart: nothing is sent again.
  store.db.close();
  store = new Store(dbPath);
  await watcher(store).poll(t, root, 'o/r');
  assert.equal(sent.length, 1);

  // A second PR from the same branch starts from its own first look.
  snapshot = pr({ number: 13, remarks: [remark(4)] });
  await watcher(store).poll(t, root, 'o/r');
  assert.equal(sent.length, 1);
  store.deleteTicket(ticket.id);
  assert.deepEqual(store.githubSeen(ticket.id, ''), []);
});
