// The minions list's state pill as data (public/threadstate.js): which family, text and rank each
// kind of minion gets, the usage-limit countdowns, and the list's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byUrgency, cardChip, rowBar, rowState, rowUnread, SHIP } from '../public/threadstate.js';

const NOW = Date.UTC(2026, 10, 10, 12);
const MIN = 60_000, HOUR = 60 * MIN;
const t = (over) => ({ status: 'idle', updated_at: NOW - 5 * MIN, ...over });
const pill = (over, usage = null) => {
  const { rank, fam, cell, pulse } = rowState(t(over), usage, NOW);
  return [rank, fam, cell, ...(pulse ? ['pulse'] : [])];
};

test('rowState: each kind of minion gets its family, text and rank', () => {
  const rows = [
    // what the minion is                                         rank, family, text
    [{}, [0, 'you', 'reply 5m']],
    [{ state: 'ready' }, [0, 'done', 'ready 5m']],
    [{ state: 'complete', note: 'nothing left' }, [0, 'done', 'complete 5m']],
    [{ state: 'try' }, [0, 'you', 'try it 5m']],
    [{ state: 'ready', pending_card_at: NOW - 2 * HOUR }, [0, 'you', '? 2h']],
    [{ approvals: 1, status: 'running' }, [0, 'you', 'approve 5m']],
    [{ status: 'error' }, [0, 'broken', 'stuck 5m']],
    [{ status: 'running' }, [1, 'work', 'working', 'pulse']],
    [{ status: 'running', steps: { done: 3, total: 7 } }, [1, 'work', '3/7', 'pulse']],
    [{ status: 'new' }, [1, 'work', 'working', 'pulse']],
    [{ status: 'new', parked_for: 12, state: 'parked' }, [4, 'idle', 'parked']],
    [{ state: 'outside' }, [2, 'wait', 'waiting']],
    [{ state: 'pending-deploy', steps: { done: 6, total: 6 } }, [2, 'wait', 'deploying 6/6']],
    [{ state: 'blocked' }, [2, 'broken', 'blocked']],
    // A card open on a parked or outside minion doesn't make it your move.
    [{ state: 'parked', pending_card_at: NOW - HOUR }, [4, 'idle', 'parked']],
    [{ status: 'closed', state: 'ready' }, [5, 'idle', 'dismissed']],
  ];
  for (const [over, want] of rows) assert.deepEqual(pill(over), want, JSON.stringify(over));
});

test('rowState: a complete minion says what is left in its label (#547)', () => {
  assert.equal(rowState(t({ state: 'complete', note: 'read: the audit report' }), null, NOW).label, 'Complete: read: the audit report');
  assert.equal(rowState(t({ state: 'complete' }), null, NOW).label, 'Complete: no work left');
});

test('rowState: ages and the steps flag', () => {
  assert.equal(pill({ updated_at: NOW - 20_000 })[2], 'reply now');
  assert.equal(pill({ updated_at: NOW - 3 * HOUR })[2], 'reply 3h');
  assert.equal(pill({ updated_at: NOW - 50 * HOUR })[2], 'reply 2d');
  // `counted` tells the row to drop the count from its activity line; `since` times a card from its posting.
  assert.equal(rowState(t({ status: 'running', steps: { done: 1, total: 2 } }), null, NOW).counted, true);
  assert.equal(rowState(t({ status: 'running' }), null, NOW).counted, false);
  assert.equal(rowState(t({ pending_card_at: NOW - HOUR }), null, NOW).since, NOW - HOUR);
});

test('rowState: a minion that hit the usage limit counts down, then becomes your move', () => {
  const limited = { status: 'error', state: 'limited' };
  // Its own resume time wins, in the short time-left form.
  assert.deepEqual(pill({ ...limited, limit_resume_at: NOW + 40 * MIN }), [2, 'wait', 'resumes 40m']);
  assert.equal(pill({ ...limited, limit_resume_at: NOW + 100 * MIN })[2], 'resumes 1h40');
  assert.equal(pill({ ...limited, limit_resume_at: NOW + 14 * HOUR })[2], 'resumes 14h');
  assert.equal(pill({ ...limited, limit_resume_at: NOW + 49 * HOUR })[2], 'resumes 2d');
  assert.equal(pill({ ...limited, limit_resume_at: NOW - HOUR })[2], 'resumes 1m');
  // Else the account's window that is still shut.
  const shut = { session: { status: 'rejected', resetsAt: NOW + 90 * MIN }, updatedAt: NOW };
  assert.deepEqual(pill(limited, shut), [2, 'wait', 'resets 1h30']);
  // A window whose reset has passed doesn't count; a later turn's report says the limit is over.
  const reopened = { weekly: { status: 'rejected', resetsAt: NOW - MIN }, updatedAt: NOW - MIN };
  assert.deepEqual(pill(limited, reopened), [0, 'you', 'resume 5m']);
  // Nothing known since it stopped.
  assert.deepEqual(pill(limited, { updatedAt: NOW - HOUR }), [2, 'wait', 'limit hit']);
  assert.deepEqual(pill(limited), [2, 'wait', 'limit hit']);
});

