// Card links (#400): every mention of a card links to it (Cara, 2026-11-08: "I thought I asked you to make
// any reference to a card come with a link to that card, but I just was asked about a card in transdata
// and it wasn't a link"). The tools hand out the link; the link check sends a reply back once without it.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cardHref, cardLabel, cardText, cardWhat, misplacedCards, settledHow, staleCards, unlinkedCards, type CardLink, type SettledCard } from '../src/card-links.ts';
import { Store } from '../src/db.ts';
import { check, SENT_BACK } from '../src/link-check.ts';
import { Runner } from '../src/runner.ts';
import { clockTime } from '../src/pacific.ts';
import type { SchemeRefs } from '../src/scheme-refs.ts';
import { testPins } from './helpers.ts';
import { FakeClock } from './fake-clock.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'card-links-'));
after(() => rmSync(root, { recursive: true, force: true }));

const card = (minion: number | null, event: number, kind: CardLink['kind'] = 'question'): CardLink =>
  ({ minion, kind, label: 'Layout', href: `${minion == null ? '#/p/2' : `#/p/2/t/${minion}`}?e=${event}` });
const cards = [card(394, 11), card(400, 22, 'plan'), card(null, 33)];
const missing = (text: string, self: number | null = 400) => unlinkedCards(text, cards, self).map((g) => g.map((c) => c.href));

test('cardHref opens a minion\'s or the Taskmaster\'s chat at the card (base.js jumpHref)', () => {
  assert.equal(cardHref({ project_id: 2, kind: 'ticket', number: 394, id: 9 }, 11), '#/p/2/t/394?e=11');
  assert.equal(cardHref({ project_id: 2, kind: 'coordinator', number: null, id: 1 }, 33), '#/p/2?e=33');
  assert.equal(cardLabel('plan', { summary: 'Build it this way' }), 'Build it this way');
  assert.equal(cardLabel('question', { questions: [{ header: 'Layout' }, { question: 'Which?' }] }), 'Layout, Which?');
  assert.equal(cardLabel('approval', { tool: 'Bash', input: { description: 'Restart' } }), 'Bash: Restart');
  assert.equal(cardLabel('question', { questions: [], doc: { path: '/w/takes.html', title: 'Header takes' } }), 'picks on “Header takes”');
});

test('flags a card mentioned without its link: another minion\'s by #N, else this chat\'s own', () => {
  // The Taskmaster relaying (the Transdata case).
  assert.deepEqual(missing('#394 has a card waiting on your pick.', null), [['#/p/2/t/394?e=11']]);
  assert.deepEqual(missing("#394's card is still open.", null), [['#/p/2/t/394?e=11']]);
  // A minion pointing at its own card.
  assert.deepEqual(missing('Pick a layout on the card below.'), [['#/p/2/t/400?e=22']]);
  // #N with no card waiting: the paragraph's card is this chat's.
  assert.deepEqual(missing('#236 built the jump; answer the card above.'), [['#/p/2/t/400?e=22']]);
  // The Taskmaster's own card.
  assert.deepEqual(missing('Approve the plan card below.', null), [['#/p/2?e=33']]);
});

test('lets through linked cards, other senses with no card waiting, and code', () => {
  for (const ok of [
    'Pick a layout on [the card below](#/p/2/t/400?e=22).',
    // One link serves the paragraph and the rest of the reply.
    '[The card](#/p/2/t/400?e=22) has two options.\n\nThe card recommends tabs.',
    // An absolute link into the app counts too.
    '#394 has [a card](https://cara.example/c/#/p/2/t/394?e=11) waiting.',
    'No mention of anything waiting.',
    'The fix is in `card.ts`.',
    // Cardinal, discard: not the word.
    'Discard the cardinal sins.',
  ]) assert.deepEqual(missing(ok), [], ok);
  // No card waiting here at all.
  assert.deepEqual(missing('The card spacing is fixed.', 395), []);
  assert.deepEqual(unlinkedCards('#394 has a card.', [], null), []);
});

test('the link check sends a reply back once with the card\'s link, then lets the rewrite through', async () => {
  const dir = join(root, 'turn');
  mkdirSync(dir, { recursive: true });
  const refs: SchemeRefs = { scheme: 'Citadel', others: [], minions: {}, self: null, cards };
  writeFileSync(join(dir, 'scheme-refs.json'), JSON.stringify(refs));
  const cfg = { cwd: dir, roots: [dir], nudged: join(dir, 'nudged'), refs: join(dir, 'scheme-refs.json') };
  const verdict = await check({ last_assistant_message: '#394 has a card waiting on you.', prompt_id: 'p1' }, cfg);
  assert.equal(verdict?.decision, 'block');
  assert.ok(verdict!.reason.startsWith(SENT_BACK));
  assert.match(verdict!.reason, /#394's question card "Layout": #\/p\/2\/t\/394\?e=11/);
  assert.equal(await check({ last_assistant_message: '#394 has a card waiting on you.', prompt_id: 'p1' }, cfg), null);
  // A snapshot from before card links has no cards and checks none.
  writeFileSync(join(dir, 'scheme-refs.json'), JSON.stringify({ scheme: 'Citadel', others: [], minions: {} }));
  assert.equal(await check({ last_assistant_message: '#394 has a card.', prompt_id: 'p2' }, cfg), null);
});

test('a minion\'s view lists its waiting cards with links, and a card posted mid-turn reaches running turns\' snapshots', () => {
  const fake = join(root, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const clock = new FakeClock();
  runner.clock = clock;
  const p = store.createProject('Citadel', null);
  const minion = store.createTicket({ project_id: p.id, title: 'Asker', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const tm = store.createTicket({ project_id: p.id, title: 'Watcher', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const q = runner.emit(minion.id, 'question', { id: 'q1', questions: [{ header: 'Layout', question: 'Tabs?' }] });
  runner.approvals.request(minion.id, 'Bash', { command: 'ls', description: 'List' });
  const approval = store.listEvents(minion.id).find((e) => e.kind === 'approval')!;
  const view = runner.view(store.getTicket(minion.id)!);
  const at = `#/p/${p.id}/t/${minion.number}`;
  assert.deepEqual(view.open_cards.map((c) => [c.kind, c.label, c.href]), [
    ['question', 'Layout', `${at}?e=${q.id}`],
    ['approval', 'Bash: List', `${at}?e=${approval.id}`],
  ]);

  // Another minion's turn is running: a plan posted now lands in its snapshot, with it as `self`.
  const dir = join(root, 'tm-turn');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scheme-refs.json'), '{}');
  (runner as any).turns.set(tm.id, { dir });
  const plan = runner.emit(minion.id, 'plan', { id: 'p1', summary: 'Build it', plan: 'x', status: 'pending' });
  const snap = (): SchemeRefs => JSON.parse(readFileSync(join(dir, 'scheme-refs.json'), 'utf8'));
  const hasPlan = () => snap().cards!.some((c) => c.kind === 'plan' && c.minion === minion.number && c.href === `${at}?e=${plan.id}`);
  assert.equal(snap().self, tm.number);
  assert.ok(hasPlan());
  // A person's answer settles it there too: within 2 s of the last refresh, once the gap has passed (#1562).
  runner.emit(minion.id, 'user_message', { author: 'Cara', text: 'Approved', plan: { planId: 'p1' } });
  assert.ok(hasPlan());
  clock.advance(1_999);
  assert.ok(hasPlan());
  clock.advance(1);
  assert.ok(!hasPlan());
  (runner as any).turns.delete(tm.id);
});

test('a scheme\'s snapshots refresh at most once per 2 s, from one open-cards query however many minions it has (#1562)', () => {
  const fake = join(root, 'claude-1562');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db-1562.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const clock = new FakeClock();
  runner.clock = clock;
  const p = store.createProject('Busy', null);
  const minions = Array.from({ length: 30 }, (_, i) => store.createTicket({ project_id: p.id, title: `M${i}`, permission_mode: 'bypassPermissions', created_by: 'Cara' }));
  // Three of them have a turn running, each with a snapshot.
  const files = minions.slice(0, 3).map((m, i) => {
    const dir = join(root, `turn-1562-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scheme-refs.json'), '{}');
    (runner as any).turns.set(m.id, { dir });
    return join(dir, 'scheme-refs.json');
  });
  let perMinion = 0, perScheme = 0;
  const { openCardsOf, openCards } = store;
  store.openCardsOf = (id) => (perMinion++, openCardsOf.call(store, id));
  store.openCards = (id) => (perScheme++, openCards.call(store, id));
  const cards = (f: string) => (JSON.parse(readFileSync(f, 'utf8')) as SchemeRefs).cards?.length ?? 0;
  // The first card reaches every running turn at once, from one query.
  runner.emit(minions[10].id, 'question', { id: 'a', questions: [{ header: 'A', question: '?' }] });
  assert.deepEqual(files.map(cards), [1, 1, 1]);
  assert.deepEqual([perScheme, perMinion], [1, 0]);
  // Five more within the gap, from minions with no turn running, share one refresh at its end.
  for (let i = 0; i < 5; i++) runner.emit(minions[11 + i].id, 'question', { id: `b${i}`, questions: [{ header: 'B', question: '?' }] });
  assert.deepEqual(files.map(cards), [1, 1, 1]);
  assert.equal(perScheme, 1);
  assert.deepEqual(clock.pending().map((t) => t.in), [2_000]);
  // A running minion's own card reaches its own snapshot at once, gap or not: its reply's link check may read it now.
  clock.advance(1_000);
  runner.emit(minions[1].id, 'question', { id: 'own', questions: [{ header: 'O', question: '?' }] });
  assert.deepEqual(files.map(cards), [1, 7, 1]);
  assert.equal(perScheme, 2);
  assert.deepEqual(clock.pending().map((t) => t.in), [1_000]);
  clock.advance(1_000);
  assert.deepEqual(files.map(cards), [7, 7, 7]);
  assert.deepEqual([perScheme, perMinion], [3, 0]);
  // Past the gap, the next card goes at once again.
  clock.advance(2_000);
  runner.emit(minions[20].id, 'question', { id: 'c', questions: [{ header: 'C', question: '?' }] });
  assert.deepEqual(files.map(cards), [8, 8, 8]);
  assert.deepEqual(clock.pending(), []);
  for (const m of minions.slice(0, 3)) (runner as any).turns.delete(m.id);
});

// Direction words (#412; Cara, 2026-11-09: "minion 6 from transdata said "card above" but the card was
// below"). Transdata #6 asked at 06:13, kept working, and wrote its reply at 06:22: the chat keeps a
// turn's question and plan cards under that turn's words, so the card sat below the reply.
const transdata6 = 'One question is open first: [the card above](#/p/7/t/6?e=349108) asks whose email address goes in the "mailto".';
const held = { minion: 6, kind: 'question', label: 'Crossref mailto', href: '#/p/7/t/6?e=349108', below: true } satisfies CardLink;
const earlier = { minion: 6, kind: 'plan', label: 'Build it', href: '#/p/7/t/6?e=300', below: false } satisfies CardLink;
const wrong = (text: string, list: CardLink[] = [held, earlier]) => misplacedCards(text, list, 6).map((w) => [w.card.href, w.said]);

test('flags a direction word that contradicts where this chat\'s card sits', () => {
  assert.deepEqual(wrong(transdata6), [['#/p/7/t/6?e=349108', 'above']]);
  // The word right after the link counts too.
  assert.deepEqual(wrong('Answer [the card](#/p/7/t/6?e=349108) above.'), [['#/p/7/t/6?e=349108', 'above']]);
  // An earlier turn's card sits above this reply.
  assert.deepEqual(wrong('[The plan card below](#/p/7/t/6?e=300) still waits.'), [['#/p/7/t/6?e=300', 'below']]);
});

test('lets through the right word, no word, other chats\' cards and snapshots without positions', () => {
  for (const ok of [
    transdata6.replace('above', 'below'),
    '[The plan card above](#/p/7/t/6?e=300) still waits.',
    'Answer [the card](#/p/7/t/6?e=349108) when you can.',
    '`[the card above](#/p/7/t/6?e=349108)`',
  ]) assert.deepEqual(wrong(ok), [], ok);
  // Another minion's card: no direction relative to this reply.
  assert.deepEqual(misplacedCards('[#394\'s card above](#/p/7/t/394?e=11)', [{ ...held, minion: 394, href: '#/p/7/t/394?e=11' }], 6), []);
  const { below: _, ...unknown } = held;
  assert.deepEqual(wrong(transdata6, [unknown]), []);
});

test('the link check sends back the Transdata #6 reply, saying the card is below', async () => {
  const dir = join(root, 'turn-412');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scheme-refs.json'), JSON.stringify({ scheme: 'Transdata', others: [], minions: {}, self: 6, cards: [held] } satisfies SchemeRefs));
  const cfg = { cwd: dir, roots: [dir], nudged: join(dir, 'nudged'), refs: join(dir, 'scheme-refs.json') };
  const verdict = await check({ last_assistant_message: transdata6, prompt_id: 'p1' }, cfg);
  assert.equal(verdict?.decision, 'block');
  assert.match(verdict!.reason, /calls question card "Crossref mailto" \(#\/p\/7\/t\/6\?e=349108\) "above", but it sits below this reply/);
  assert.equal(await check({ last_assistant_message: transdata6.replace('above', 'below'), prompt_id: 'p2' }, cfg), null);
});

test('a turn\'s snapshot marks its own cards below until a person writes or the turn ends', () => {
  const fake = join(root, 'claude-412');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db-412.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const p = store.createProject('Transdata', null);
  const minion = store.createTicket({ project_id: p.id, title: 'Citations', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const other = store.createTicket({ project_id: p.id, title: 'Other', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const file = join(root, 'refs-412.json');
  const snap = (t = minion) => {
    (runner as any).writeRefs(file, store.getTicket(t.id)!);
    return (JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs).cards!.map((c) => [c.minion, c.kind, c.below]);
  };
  // Asked mid-turn, then more work: still below the turn's words.
  runner.emit(minion.id, 'question', { id: 'q1', questions: [{ header: 'Crossref mailto', question: 'Whose?' }] });
  runner.emit(minion.id, 'claude', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Testing meanwhile.' }] } });
  assert.deepEqual(snap(), [[minion.number, 'question', true]]);
  // Another minion's snapshot doesn't place it.
  assert.deepEqual(snap(other), [[minion.number, 'question', undefined]]);
  // The turn ended: the next turn's words go under it.
  runner.emit(minion.id, 'claude', { type: 'result', subtype: 'success', is_error: false });
  runner.emit(minion.id, 'plan', { id: 'p1', summary: 'Build it', plan: 'x', status: 'pending' });
  assert.deepEqual(snap(), [[minion.number, 'question', false], [minion.number, 'plan', true]]);
  // A message mid-turn lets go of it too (a person's would answer it; the Taskmaster's leaves it waiting).
  runner.emit(minion.id, 'user_message', { author: 'Taskmaster', text: 'Also check PubMed' });
  assert.deepEqual(snap(), [[minion.number, 'question', false], [minion.number, 'plan', false]]);
});

// Links to answered cards (#531; Cara, 2026-11-11: "This is like the third time you told me something was
// waiting on me that wasnt, what is up with that?"). The Taskmaster carried card links forward from earlier
// replies: #520's go card she had picked, #523's root step she had answered.
const answered = { minion: 523, kind: 'question', label: 'Root step', href: '#/p/2/t/523?e=50', how: 'answered by Cara at 2:31am: Done, I ran it' } satisfies SettledCard;
const flagged = (text: string) => staleCards(text, [answered]).map((c) => c.href);

test('flags a link to an answered card that the reply still calls waiting', () => {
  for (const bad of [
    'Still waiting on you: the root step on [#523\'s card](#/p/2/t/523?e=50).',
    'Waiting on you:\n\n- #520 is green.\n- The root step on [#523\'s card](#/p/2/t/523?e=50)',
    '**Needs you**\n1. [#523\'s card](#/p/2/t/523?e=50): the root step',
    'Tap Done on [#523\'s card](#/p/2/t/523?e=50) when you have run it.',
  ]) assert.deepEqual(flagged(bad), ['#/p/2/t/523?e=50'], bad);
});

test('lets through open cards, links that say the card is answered, neutral mentions and code', () => {
  for (const ok of [
    'You answered [the card](#/p/2/t/523?e=50) at 2:31, so nothing waits on you.',
    'Waiting on you: [#394\'s card](#/p/2/t/394?e=11).',
    'Per [#523\'s card](#/p/2/t/523?e=50), I ran the root step.',
    'Waiting on you: nothing.\n\nI ran the root step from [#523\'s card](#/p/2/t/523?e=50).',
    'Already answered:\n- [#523\'s card](#/p/2/t/523?e=50), still waiting on CI meanwhile',
    '`Waiting on you: [#523\'s card](#/p/2/t/523?e=50)`',
    'No need to answer [#523\'s card](#/p/2/t/523?e=50) any more.',
    'CI is pending.\n\n- Reference: [#523\'s card](#/p/2/t/523?e=50)',
  ]) assert.deepEqual(flagged(ok), [], ok);
  assert.deepEqual(staleCards('Waiting on you: [#523\'s card](#/p/2/t/523?e=50)', []), []);
});

test('the link check sends back a link to an answered card once, saying what happened to it', async () => {
  const dir = join(root, 'turn-531');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'scheme-refs.json'), JSON.stringify({ scheme: 'Citadel', others: [], minions: {}, self: null, cards, settled: [answered] } satisfies SchemeRefs));
  const cfg = { cwd: dir, roots: [dir], nudged: join(dir, 'nudged'), refs: join(dir, 'scheme-refs.json') };
  const text = 'Waiting on you: the root step on [#523\'s card](#/p/2/t/523?e=50).';
  const verdict = await check({ last_assistant_message: text, prompt_id: 'p1' }, cfg);
  assert.equal(verdict?.decision, 'block');
  assert.ok(verdict!.reason.startsWith(SENT_BACK));
  assert.ok(verdict!.reason.includes('#523\'s question card "Root step" (#/p/2/t/523?e=50): answered by Cara at 2:31am: Done, I ran it'), verdict!.reason);
  // The second try goes through as it is.
  assert.equal(await check({ last_assistant_message: text, prompt_id: 'p1' }, cfg), null);
  // A link to an open card in the same words passes.
  assert.equal(await check({ last_assistant_message: 'Waiting on you: [#394\'s card](#/p/2/t/394?e=11).', prompt_id: 'p2' }, cfg), null);
});

test('a turn\'s snapshot lists the scheme\'s recently settled cards with who settled them, when and how', () => {
  const fake = join(root, 'claude-531');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db-531.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const p = store.createProject('Citadel', null);
  const tm = store.createTicket({ project_id: p.id, title: 'Watcher', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const a = store.createTicket({ project_id: p.id, title: 'Asker', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const b = store.createTicket({ project_id: p.id, title: 'Gone', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const ask = (t: typeof a, id: string, header: string) => runner.emit(t.id, 'question', { id, questions: [{ header, question: '?' }] });
  const clicked = ask(a, 'q1', 'Root step');
  const click = runner.emit(a.id, 'user_message', { author: 'Cara', text: 'My answers…', answer: { questionId: 'q1', answers: [{ selected: ['Done, I ran it'] }] } });
  const open = ask(a, 'q2', 'Layout');
  runner.emit(a.id, 'user_message', { author: 'Taskmaster', text: 'Any news?' });
  // Another scheme's Taskmaster's held mail answers nothing (#610).
  runner.emit(a.id, 'user_message', { author: 'Taskmaster of Peek', text: 'fyi', mail: true, cold: true, from: 99 });
  const plan = runner.emit(a.id, 'plan', { id: 'p1', summary: 'Build it', plan: 'x', status: 'approved', by: 'Josh', at: 1_000 });
  const typed = ask(b, 'q3', 'Name');
  const reply = runner.emit(b.id, 'user_message', { author: 'Josh', text: 'Call it Keep', answer: { questionId: 'q3', answers: [{ other: 'Call it Keep' }] } });
  const dropped = ask(b, 'q4', 'Colour');
  store.updateTicket(b.id, { status: 'closed' });
  runner.approvals.request(a.id, 'Bash', { command: 'ls', description: 'List' });
  const approval = store.listEvents(a.id).find((e) => e.kind === 'approval')!;
  runner.approvals.decide(a.id, JSON.parse(approval.data).id, true, 'Cara');
  const allowed = store.listEvents(a.id).find((e) => e.kind === 'approval_result')!;

  const file = join(root, 'refs-531.json');
  (runner as any).writeRefs(file, store.getTicket(tm.id)!);
  const snap = JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs;
  const at = (t: typeof a, e: { id: number }) => `#/p/${p.id}/t/${t.number}?e=${e.id}`;
  assert.deepEqual(snap.cards!.map((c) => c.href), [at(a, open)]);
  assert.deepEqual(snap.settled!.map((c) => [c.href, c.kind, c.label, c.how]), [
    [at(a, clicked), 'question', 'Root step', `answered by Cara at ${clockTime(click.created_at)}: Done, I ran it`],
    [at(a, plan), 'plan', 'Build it', `approved by Josh at ${clockTime(1_000)}`],
    [at(b, typed), 'question', 'Name', `answered by Josh at ${clockTime(reply.created_at)}: Call it Keep`],
    [at(b, dropped), 'question', 'Colour', `#${b.number} was dismissed`],
    [at(a, approval), 'approval', 'Bash: List', `allowed by Cara at ${clockTime(allowed.created_at)}`],
  ]);
});

test('a later snapshot sees replies and results that came after the last one, and still not clicks on other cards (#622)', () => {
  const fake = join(root, 'claude-622');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db-622.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const p = store.createProject('Citadel', null);
  const tm = store.createTicket({ project_id: p.id, title: 'Watcher', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const a = store.createTicket({ project_id: p.id, title: 'Asker', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const q1 = runner.emit(a.id, 'question', { id: 'q1', questions: [{ header: 'One', question: '?' }] });
  const q2 = runner.emit(a.id, 'question', { id: 'q2', questions: [{ header: 'Two', question: '?' }] });
  runner.approvals.request(a.id, 'Bash', { command: 'ls', description: 'List' });
  const approval = store.listEvents(a.id).find((e) => e.kind === 'approval')!;
  const file = join(root, 'refs-622.json');
  const settled = () => {
    (runner as any).writeRefs(file, store.getTicket(tm.id)!);
    return Object.fromEntries((JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs).settled!.map((c) => [c.label, c.how]));
  };
  assert.deepEqual(settled(), {});
  // A click on q2 answers q2 only; a relayed message answers nothing.
  const click = runner.emit(a.id, 'user_message', { author: 'Cara', text: 'My answers…', answer: { questionId: 'q2', answers: [{ selected: ['B'] }] } });
  runner.emit(a.id, 'user_message', { author: 'Taskmaster', text: 'relay', from: 1 });
  assert.deepEqual(settled(), { Two: `answered by Cara at ${clockTime(click.created_at)}: B` });
  const typed = runner.emit(a.id, 'user_message', { author: 'Josh', text: 'Go with one', answer: { questionId: 'q1', answers: [{ other: 'Go with one' }] } });
  runner.approvals.decide(a.id, JSON.parse(approval.data).id, true, 'Cara');
  const allowed = store.listEvents(a.id).find((e) => e.kind === 'approval_result')!;
  // Josh's message came after the approval card too, but its result says how it ended.
  assert.deepEqual(settled(), {
    One: `answered by Josh at ${clockTime(typed.created_at)}: Go with one`,
    Two: `answered by Cara at ${clockTime(click.created_at)}: B`,
    'Bash: List': `allowed by Cara at ${clockTime(allowed.created_at)}`,
  });
  // A second reply doesn't replace the first.
  runner.emit(a.id, 'user_message', { author: 'Cara', text: 'Actually two' });
  assert.equal(settled().One, `answered by Josh at ${clockTime(typed.created_at)}: Go with one`);
  assert.ok(q1.id < q2.id);
});

test('cardWhat: a merge go, a tripwire approval, or the card\'s own kind (#575)', () => {
  assert.equal(cardWhat('question', { questions: [], kind: 'merge' }), 'ship');
  assert.equal(cardWhat('approval', { tool: 'Bash', merge: { repo: 'o/r' } }), 'ship');
  assert.equal(cardWhat('question', { questions: [], kind: 'merge', into: 5 }), 'merge', "a feeder's go card merges into its build");
  assert.equal(cardWhat('approval', { tool: 'Bash', merge: { repo: 'o/r', pr: { base: 'build/3' } } }), 'merge', 'a PR into a build merges into it');
  assert.equal(cardWhat('approval', { tool: 'Bash', merge: { repo: 'o/r', pr: { base: 'main' } } }), 'ship');
  assert.equal(cardWhat('approval', { tool: 'Bash', tripwire: { reason: 'x' } }), 'tripwire');
  assert.equal(cardWhat('approval', { tool: 'Bash' }), 'approval');
  assert.equal(cardWhat('question', { questions: [] }), 'question');
  assert.equal(cardWhat('plan', { summary: 's' }), 'plan');
});

test('a choices card settled by its page\'s Send reads as picks sent (#804)', () => {
  assert.equal(settledHow('question', { doc: { path: '/w/t.html', title: 'T' }, settled: { at: 1, by: 'Cara', sent: true } }, null, null, null, () => '2:31am'), 'picks sent by Cara at 2:31am');
});

test('an unrelated message does not settle a card; its own answer does, and is the one reported (#812)', () => {
  const fake = join(root, 'claude-812');
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
  const store = new Store(join(root, 'db-812.sqlite'));
  store.typedHandlesUpTo = 0;
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const p = store.createProject('Citadel', null);
  const tm = store.createTicket({ project_id: p.id, title: 'Watcher', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const a = store.createTicket({ project_id: p.id, title: 'Asker', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const card = runner.emit(a.id, 'question', { id: 'q1', questions: [{ header: 'Policy', question: '?' }] });
  runner.emit(a.id, 'user_message', { author: 'Cara', text: 'I just heard about code mode…' });
  const file = join(root, 'refs-812.json');
  const snap = () => {
    (runner as any).writeRefs(file, store.getTicket(tm.id)!);
    return JSON.parse(readFileSync(file, 'utf8')) as SchemeRefs;
  };
  assert.equal(snap().cards!.length, 1, 'still waiting after an unrelated message');
  assert.deepEqual(snap().settled, []);
  assert.deepEqual(store.openCardsOf(a.id).map((e) => e.id), [card.id]);
  const click = runner.emit(a.id, 'user_message', { author: 'Cara', text: 'My answers…', answer: { questionId: 'q1', answers: [{ selected: ['Yes'] }] } });
  assert.equal(snap().cards!.length, 0);
  assert.equal(snap().settled![0].how, `answered by Cara at ${clockTime(click.created_at)}: Yes`);
});

test('a secret card is a secret card in the minions list and the tools\' waiting lines, naming only the secret', () => {
  const data = { id: 'x', questions: [], secret: { name: 'BRAVE_SEARCH_KEY', scope: 'scheme' } };
  assert.equal(cardWhat('question', data), 'secret');
  const c = { minion: 3, kind: 'question' as const, what: cardWhat('question', data), label: cardLabel('question', data), href: '#/p/2/t/3?e=9' };
  assert.equal(cardText(c), 'secret card "a secret to save as BRAVE_SEARCH_KEY": [open it](#/p/2/t/3?e=9)');
});
