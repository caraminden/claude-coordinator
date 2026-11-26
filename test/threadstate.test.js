// The minions list's state pill as data (public/threadstate.js): which family, text and rank each
// kind of minion gets, the usage-limit countdowns, and the list's order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setAccount, setView } from '../public/base.js';
import { askWhy, mentions, byUrgency, cardChip, cardsYours, pacific, progressWhy, refBucket, rowBar, rowState, rowUnread, rowWhy, LOOK, serverLabel, SHIP, span, spokenCell, workerWaitLabel, workingBy } from '../public/threadstate.js';

const NOW = Date.UTC(2026, 10, 10, 12);
const MIN = 60_000,
  HOUR = 60 * MIN;
const JOB = { kind: 'job', text: 'Waiting for npm test to finish', since: NOW - 20 * MIN };
const t = (over) => ({ status: 'idle', updated_at: NOW - 5 * MIN, ...over });
const pill = (over, usage = null) => {
  const { rank, fam, cell, pulse } = rowState(t(over), usage, NOW);
  return [rank, fam, cell, ...(pulse ? ['pulse'] : [])];
};

test('rowState: each kind of minion gets its family, text and rank', () => {
  const rows = [
    // what the minion is                                         rank, family, text
    // Nothing running and nothing asked is idle, grey, not your move (#1121: it was amber "reply").
    [{}, [4, 'idle', '5m']],
    [{ replies: ['Ship it'] }, [0, 'you', '5m']],
    // For a person to look at, not an answer (#1121): after Needs you, before working.
    [{ state: 'ready' }, [LOOK, 'done', '5m']],
    [{ state: 'complete', note: 'nothing left' }, [LOOK, 'done', '5m']],
    [{ state: 'try' }, [LOOK, 'work', '5m']],
    [{ state: 'ready', pending_card_at: NOW - 2 * HOUR }, [0, 'you', '2h']],
    [{ approvals: 1, status: 'running' }, [0, 'you', '5m']],
    [{ status: 'error' }, [0, 'broken', '5m']],
    [{ status: 'running' }, [1, 'work', 'working', 'pulse']],
    [{ status: 'running', steps: { done: 3, total: 7 } }, [1, 'work', '3/7', 'pulse']],
    [{ status: 'new' }, [1, 'work', 'working', 'pulse']],
    // Parked until something wakes it by itself is waiting, violet, above grey parked (#718).
    [{ status: 'new', parked_for: 'x', wakes_on: 'x', state: 'parked' }, [3, 'wait', 'waiting']],
    // A chain held because its leader was dismissed unshipped: only Unpark starts it, so it's plain parked.
    [{ status: 'new', parked_for: 'x, so only Unpark starts you', state: 'parked' }, [4, 'idle', 'sealed']],
    [{ state: 'parked', wakes_on: 'Waiting on #9 going live' }, [3, 'wait', 'waiting']],
    [{ state: 'outside' }, [2, 'wait', 'waiting']],
    [{ state: 'pending-deploy', steps: { done: 6, total: 6 } }, [2, 'wait', 'deploying 6/6']],
    [{ state: 'blocked' }, [2, 'broken', 'blocked']],
    // A card open on a parked or outside minion doesn't make it your move.
    [{ state: 'parked', pending_card_at: NOW - HOUR }, [4, 'idle', 'sealed']],
    [{ status: 'closed', state: 'ready' }, [5, 'idle', 'dismissed']],
    // The server landing it after its turn ended (#727): working, blue, pulsing, whatever the land waits on.
    [{ server_work: { kind: 'land' } }, [1, 'work', 'shipping', 'pulse']],
    [{ server_work: { kind: 'land' }, wait: { kind: 'land', stage: 'line', chip: 'line · 2nd', text: '2nd in line', since: NOW, usual: 60 } }, [1, 'work', 'shipping', 'pulse']],
    [{ server_work: { kind: 'land' }, status: 'closed' }, [5, 'idle', 'dismissed']],
    // A job or wait it handed over (#1890) is work, not a ship, unless it stopped on something of yours.
    [{ server_work: JOB }, [1, 'work', 'working', 'pulse']],
    [{ server_work: JOB, steps: { done: 3, total: 7 } }, [1, 'work', '3/7', 'pulse']],
    [{ server_work: JOB, status: 'error' }, [0, 'broken', '5m']],
    [{ server_work: JOB, status: 'closed' }, [5, 'idle', 'dismissed']],
  ];
  for (const [over, want] of rows) assert.deepEqual(pill(over), want, JSON.stringify(over));
});

