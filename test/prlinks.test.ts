import { test } from 'node:test';
import assert from 'node:assert/strict';
import { owners, repoSlug } from '../src/prlinks.ts';
import type { Ticket } from '../src/db.ts';

test('repoSlug reads GitHub https and ssh URLs', () => {
  assert.equal(repoSlug('https://github.com/caraminden/claude-coordinator'), 'caraminden/claude-coordinator');
  assert.equal(repoSlug('https://github.com/CaraMinden/gamedevtest.git'), 'caraminden/gamedevtest');
  assert.equal(repoSlug('git@github.com:o/r.git'), 'o/r');
  for (const s of [null, '', 'https://gitlab.com/o/r', 'https://github.com/o']) assert.equal(repoSlug(s), null, String(s));
});

test('a PR belongs to the minion whose branch is its head', () => {
  const t = (id: number, number: number, branch: string | null, kind = 'ticket') => ({ id, number, branch, kind, title: `t${id}` }) as unknown as Ticket;
  const tickets = [t(162, 68, 'ticket/68-laptop'), t(1, 0, 'main', 'coordinator'), t(3, 4, null)];
  assert.deepEqual(owners([{ number: 186, headRefName: 'ticket/68-laptop' }, { number: 9, headRefName: 'main' }, { number: 2, headRefName: 'other' }], tickets),
    { 186: { id: 162, number: 68, title: 't162' } });
});

test('a PR from another ticket/<N>- branch belongs to minion N of the scheme', () => {
  const t = (id: number, number: number, branch: string | null) => ({ id, number, branch, kind: 'ticket', title: `t${id}` }) as unknown as Ticket;
  const tickets = [t(193, 93, 'ticket/93-s9-measured'), t(164, 64, 'ticket/64-port-the-mod')];
  assert.deepEqual(owners([{ number: 217, headRefName: 'ticket/93-s11-targets-doc' }, { number: 195, headRefName: 'ticket/64-drop-fold-check' }, { number: 3, headRefName: 'ticket/7-nobody' }, { number: 4, headRefName: 'claude/project-thread-x' }], tickets),
    { 217: { id: 193, number: 93, title: 't193' }, 195: { id: 164, number: 64, title: 't164' } });
});