test('byUrgency: needs-you first with the longest wait on top, then working, waiting, parked; newest first within those', () => {
  const rows = [
    t({ id: 'parked', state: 'parked' }),
    t({ id: 'working-old', status: 'running', updated_at: NOW - HOUR }),
    t({ id: 'reply-new', updated_at: NOW - MIN }),
    t({ id: 'waiting', state: 'outside' }),
    t({ id: 'working-new', status: 'running', updated_at: NOW - MIN }),
    t({ id: 'reply-old', updated_at: NOW - 3 * HOUR }),
    // Timed from its card (2h), not from its last update (1m).
    t({ id: 'card', pending_card_at: NOW - 2 * HOUR, updated_at: NOW - MIN }),
  ];
  const order = rows.sort((a, b) => byUrgency(a, b, null, NOW)).map((r) => r.id);
  assert.deepEqual(order, ['reply-old', 'card', 'reply-new', 'working-new', 'working-old', 'waiting', 'parked']);
});

test('SHIP: every stage has a colour family, and only a branch has no badge', () => {
  for (const [stage, s] of Object.entries(SHIP)) {
    assert.match(s.fam, /^(idle|work|wait|done|broken)$/, stage);
    assert.equal(!s.badge, stage === 'branch', stage);
  }
});

// What a minion waits on (#544, src/waits.ts) colours its chip, which keeps the plan's steps (#551, Josh 2026-11-11:
// "the x/y should be the top level steps we always had before"; "What does "line 2nd" mean?"): the row's subtitle says the wait.
test('rowState: a wait colours the chip while working or outside, which keeps the steps; never over a needs-you state', () => {
  const line = { kind: 'land', stage: 'line', chip: 'line · 2nd', text: '2nd in line, behind #513 (testing)', since: NOW - MIN, usual: 160 };
  const testing = { ...line, stage: 'test', chip: 'land · 152/218', text: 'running the tests: 152 of 218 files', done: 152, total: 218 };
  const rows = [
    [{ status: 'running', steps: { done: 4, total: 5 }, wait: line }, [1, 'wait', '4/5']],
    [{ status: 'running', steps: { done: 3, total: 5 }, wait: testing }, [1, 'work', '3/5', 'pulse']],
    [{ status: 'running', wait: testing }, [1, 'work', 'working', 'pulse']],
    [{ state: 'outside', wait: testing }, [2, 'work', 'waiting', 'pulse']],
    [{ state: 'pending-deploy', steps: { done: 5, total: 5 }, wait: { ...line, kind: 'restart', stage: 'restart', chip: 'restart · 2 turns' } }, [2, 'wait', 'deploying 5/5']],
    [{ state: 'ready', wait: line }, [0, 'done', 'ready 5m']],
    [{ status: 'running', approvals: 1, wait: line }, [0, 'you', 'approve 5m']],
    [{ status: 'closed', wait: line }, [5, 'idle', 'dismissed']],
    // A PR's CI run (#546): violet while queued, blue while its jobs run, green or red once it ends.
    [{ state: 'outside', steps: { done: 4, total: 5 }, wait: { ...line, kind: 'ci', stage: 'queued', chip: 'CI · queued' } }, [2, 'wait', 'waiting 4/5']],
    [{ state: 'outside', wait: { ...line, kind: 'ci', stage: 'jobs', chip: 'CI · 1/3 jobs', done: 1, total: 3 } }, [2, 'work', 'waiting', 'pulse']],
    [{ state: 'outside', wait: { ...line, kind: 'ci', stage: 'passed', chip: 'CI · passed' } }, [2, 'done', 'waiting']],
    [{ state: 'outside', wait: { ...line, kind: 'ci', stage: 'failed', chip: 'CI · failed' } }, [2, 'broken', 'waiting']],
  ];
  for (const [over, want] of rows) assert.deepEqual(pill(over), want, JSON.stringify(over));
});

