// The minions list's state pill as data (public/threadstate.js): which family, text and rank each
// kind of minion gets, the usage-limit countdowns, and the list's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byUrgency, rowState, SHIP } from '../public/threadstate.js';

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
