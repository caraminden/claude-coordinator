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