test("a row's subtitle says the wait in plain words, not the chip's shorthand (#551)", async () => {
  const { waitWords } = await import('../public/wait.js');
  const words = (w) => waitWords({ since: NOW, usual: null, chip: '', ...w });
  assert.equal(words({ kind: 'land', stage: 'line', text: '2nd in line, behind #552 (testing)' }), 'Waiting to land: 2nd in line, behind #552 (testing)');
  assert.equal(words({ kind: 'land', stage: 'test', text: 'running the tests: 152 of 218 files' }), 'Landing: running the tests: 152 of 218 files');
  assert.equal(words({ kind: 'land', stage: 'restart', text: 'waiting for 2 turns' }), 'Going live: waiting for 2 turns');
  assert.equal(words({ kind: 'restart', stage: 'restart', text: 'the restart waits for 2 running turns to end' }), 'Going live: the restart waits for 2 running turns to end');
  assert.equal(words({ kind: 'heavy', stage: 'slot', text: '2nd in line for a heavy slot, all held (#544)' }), '2nd in line for a heavy slot, all held (#544)');
  assert.equal(words({ kind: 'ci', stage: 'jobs', text: 'PR #900 · 1 of 3 jobs done' }), 'CI: PR #900 · 1 of 3 jobs done');
});

test('a wait bar fills by its counts when it has them, by elapsed against usual otherwise (#551)', async () => {
  const { waitPct } = await import('../public/wait.js');
  assert.equal(waitPct({ since: NOW - 80_000, usual: 160, done: 152, total: 218 }, NOW).toFixed(1), '69.7');
  assert.equal(waitPct({ since: NOW - 80_000, usual: 160 }, NOW), 50);
  assert.equal(waitPct({ since: NOW - 80_000, usual: 160, done: 1, total: 3, ended: NOW - 1000 }, NOW), 100);
});

test('a wait reads elapsed against its usual, and runs late past 15% over', async () => {
  const { waitTime, waitLate } = await import('../public/wait.js');
  const w = { since: NOW - 59_000, usual: 160 };
  assert.equal(waitTime(w, NOW), '59s of ~2m 40s');
  assert.equal(waitTime({ since: NOW - 59_000, usual: null }, NOW), '59s');
  assert.equal(waitLate(w, NOW), false);
  assert.equal(waitLate(w, NOW - 59_000 + 160_000 * 1.15 + 1000), true);
  assert.equal(waitLate({ since: NOW - HOUR, usual: null }, NOW), false);
  // A CI run that ended stops its clock there, and isn't late any more.
  assert.equal(waitTime({ since: NOW - HOUR, ended: NOW - HOUR + 95_000, usual: 160 }, NOW), '1m 35s of ~2m 40s');
  assert.equal(waitLate({ since: NOW - HOUR, ended: NOW - 1000, usual: 160 }, NOW), false);
});

