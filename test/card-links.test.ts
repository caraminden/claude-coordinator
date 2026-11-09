// Card links (#400): every mention of a card links to it (Cara, 2026-11-08: "I thought I asked you to make
// any reference to a card come with a link to that card, but I just was asked about a card in transdata
// and it wasn't a link"). The tools hand out the link; the link check sends a reply back once without it.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { cardHref, cardLabel, unlinkedCards, type CardLink } from '../src/card-links.ts';
import { Store } from '../src/db.ts';
import { check, SENT_BACK } from '../src/link-check.ts';
import { Runner } from '../src/runner.ts';
import type { SchemeRefs } from '../src/scheme-refs.ts';

const root = mkdtempSync(join(tmpdir(), 'card-links-'));
after(() => rmSync(root, { recursive: true, force: true }));

const card = (minion: number | null, event: number, kind: CardLink['kind'] = 'question'): CardLink =>
  ({ minion, kind, label: 'Layout', href: `${minion == null ? '#/p/2' : `#/p/2/t/${minion}`}?e=${event}` });
const cards = [card(394, 11), card(400, 22, 'plan'), card(null, 33)];
const missing = (text: string, self: number | null = 400) => unlinkedCards(text, cards, self).map((g) => g.map((c) => c.href));

test('cardHref opens a minion\'s or the Taskmaster\'s chat at the card (core.js jumpHref)', () => {
  assert.equal(cardHref({ project_id: 2, kind: 'ticket', number: 394, id: 9 }, 11), '#/p/2/t/394?e=11');
  assert.equal(cardHref({ project_id: 2, kind: 'coordinator', number: null, id: 1 }, 33), '#/p/2?e=33');
  assert.equal(cardLabel('plan', { summary: 'Build it this way' }), 'Build it this way');
  assert.equal(cardLabel('question', { questions: [{ header: 'Layout' }, { question: 'Which?' }] }), 'Layout, Which?');
  assert.equal(cardLabel('approval', { tool: 'Bash', input: { description: 'Restart' } }), 'Bash: Restart');
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
  const runner = new Runner(store, () => {}, () => ({}), fake);
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
  const snap: SchemeRefs = JSON.parse(readFileSync(join(dir, 'scheme-refs.json'), 'utf8'));
  (runner as any).turns.delete(tm.id);
  assert.equal(snap.self, tm.number);
  assert.ok(snap.cards!.some((c) => c.kind === 'plan' && c.minion === minion.number && c.href === `${at}?e=${plan.id}`));
});