test("rowState: amber only for a card or replies of yours; another person's says whose (#1121)", () => {
  const card = (over) => ({ kind: 'question', href: '#/p/2/t/9?e=5', ...over });
  setAccount({ name: 'Josh' });
  try {
    const age = { pending_card_at: NOW - HOUR };
    assert.deepEqual(pill({ ...age, open_cards: [card({ to: 'josh' })] }), [0, 'you', '1h'], 'addressed to you, any case');
    assert.deepEqual(pill({ ...age, open_cards: [card()] }), [0, 'you', '1h'], "anyone's, on no one's minion");
    assert.deepEqual(pill({ ...age, open_cards: [card()], server_work: JOB }), [0, 'you', '1h'], 'a card wants you first, a job running on or not');
    assert.deepEqual(pill({ ...age, open_cards: [card()], properties: { assigned: 'Josh' } }), [0, 'you', '1h'], "anyone's, on yours");
    assert.deepEqual(pill({ ...age, open_cards: [card({ to: 'Cara' })] }), [2, 'wait', 'Cara 1h'], 'addressed to Cara');
    assert.deepEqual(pill({ ...age, open_cards: [card()], properties: { assigned: 'Cara' } }), [2, 'wait', 'Cara 1h'], "anyone's, on Cara's minion");
    assert.deepEqual(pill({ ...age, open_cards: [card({ to: 'Cara' }), card({ to: 'Josh' })] }), [0, 'you', '1h'], 'one of them yours');
    assert.equal(rowState(t({ ...age, open_cards: [card({ to: 'Cara' })] }), null, NOW).label, 'Waiting on Cara');
    assert.equal(rowState(t({ ...age, open_cards: [card()] }), null, NOW).label, 'Answer needed');
    assert.deepEqual(pill({ replies: ['Go'], properties: { assigned: 'Cara' } }), [2, 'wait', 'Cara 5m'], "Cara's go");
    // Whose the server says it is wins over the raw assignee (#1449): a gone assignee's minion is the owner's.
    assert.deepEqual(pill({ ...age, open_cards: [card()], assignee: 'Josh', properties: { assigned: 'Olive' } }), [0, 'you', '1h'], "Olive left: it's yours");
    assert.deepEqual(pill({ ...age, open_cards: [card()], assignee: null, properties: { assigned: 'Olive' } }), [0, 'you', '1h'], "no one's: anyone's");
    assert.equal(rowState(t({}), null, NOW).label, 'Idle');
    assert.equal(rowState(t({ state: 'try' }), null, NOW).label, 'Ready to try');
    // An approval is the assignee's, as the server counts it; the badge and the popover link go by whose card it is.
    assert.deepEqual(pill({ approvals: 1, status: 'running', properties: { assigned: 'Cara' } }), [2, 'wait', 'Cara 5m'], "Cara's approval");
    assert.deepEqual(pill({ approvals: 1, status: 'running', properties: { assigned: 'josh' } }), [0, 'you', '5m'], 'your approval');
    const mixed = { ...age, open_cards: [card({ to: 'Cara', href: '#cara' }), card({ to: 'Josh', href: '#josh' })] };
    assert.deepEqual(
      cardsYours(t(mixed)).map((c) => c.href),
      ['#josh'],
    );
    assert.equal(rowWhy(t(mixed), rowState(t(mixed), null, NOW), NOW).link.href, '#josh', "the popover opens your card, not the older one of Cara's");
    assert.deepEqual(cardsYours(t({ ...age, open_cards: [card({ to: 'Cara' })] })), [], 'none of yours: the badge goes violet');
  } finally {
    setAccount(null);
  }
});

test('rowState: a waiting minion says what wakes it in its label (#718)', () => {
  assert.equal(rowState(t({ state: 'parked', status: 'new', parked_for: "#3 T's work is merged", wakes_on: "#3 T's work is merged" }), null, NOW).label, "Waiting: starts when #3 T's work is merged");
  assert.equal(rowState(t({ state: 'parked', wakes_on: 'the fix in #9 goes live' }), null, NOW).label, 'Waiting: the fix in #9 goes live');
});

test('rowState: a complete minion says what is left in its label (#547)', () => {
  assert.equal(rowState(t({ state: 'complete', note: 'read: the audit report' }), null, NOW).label, 'Done, read it: read: the audit report');
  assert.equal(rowState(t({ state: 'complete' }), null, NOW).label, 'Done, read it');
});

test('spokenCell: a bare age is said in words after the label, as the pill lost its word (#1692)', () => {
  assert.equal(spokenCell({ cell: '3h', label: 'Answer needed' }), 'Answer needed, 3 hours');
  assert.equal(spokenCell({ cell: '1d', label: 'Idle' }), 'Idle, 1 day');
  assert.equal(spokenCell({ cell: 'now', label: 'Pending review' }), 'Pending review, just now');
  assert.equal(spokenCell({ cell: '@ 5m', label: 'Josh mentioned you' }), 'Josh mentioned you, 5 minutes');
  assert.equal(spokenCell({ cell: 'Josh 1h', label: 'Waiting on Josh' }), 'Waiting on Josh, Josh 1h', 'a cell with its own words follows as it is');
  assert.equal(spokenCell({ cell: '', label: 'Idle' }), 'Idle');
});