test('rowBar: a bar only while it works or waits on a land, CI or a deploy; none while it waits on a person (#575)', () => {
  const bar = (over) => { const row = t(over); return rowBar(row, rowState(row, null, NOW)); };
  const half = { done: 2, total: 4 };
  const ci = { kind: 'ci', stage: 'ci', since: NOW - MIN, usual: 5 * MIN };
  // Cara, 2026-11-11: "if a minion is asking a question it shouldnt have a progress bar right?"
  assert.equal(bar({ steps: half, pending_card_at: NOW - MIN }), null, 'an open card, plan half done');
  for (const state of ['ready', 'try', 'complete', 'blocked', 'parked']) assert.equal(bar({ steps: half, state }), null, state);
  assert.equal(bar({ steps: half }), null, 'your move');
  assert.equal(bar({ status: 'error', state: 'limited', steps: half }), null, 'at the usage limit');
  assert.equal(bar({ status: 'running', approvals: 1, steps: half }), null, 'an approval card holds the turn');
  assert.equal(bar({ status: 'closed', steps: half }), null, 'dismissed');
  assert.equal(bar({ steps: half, state: 'ready', wait: ci }), null, 'a stale wait on a row waiting on you');
  assert.deepEqual(bar({ status: 'running', steps: half }), { ...half, track: null }, 'working: steps done');
  const steps = { ...half, since: NOW - MIN, usual: 120 }, track = [[2, 'c'], [3, 'c'], [2, 'i'], [null, 'p']];
  assert.deepEqual(bar({ status: 'running', steps, step_track: track }), { ...steps, track }, "working: the plan's track, its running step against its guess (#630)");
  assert.deepEqual(bar({ status: 'running', steps, step_track: track, wait: ci }), { ...steps, track, wait: ci }, 'a CI wait in the turn keeps the plan with it (#630)');
  assert.deepEqual(bar({ status: 'running', wait: ci }), { track: null, wait: ci }, 'a CI wait in a turn with no plan');
  assert.deepEqual(bar({ state: 'outside', steps: half, wait: ci }), { track: null, wait: ci }, 'waiting on CI after the turn');
  assert.equal(bar({ state: 'pending-deploy', wait: { kind: 'deploy', stage: 'restart', total: 3, done: 1 } }).wait.total, 3, 'a deploy');
  assert.equal(bar({ status: 'running', wait: { kind: 'land', stage: 'line', since: NOW, text: '2nd in line' } }).wait.stage, 'line', 'a landing in the line, with no estimate, still shows its stages');
  assert.equal(bar({ state: 'outside', steps: half }), null, 'waiting elsewhere with no estimate of its own');
  // Cara, 2026-11-14: "When a minion is created it should have the progress bar line there even if we dont yet know how many sections it will have"
  assert.deepEqual(bar({ status: 'running' }), { track: [[null, 'p']] }, 'working before its task list: an empty track holds the line');
  assert.deepEqual(bar({ status: 'new' }), { track: [[null, 'p']] }, 'just created, its first turn not started yet');
  assert.equal(bar({ status: 'new', parked_for: 12, state: 'parked' }), null, 'a new minion parked on start_after is not working');
});

test('rowUnread: an unseen row is unread only when it has something for a person, never while it works or waits on the system (#576)', () => {
  // Cara, 2026-11-11, of a row waiting to land and one deploying: "isnt that for when there is something you need to do?"
  const unread = (over, usage = null) => { const row = t(over); return rowUnread(row, rowState(row, usage, NOW), false); };
  const line = { kind: 'land', stage: 'line', chip: 'line · 2nd', text: '2nd in line, behind #575 (waiting for CI)', since: NOW - MIN, usual: 160 };
  const ci = (stage) => ({ ...line, kind: 'ci', stage, chip: `CI · ${stage}` });
  const forPerson = [
    [{}, 'your move'],
    [{ state: 'ready' }, 'ready'],
    [{ state: 'complete', note: 'read the report' }, 'complete'],
    [{ state: 'try' }, 'try it'],
    [{ state: 'ready', pending_card_at: NOW - MIN }, 'an open card'],
    [{ status: 'running', approvals: 1 }, 'an approval'],
    [{ status: 'error' }, 'stuck'],
    [{ state: 'blocked' }, 'blocked'],
    [{ status: 'error', state: 'limited' }, 'limit hit, reset seen since', { session: { status: 'allowed' }, updatedAt: NOW }],
  ];
  for (const [over, what, usage] of forPerson) assert.equal(unread(over, usage), true, what);
  const notForPerson = [
    [{ state: 'outside', wait: line }, 'waiting to land'],
    [{ state: 'pending-deploy', steps: { done: 1, total: 1 }, wait: { ...line, kind: 'restart', stage: 'restart', chip: 'restart · 2 turns' } }, 'deploying'],
    [{ state: 'pending-deploy' }, 'deploying, no wait yet'],
    [{ state: 'outside' }, 'waiting elsewhere'],
    [{ state: 'outside', wait: ci('queued') }, 'CI queued'],
    [{ state: 'outside', wait: ci('passed') }, 'CI passed: green chip, still the minion\'s move'],
    [{ state: 'outside', wait: ci('failed') }, 'CI failed: red chip, still the minion\'s move'],
    [{ status: 'error', state: 'limited', limit_resume_at: NOW + HOUR }, 'usage limit, resumes by itself'],
    [{ status: 'error', state: 'limited' }, 'usage limit, nothing known'],
    [{ status: 'running' }, 'working'],
    [{ status: 'running', wait: ci('failed') }, 'working, CI failed in the turn'],
    [{ state: 'parked' }, 'parked'],
    [{ status: 'closed', state: 'ready' }, 'dismissed'],
  ];
  for (const [over, what] of notForPerson) assert.equal(unread(over), false, what);
  assert.equal(rowUnread(t({ state: 'ready' }), rowState(t({ state: 'ready' }), null, NOW), true), false, 'seen since it changed');
});