test('rowState: ages and the steps flag', () => {
  assert.equal(pill({ updated_at: NOW - 20_000 })[2], 'now');
  assert.equal(pill({ updated_at: NOW - 3 * HOUR })[2], '3h');
  assert.equal(pill({ updated_at: NOW - 50 * HOUR })[2], '2d');
  // `counted` tells the row to drop the count from its activity line; `since` times a card from its posting.
  assert.equal(rowState(t({ status: 'running', steps: { done: 1, total: 2 } }), null, NOW).counted, true);
  assert.equal(rowState(t({ status: 'running' }), null, NOW).counted, false);
  assert.equal(rowState(t({ pending_card_at: NOW - HOUR }), null, NOW).since, NOW - HOUR);
});

test('rowState: a minion that hit the usage limit counts down, then is idle until someone carries it on', () => {
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
  assert.deepEqual(pill(limited, reopened), [4, 'idle', '5m']);
  // Nothing known since it stopped.
  assert.deepEqual(pill(limited, { updatedAt: NOW - HOUR }), [2, 'wait', 'limit hit']);
  assert.deepEqual(pill(limited), [2, 'wait', 'limit hit']);
});

test('byUrgency: needs-you first with the longest wait on top, then working, waiting, parked; newest first within those', () => {
  const rows = [
    t({ id: 'parked', state: 'parked' }),
    t({ id: 'parked-until', state: 'parked', wakes_on: 'live' }),
    t({ id: 'working-old', status: 'running', updated_at: NOW - HOUR }),
    t({ id: 'reply-new', replies: ['Go'], updated_at: NOW - MIN }),
    t({ id: 'idle', updated_at: NOW - 2 * MIN }),
    t({ id: 'waiting', state: 'outside' }),
    t({ id: 'working-new', status: 'running', updated_at: NOW - MIN }),
    t({ id: 'reply-old', replies: ['Go'], updated_at: NOW - 3 * HOUR }),
    // Timed from its card (2h), not from its last update (1m).
    t({ id: 'card', pending_card_at: NOW - 2 * HOUR, updated_at: NOW - MIN }),
  ];
  const order = rows.sort((a, b) => byUrgency(a, b, null, NOW)).map((r) => r.id);
  assert.deepEqual(order, ['reply-old', 'card', 'reply-new', 'working-new', 'working-old', 'waiting', 'parked-until', 'idle', 'parked']);
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
  const testing = { ...line, stage: 'test', chip: 'ship · 152/218', text: 'running the tests: 152 of 218 files', done: 152, total: 218 };
  const rows = [
    [{ status: 'running', steps: { done: 4, total: 5 }, wait: line }, [1, 'wait', '4/5']],
    [{ status: 'running', steps: { done: 3, total: 5 }, wait: testing }, [1, 'work', '3/5', 'pulse']],
    [{ status: 'running', wait: testing }, [1, 'work', 'working', 'pulse']],
    [{ state: 'outside', wait: testing }, [2, 'work', 'waiting', 'pulse']],
    [{ state: 'pending-deploy', steps: { done: 5, total: 5 }, wait: { ...line, kind: 'restart', stage: 'restart', chip: 'restart · 2 turns' } }, [2, 'wait', 'deploying 5/5']],
    [{ state: 'ready', wait: line }, [LOOK, 'done', '5m']],
    [{ status: 'running', approvals: 1, wait: line }, [0, 'you', '5m']],
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
  assert.equal(words({ kind: 'land', stage: 'line', text: '2nd in line, behind #552 (testing)' }), 'Waiting to ship: 2nd in line, behind #552 (testing)');
  assert.equal(words({ kind: 'land', stage: 'test', text: 'running the tests: 152 of 218 files' }), 'Shipping: running the tests: 152 of 218 files');
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

test('a capped track fills a real count to done/total, and a time-only guess still stops at the cap (#1613)', async () => {
  const { waitFill } = await import('../public/wait.js');
  assert.ok(waitFill({ since: NOW - 80_000, usual: 160, done: 571, total: 572 }, NOW, 90) > 95);
  assert.equal(waitFill({ since: NOW - 80_000, usual: 160, done: 572, total: 572 }, NOW, 90), 97);
  assert.equal(waitFill({ since: NOW - 999_000, usual: 160 }, NOW, 90), 90);
  assert.equal(waitFill({ since: NOW - 80_000, usual: 160, done: 3, total: 6 }, NOW, 90), 50);
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
  const bar = (over) => {
    const row = t(over);
    return rowBar(row, rowState(row, null, NOW));
  };
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
  const steps = { ...half, since: NOW - MIN, usual: 120 },
    track = [
      [2, 'c'],
      [3, 'c'],
      [2, 'i'],
      [null, 'p'],
    ];
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
  assert.equal(rowBar(t({ status: 'new' }), { fam: '', cell: '' }), null, "a Taskmaster that hasn't run yet (sidebar.js gives it no rank)");
});

test('rowUnread: an unseen row is unread only when it has something for a person, never while it works or waits on the system (#576)', () => {
  // Cara, 2026-11-11, of a row waiting to land and one deploying: "isnt that for when there is something you need to do?"
  const unread = (over, usage = null) => {
    const row = t(over);
    return rowUnread(row, rowState(row, usage, NOW), false);
  };
  const line = { kind: 'land', stage: 'line', chip: 'line · 2nd', text: '2nd in line, behind #575 (waiting for CI)', since: NOW - MIN, usual: 160 };
  const ci = (stage) => ({ ...line, kind: 'ci', stage, chip: `CI · ${stage}` });
  const forPerson = [
    [{ replies: ['Go'] }, 'one-tap replies'],
    [{ state: 'ready' }, 'ready'],
    [{ state: 'complete', note: 'read the report' }, 'complete'],
    [{ state: 'try' }, 'try it'],
    [{ state: 'ready', pending_card_at: NOW - MIN }, 'an open card'],
    [{ status: 'running', approvals: 1 }, 'an approval'],
    [{ status: 'error' }, 'stuck'],
    [{ state: 'blocked' }, 'blocked'],
  ];
  for (const [over, what, usage] of forPerson) assert.equal(unread(over, usage), true, what);
  const notForPerson = [
    [{ state: 'outside', wait: line }, 'waiting to land'],
    [{ state: 'pending-deploy', steps: { done: 1, total: 1 }, wait: { ...line, kind: 'restart', stage: 'restart', chip: 'restart · 2 turns' } }, 'deploying'],
    [{ state: 'pending-deploy' }, 'deploying, no wait yet'],
    [{ state: 'outside' }, 'waiting elsewhere'],
    [{ state: 'outside', wait: ci('queued') }, 'CI queued'],
    [{ state: 'outside', wait: ci('passed') }, "CI passed: green chip, still the minion's move"],
    [{ state: 'outside', wait: ci('failed') }, "CI failed: red chip, still the minion's move"],
    [{ status: 'error', state: 'limited', limit_resume_at: NOW + HOUR }, 'usage limit, resumes by itself'],
    [{ status: 'error', state: 'limited' }, 'usage limit, nothing known'],
    [{ status: 'running' }, 'working'],
    // Idle (#1121): nothing asked of anyone, so no unread dot, the reset limit's idle row included.
    [{}, 'idle'],
    [{ status: 'error', state: 'limited' }, 'limit hit, reset seen since', { session: { status: 'allowed' }, updatedAt: NOW }],
    [{ status: 'running', wait: ci('failed') }, 'working, CI failed in the turn'],
    [{ state: 'parked' }, 'parked'],
    [{ status: 'closed', state: 'ready' }, 'dismissed'],
  ];
  for (const [over, what, usage] of notForPerson) assert.equal(unread(over, usage), false, what);
  assert.equal(rowUnread(t({ state: 'ready' }), rowState(t({ state: 'ready' }), null, NOW), true), false, 'seen since it changed');
});

test('cardChip: names the kind of card, counts one kind, and gives the oldest kind plus how many more when they differ (#575)', () => {
  const c = (what) => ({ kind: what === 'ship' || what === 'tripwire' ? 'approval' : what, what });
  for (const what of ['question', 'plan', 'approval', 'tripwire']) assert.equal(cardChip([c(what)]), what);
  // The go card reads "Ship It" (Cara, 2026-11-19), and two of them don't make "2 Ship Its".
  assert.equal(cardChip([c('ship')]), 'Ship It');
  assert.equal(cardChip([c('ship'), c('ship')]), 'Ship It ×2');
  assert.equal(cardChip([c('ship'), c('plan')]), 'Ship It +1');
  assert.equal(cardChip([c('question'), c('question')]), '2 questions');
  assert.equal(cardChip([c('plan'), c('question'), c('ship')]), 'plan +2', 'mixed: the oldest, which the chip opens');
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
  const track = [
    [2, 'c'],
    [3, 'i'],
    [null, 'p'],
  ];
  const test = { kind: 'land', stage: 'test', since: NOW - MIN, usual: 90, text: 'step 3 of 13' };
  const line = { kind: 'land', stage: 'line', since: NOW - MIN, text: '2nd in line' };
  const states = (r) => r.segs.map((s) => s.state + (s.waits ? '~' : '') + (s.clock ? '*' : ''));
  const est = progressPieces({ track, since: NOW - MIN, usual: 180 });
  assert.deepEqual(states(est), ['done', 'now*', ''], 'no wait: the step fills against its guess');
  assert.equal(est.segs[1].clock.usual, 180);
  const landing = progressPieces({ track, since: NOW - MIN, usual: 180, wait: test });
  assert.deepEqual(states(landing), ['done', 'now*', ''], "a landing mid-step: still the plan, not the wait's solid bar");
  assert.equal(landing.segs[1].clock, test, 'the step underway fills by the wait');
  assert.deepEqual(states(progressPieces({ track, wait: line })), ['done', 'now~', ''], 'waiting in the line: the step underway is hatched');
  const two = [
    [2, 'c'],
    [3, 'i'],
    [4, 'i'],
  ];
  assert.deepEqual(states(progressPieces({ track: two, since: NOW - MIN, usual: 180, wait: test })), ['done', 'now*', 'now'], 'two steps underway: the first fills from the wait');
  assert.deepEqual(states(progressPieces({ track: two, wait: line })), ['done', 'now~', 'now'], 'two steps underway in the line: only the first is hatched');
  assert.deepEqual(states(progressPieces({ track: two, since: NOW - MIN, usual: 180 })), ['done', 'now*', 'now'], 'no wait: the one scaled guess is not shared either');
  // Josh, 2026-11-26: every step underway draws the same way, each filling by its own real clock (#2156).
  const own = [
    [3, 'i', NOW - MIN, 180],
    [4, 'i', NOW - 2 * MIN, 240],
    [null, 'i'],
    [5, 'i', null, 300, 60_000],
  ];
  const clocks = (pieces) => pieces.segs.map((s) => s.clock);
  assert.deepEqual(clocks(progressPieces({ track: own, since: NOW - MIN, usual: 180 })), [{ since: NOW - MIN, usual: 180 }, { since: NOW - 2 * MIN, usual: 240 }, null, { total: 300_000, done: 60_000 }]);
  const waiting = progressPieces({ track: own, wait: test });
  assert.equal(waiting.segs[0].clock, test, 'the wait still owns one step');
  assert.deepEqual(waiting.segs[1].clock, { since: NOW - 2 * MIN, usual: 240 }, 'the others keep their own');
  // Cara's screenshot: a land with no plan step underway read "Test 3/6" over one solid bar.
  const stages = progressPieces({
    track: [
      [2, 'c'],
      [3, 'c'],
    ],
    wait: test,
  });
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
  assert.equal(waitLine({ kind: 'land', stage: 'line', since: NOW, text: '2nd in line, behind #513' }), 'Ship line 1/6 · 2nd in line, behind #513', 'no brief: the text');
});

test('workingBy: one working rule with two sources, a turn and the server; labels say who (#727)', () => {
  assert.equal(workingBy(t({ status: 'running' })), 'turn');
  assert.equal(workingBy(t({ status: 'new' })), 'turn', 'a first turn setting up');
  assert.equal(workingBy(t({ status: 'new', state: 'parked', wakes_on: 'the box has room' })), null, 'a start held because the box is starved waits, it does not work');
  assert.equal(workingBy(t({ status: 'new', kind: 'coordinator' })), null, "a Taskmaster that hasn't run is only ready");
  assert.equal(workingBy(t({ server_work: { kind: 'land' } })), 'server');
  assert.equal(workingBy(t({ status: 'running', server_work: { kind: 'land' } })), 'turn', 'a person wrote mid-land: its own turn speaks');
  assert.equal(workingBy(t({ state: 'parked', wakes_on: 'Waiting on #9 going live' })), null, "waiting on another's deploy is waiting");
  assert.equal(workingBy(t({ state: 'pending-deploy' })), null, 'its own deploy after a clean land is Deploying');
  // Cara, 2026-11-14: "This Minion is working" and "This Taskmaster is working".
  assert.equal(rowState(t({ status: 'running' }), null, NOW).label, 'This Minion is working');
  assert.equal(rowState(t({ status: 'running', kind: 'coordinator' }), null, NOW).label, 'This Taskmaster is working');
  assert.equal(rowState(t({ server_work: JOB }), null, NOW).label, 'Waiting for npm test to finish');
  assert.equal(rowState(t({ server_work: { kind: 'land' }, wait: { kind: 'land', stage: 'test', chip: 'ship · CI', text: 'waiting for CI', brief: 'CI: the full suite', since: NOW, usual: null } }), null, NOW).label, 'Server: testing (CI: the full suite)');
});

test('serverLabel: the land phase in words, from the wait the server already records (#727)', () => {
  const w = (stage, over = {}) => ({ kind: 'land', stage, chip: 'ship · x', text: 'detail', since: NOW, usual: null, ...over });
  assert.equal(serverLabel(null), 'Server is shipping…');
  assert.equal(serverLabel(w('line', { chip: 'line · 2nd' })), 'Server: in the ship line (2nd)');
  assert.equal(serverLabel(w('rebase')), 'Server: rebasing');
  assert.equal(serverLabel(w('test')), 'Server: testing (detail)');
  assert.equal(serverLabel(w('jobs', { kind: 'ci', brief: 'CI: the full suite' })), 'Server: testing (CI: the full suite)');
  assert.equal(serverLabel(w('deploy')), 'Server: deploying');
  assert.equal(serverLabel(w('restart')), 'Server: waiting for the restart');
});

test("rowBar: the server's land draws the landing's track as a turn's wait does (#727)", () => {
  const row = t({
    server_work: { kind: 'land' },
    steps: { done: 4, total: 4 },
    step_track: [
      [3, 'c'],
      [2, 'c'],
    ],
    wait: { kind: 'land', stage: 'test', chip: 'ship · CI', text: 'x', since: NOW, usual: 120 },
  });
  const bar = rowBar(row, rowState(row, null, NOW));
  assert.equal(bar.wait.stage, 'test');
});

test('rowState: a minion on its way in a release shows that release where landing or deploying would (#764)', () => {
  const release = { name: 'Build 997', target: 'Peek for Windows', stage: 'CI', text: 'on main: it goes out with the next build CI ships' };
  assert.deepEqual(pill({ server_work: { kind: 'land' }, release }), [1, 'work', 'Build 997', 'pulse']);
  assert.deepEqual(pill({ state: 'pending-deploy', release }), [2, 'wait', 'Build 997']);
  // Dismissed once landed, still not live: waiting colour, not grey "dismissed".
  assert.deepEqual(pill({ status: 'closed', state: 'ready', release: { ...release, name: 'Next build' } }), [2, 'wait', 'Next build']);
  assert.equal(rowState(t({ status: 'closed', release }), null, NOW).label, 'On its way: Peek for Windows Build 997: CI, on main: it goes out with the next build CI ships');
  assert.match(rowState(t({ server_work: { kind: 'land' }, release }), null, NOW).label, / · Peek for Windows Build 997: CI/);
});

// #906: every state the list, the inbox and Releases can show says why, with since when in Pacific.
const QUIET = { status: 'running', activity: { at: NOW - 14 * MIN, quiet_since: NOW - 9 * MIN, tool: { name: 'Bash', label: 'Bash: citadel-test test/media.test.ts', started: NOW - 14 * MIN, limit: 5 * MIN } } };

test('rowState: a quiet turn stays running blue with a stopped dot and says how long (#906)', () => {
  assert.deepEqual(pill(QUIET), [1, 'work', '14m']);
  const st = rowState(t(QUIET), null, NOW);
  assert.equal(st.quiet, true);
  assert.equal(st.pulse, undefined, 'no pulse: the dot stops');
  // A wait doesn't recolour or re-pulse it, and a turn not yet quiet is plain working.
  assert.deepEqual(pill({ ...QUIET, wait: { kind: 'heavy', stage: 'run', chip: 'x', text: 'x', since: NOW, usual: 60 } }), [1, 'work', '14m']);
  assert.deepEqual(pill({ status: 'running', activity: { at: NOW - MIN, quiet_since: null, tool: null } }), [1, 'work', 'working', 'pulse']);
});

test('rowWhy: a quiet turn names its last tool, its timeout and how far past it, in Pacific (#906)', () => {
  const why = rowWhy(t(QUIET), rowState(t(QUIET), null, NOW), NOW);
  assert.equal(why.quiet, true);
  assert.equal(why.title, 'Quiet 14m');
  assert.match(why.lines[0], /^No output for 14m, since 3:46 AM PST\.$/);
  assert.equal(why.lines[1], 'Last: Bash: citadel-test test/media.test.ts, started 3:46 AM PST with a 5m timeout, now 9m past it.');
});

test('rowWhy: every state rowState gives has a title and a reason; cards and releases link to what they wait on (#906)', () => {
  const wait = { kind: 'land', stage: 'line', chip: 'line · 2nd', text: '2nd in line, behind #513 (testing)', since: NOW - 4 * MIN, usual: 540 };
  const card = { kind: 'question', what: 'question', href: '#/p/2/t/9?e=5' };
  const release = { name: 'Release 14', target: 'Citadel', stage: 'restart', text: 'waits for 3 turns' };
  const states = [
    {},
    { replies: ['Go'] },
    { pending_card_at: NOW - HOUR, open_cards: [{ ...card, to: 'Cara' }] },
    { state: 'ready' },
    { state: 'complete', note: 'nothing left' },
    { state: 'try' },
    { approvals: 1, status: 'running', open_cards: [card] },
    { state: 'ready', pending_card_at: NOW - HOUR, open_cards: [card] },
    { status: 'error' },
    { status: 'running' },
    { status: 'running', turnStartedAt: NOW - 12 * MIN, last_activity: 'Editing thread.css', steps: { done: 2, total: 5, since: NOW - 3 * MIN, usual: 300 } },
    { status: 'new' },
    { status: 'new', parked_for: 'x', wakes_on: 'x', state: 'parked' },
    { state: 'parked' },
    { state: 'parked', wakes_on: 'the fix in #9 goes live' },
    { state: 'outside', wait },
    { state: 'pending-deploy' },
    { state: 'pending-deploy', release },
    { state: 'blocked', note: 'needs Cody' },
    { status: 'closed' },
    { status: 'closed', release },
    { server_work: { kind: 'land' }, wait },
    { server_work: { kind: 'land' }, release },
    { status: 'error', state: 'limited', limit_resume_at: NOW + 40 * MIN },
    { status: 'error', state: 'limited' },
    QUIET,
  ];
  for (const over of states) {
    const m = t({ project_id: 2, ...over });
    const why = rowWhy(m, rowState(m, null, NOW), NOW);
    assert.ok(why.title, `a title for ${JSON.stringify(over)}`);
    assert.ok(why.lines.length && why.lines.every((l) => l.trim()), `a reason for ${JSON.stringify(over)}`);
  }
  const of = (over) => {
    const m = t({ project_id: 2, ...over });
    return rowWhy(m, rowState(m, null, NOW), NOW);
  };
  assert.deepEqual(of({ pending_card_at: NOW - HOUR, open_cards: [card] }).link, { href: card.href, text: 'Open the question card →' });
  assert.equal(of({ status: 'closed', release }).link.href, '#/p/2/releases/2');
  // A wait says what and against its usual; a ready minion says since when.
  const landing = of({ state: 'outside', wait });
  assert.equal(landing.lines[0], 'Waiting to ship: 2nd in line, behind #513 (testing).');
  assert.equal(landing.more, '4m so far; usually ~9m. Started 3:56 AM PST.');
  assert.equal(of({ state: 'ready' }).lines[0], 'Since 3:55 AM PST, 5m ago.');
  assert.equal(of({ state: 'blocked', note: 'needs Cody' }).lines.at(-1), 'Note: needs Cody');
});

test('askWhy: every kind of Needs-you item says why it is there and since when (#906)', () => {
  const at = NOW - 10 * MIN;
  const kinds = [
    { kind: 'approval', card: {} },
    { kind: 'question', card: {} },
    { kind: 'question', card: { doc: 'x.html' } },
    { kind: 'question', card: { notice: 'x' } },
    { kind: 'question', card: { secret: { name: 'X' } } },
    { kind: 'plan', card: {} },
    { kind: 'spend', card: { stage: 5 } },
    { kind: 'quiet' },
    { kind: 'replies' },
    { kind: 'mention', card: { by: 'Cara', text: '@Josh can you look at this' } },
  ];
  for (const item of kinds) {
    const why = askWhy({ at, ...item }, { state: 'ready' }, NOW);
    assert.match(why, /3:50 AM PST/, item.kind);
    assert.doesNotMatch(why, /^Waiting on you since/, `${item.kind} has its own words`);
  }
  assert.match(askWhy({ kind: 'question', at, card: { doc: 'x.html' } }, null, NOW), /^A choices page card/);
  assert.equal(askWhy({ kind: 'mention', at, card: { by: 'Cara', text: '@Josh look' } }, null, NOW), 'Cara mentioned you at 3:50 AM PST: "@Josh look". It leaves once you open its chat.');
});

test('rowState: a mention of you is yours until you open its chat; a card of yours says more (#1149)', () => {
  mentions.set(7, { by: 'Cara', at: NOW - HOUR });
  setAccount({ name: 'Josh' });
  try {
    setView({ seen: {} });
    assert.deepEqual(pill({ id: 7, state: 'ready' }), [0, 'you', '@ 1h']);
    assert.equal(rowState(t({ id: 7, state: 'parked' }), null, NOW).label, 'Cara mentioned you');
    assert.deepEqual(pill({ id: 8, state: 'ready' }), [LOOK, 'done', '5m'], 'another minion is as it was');
    assert.equal(rowState(t({ id: 7, pending_card_at: NOW - MIN, open_cards: [{ kind: 'question', to: 'Josh' }] }), null, NOW).label, 'Answer needed');
    setView({ seen: { 7: NOW - MIN } });
    assert.deepEqual(pill({ id: 7, state: 'ready' }), [LOOK, 'done', '5m'], 'opened since: back to its own state');
  } finally {
    mentions.clear();
    setView(null);
    setAccount(null);
  }
});

test('progressWhy: a release says its stage, what it waits on, since when and its usual (#906)', () => {
  assert.equal(progressWhy({ stage: 'deploy', since: NOW - 3 * MIN, usual: 240, waitingOn: null, text: 'deploying' }, 'Deploy', NOW), 'Deploy: deploying.\nSince 3:57 AM PST, 3m so far; usually ~4m.');
  assert.equal(progressWhy({ stage: 'line', since: NOW - 9 * MIN, usual: null, waitingOn: '2nd in line, behind #620', text: '' }, 'Line', NOW), 'Line: 2nd in line, behind #620.\nSince 3:51 AM PST, 9m so far; no estimate while it waits.');
});

test('pacific and span: clock times are Pacific with the day once old; spans read short (#906)', () => {
  assert.equal(pacific(NOW, NOW), '4:00 AM PST');
  assert.equal(pacific(NOW - 30 * HOUR, NOW), 'Sun, 10:00 PM PST');
  assert.deepEqual([span(20_000), span(14 * MIN), span(65 * MIN), span(2 * HOUR), span(51 * HOUR)], ['under a minute', '14m', '1h 5m', '2h', '2d 3h']);
});

test('refBucket: a minion link in chat is waiting, working, deployed or neutral (#1743), not the sidebar family', () => {
  const live = { stage: 'live' };
  const rows = [
    // [what the minion is, bucket]
    [null, 'neutral'], // not in the loaded list (another scheme)
    [{ kind: 'coordinator' }, 'neutral'],
    [{}, 'neutral'], // idle, nothing pending
    [{ status: 'running' }, 'working'],
    [{ status: 'new' }, 'working'], // queued first turn
    [{ status: 'new', parked_for: 'start_after' }, 'neutral'],
    [{ server_work: { kind: 'land' }, wait: { stage: 'test' } }, 'working'],
    [{ server_work: { kind: 'land' }, wait: { stage: 'line' } }, 'waiting'], // behind others in the ship line
    [{ state: 'pending-deploy' }, 'working'], // the sidebar shows violet "wait"
    [{ state: 'ready' }, 'waiting'], // the sidebar shows green "done"
    [{ state: 'complete', note: 'nothing left' }, 'waiting'],
    [{ state: 'try' }, 'waiting'], // the sidebar shows blue "work"
    [{ state: 'parked' }, 'waiting'], // the sidebar shows grey "idle"
    [{ state: 'blocked' }, 'waiting'],
    [{ state: 'outside' }, 'waiting'],
    [{ state: 'limited', status: 'error' }, 'waiting'],
    [{ status: 'error' }, 'waiting'],
    [{ pending_card_at: NOW }, 'waiting'],
    [{ replies: ['Ship it'] }, 'waiting'],
    [{ approvals: 1 }, 'waiting'],
    [{ ship: live }, 'deployed'], // open and idle, its change live
    [{ ship: live, state: 'complete' }, 'waiting'], // but a read-it deliverable still waits on people
    [{ ship: live, pending_card_at: NOW }, 'waiting'],
    [{ ship: { stage: 'failed' } }, 'waiting'],
    [{ status: 'closed' }, 'neutral'], // dismissed without shipping
    [{ status: 'closed', ship: live }, 'deployed'],
    [{ status: 'closed', ship: { stage: 'main', text: 'On main, not deployed' } }, 'working'], // Citadel's own: a deploy still to come
    // Another scheme's repo (TripPresenter #73, 2026-11-23): shipped to main is as far as it goes, so it's done, not working forever.
    [{ status: 'closed', ship: { stage: 'main', text: 'Shipped to main' } }, 'deployed'],
    [{ ship: { stage: 'main', text: 'Shipped to main' } }, 'deployed'],
    // A contraption scheme (TripPresenter #72, #73): pending-deploy while its deploy runs, then dismissed once healthy.
    [{ state: 'pending-deploy', ship: { stage: 'main', text: 'Shipped to main' } }, 'working'],
    [{ status: 'closed', state: 'pending-deploy', note: 'Deployed trippresenter at f001fc5dc, healthy', ship: { stage: 'main', text: 'Shipped to main' } }, 'deployed'],
    // A release target (APK, desktop): working while its release is on its way, stuck waits, released is deployed.
    [{ status: 'closed', ship: { stage: 'main', text: 'Shipped to main' }, release: { stuck: true } }, 'waiting'],
    [{ status: 'closed', ship: { stage: 'main', text: 'Shipped to main' }, release: { stuck: false } }, 'working'], // an APK or contraption release on its way
    [{ status: 'closed', ship: live, release: { stuck: false } }, 'working'], // its release is still on its way
    [{ status: 'closed', release: { stuck: true } }, 'waiting'],
  ];
  for (const [over, bucket] of rows) assert.equal(refBucket(over && { ...t({}), ...over }), bucket, JSON.stringify(over));
});

test('a minion waiting for a worker shows as working; its hover says its place and since when, or who paused (#1868)', () => {
  const waiting = { status: 'running', last_activity: 'Running tests', worker_wait: { since: NOW - 3 * MIN, place: 3, of: 8, paused: null } };
  assert.deepEqual(pill(waiting), [1, 'work', 'working', 'pulse']);
  const why = (over) => rowWhy(t(over), rowState(t(over), null, NOW), NOW).lines;
  assert.equal(why(waiting)[0], 'Waiting for a worker, 3rd in line.');
  assert.match(why(waiting)[1], /^Since .*3m ago\.$/);
  assert.equal(why(waiting).length, 2, 'no stale step from its last turn');
  assert.equal(why({ ...waiting, worker_wait: { ...waiting.worker_wait, paused: 'Josh' } })[0], 'Waiting: Josh paused all minions.');
});

test('workerWaitLabel: one a person started now says so, and why it still waits (#1957)', () => {
  const hold = { by: 'Josh', since: 1 };
  assert.equal(workerWaitLabel({ place: 3, held: null }, hold), 'Starting now, on a worker of its own');
  assert.equal(workerWaitLabel({ place: 1, held: 'Cara paused all minions', paused: 'Cara' }, hold), 'Waiting: Cara paused all minions');
  assert.equal(workerWaitLabel({ place: 3 }, null), 'Waiting for a worker, 3rd in line');
  assert.equal(workerWaitLabel({ place: 3, quick: true }, null), 'Waiting for a worker, 3rd in line, or the quick lane');
});

test('workerWaitLabel: places read as words do', () => {
  const at = (place) => workerWaitLabel({ place }).match(/, (\w+) in/)[1];
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 112].map(at), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '112th']);
});