test('cardChip: names the kind of card, counts one kind, and gives the oldest kind plus how many more when they differ (#575)', () => {
  const c = (what) => ({ kind: what === 'merge' || what === 'tripwire' ? 'approval' : what, what });
  for (const what of ['question', 'plan', 'merge', 'approval', 'tripwire']) assert.equal(cardChip([c(what)]), what);
  assert.equal(cardChip([c('question'), c('question')]), '2 questions');
  assert.equal(cardChip([c('plan'), c('question'), c('merge')]), 'plan +2', 'mixed: the oldest, which the chip opens');
  assert.equal(cardChip([{ kind: 'plan' }]), 'plan', 'a card from before `what` falls back to its kind');
});

test("a segmented track's pieces are as wide as their usual time, the average when unknown, never under 8% (#630)", async () => {
  const { segSizes } = await import('../public/wait.js');
  assert.deepEqual(segSizes([2, 9, 5]), [2, 9, 5]);
  assert.deepEqual(segSizes([4, null, 8]), [4, 6, 8], 'a step with no guess takes the average of the others');
  assert.deepEqual(segSizes([null, null]), [1, 1], 'none known: equal pieces');
  assert.deepEqual(segSizes([1, 100]), [8.08, 100], 'a 1-second rebase still shows, at 8% of the whole');
});

test("progressPieces: the plan's track stays through a wait, the wait filling the step underway; a landing with no step underway shows its stages (#630)", async () => {
  const { progressPieces } = await import('../public/wait.js');
  const track = [[2, 'c'], [3, 'i'], [null, 'p']];
  const test = { kind: 'land', stage: 'test', since: NOW - MIN, usual: 90, text: 'step 3 of 13' };
  const line = { kind: 'land', stage: 'line', since: NOW - MIN, text: '2nd in line' };
  const states = (r) => r.segs.map((s) => s.state + (s.waits ? '~' : '') + (s.clock ? '*' : ''));
  const est = progressPieces({ track, since: NOW - MIN, usual: 180 });
  assert.deepEqual(states(est), ['done', 'now*', ''], 'no wait: the step fills against its guess');
  assert.equal(est.segs[1].clock.usual, 180);
  const landing = progressPieces({ track, since: NOW - MIN, usual: 180, wait: test });
  assert.deepEqual(states(landing), ['done', 'now*', ''], 'a landing mid-step: still the plan, not the wait\'s solid bar');
  assert.equal(landing.segs[1].clock, test, 'the step underway fills by the wait');
  assert.deepEqual(states(progressPieces({ track, wait: line })), ['done', 'now~', ''], 'waiting in the line: the step underway is hatched');
  // Cara's screenshot: a land with no plan step underway read "Test 3/6" over one solid bar.
  const stages = progressPieces({ track: [[2, 'c'], [3, 'c']], wait: test });
  assert.deepEqual(states(stages), ['done', 'done', 'now*', '', '', ''], "no step underway: the landing's own six stages");
  assert.equal(stages.label, 'Test, stage 3 of 6');
  assert.deepEqual(states(progressPieces({ track: null, wait: line })), ['now~', '', '', '', '', ''], 'in the line with no estimate');
  const ci = { kind: 'ci', stage: 'ci', since: NOW - MIN, usual: 300 };
  assert.deepEqual(progressPieces({ track: null, wait: ci }), { bar: ci }, 'a CI wait with no plan step underway: its own bar');
  assert.equal(progressPieces({ track: null, wait: { kind: 'ci', stage: 'ci', since: NOW } }), null, 'nothing known: no bar');
  assert.equal(progressPieces({ track: [[2, 'c']], wait: null }).segs.length, 1, 'a plan with no wait: its steps');
});

test("waitLine: the list row's wait says what the chat's line does, one counter and the short words (#630)", async () => {
  const { waitLine } = await import('../public/wait.js');
  const ci = { kind: 'land', stage: 'test', since: NOW, usual: 90, text: 'waiting for CI: test step 10 of 13: the full suite (DESKTOP-G248IJ8-linux)', brief: 'CI: the full suite', done: 9, total: 13 };
  assert.equal(waitLine(ci), 'Test 3/6 · CI: the full suite', "Cara: 'are the tests on step 3/6 or 10/13?'");
  assert.equal(waitLine({ kind: 'land', stage: 'line', since: NOW, text: '2nd in line, behind #513' }), 'Land line 1/6 · 2nd in line, behind #513', 'no brief: the text');
});
