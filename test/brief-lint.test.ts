import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { briefWarning, namedFiles } from '../src/brief-lint.ts';
import { agentToken, bootServer } from './helpers.ts';

// The check on new briefs (#1108, citadel:briefing): a warning, never a refusal, when an agent's brief
// has no quoted words from a person or no "Done when".
const complete = 'Goal: a retry button.\n\nJosh, 2026-11-19: "Go on the retry button"\n\nDone when\n- A failed upload shows Retry.\n\nAlready shipped on this: nothing found (2026-11-19).\nLeave alone: the upload queue.';

test('a complete brief gets no warning; each missing part is named', () => {
  assert.equal(briefWarning(complete), null);
  assert.equal(briefWarning('Josh:\n> go on the retry button\nDone-when: Retry shows. Already shipped on this: nothing found. Leave alone: x.'), null, 'a > quote and done-when count');
  assert.equal(briefWarning('Cara said “make the bar the scheme total”. Done when the bar reads it. Already shipped on this: none. Leave alone: x.'), null, 'curly quotes count');

  const noQuote = briefWarning('Add a retry button. Done when a failed upload shows Retry.');
  assert.match(noQuote!, /no quoted words from a person/);
  assert.doesNotMatch(noQuote!, /Done when"/);
  const noDone = briefWarning('Josh, 2026-11-19: "Go on the retry button". Add it.');
  assert.match(noDone!, /no "Done when"/);
  assert.doesNotMatch(noDone!, /quoted words/);
  assert.match(briefWarning('Add a retry button with a "Retry" label.')!, /quoted words from a person.*and no "Done when"/, 'a one-word label is not a quote');
  assert.match(noDone!, /never|still created/, 'it says the minion was made');
});

const root = mkdtempSync(join(tmpdir(), 'brief-lint-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('the already-shipped and leave-alone parts are each named when missing', () => {
  const w = briefWarning('Josh, 2026-11-19: "Go on the retry button". Done when Retry shows.')!;
  assert.match(w, /no "Already shipped on this".*no "Leave alone"/);
  assert.doesNotMatch(briefWarning(`${complete}`.replace('Leave alone', 'x'))!, /Already shipped/);
});

test('a pointer brief is judged with the handoff it names', () => {
  const shared = join(root, 'shared', 'project');
  mkdirSync(join(shared, 'handoffs'), { recursive: true });
  const file = join(shared, 'handoffs', 'handoff-retry.md');
  writeFileSync(file, complete);
  const pointer = `Start from the handoff \`${file}\`. Ships to main.`;
  assert.match(briefWarning(pointer)!, /quoted words/, 'the message alone has neither');
  assert.equal(briefWarning(`${pointer}\n${namedFiles(pointer, shared)}`), null);
  assert.equal(namedFiles(`See ${shared}/handoffs/missing.md and /etc/passwd.md`, shared), '', 'missing files and paths outside the folder add nothing');
  assert.equal(namedFiles(`${shared}/../../../etc/x.md`, shared), '');
  writeFileSync(join(root, 'outside.md'), complete);
  symlinkSync(join(root, 'outside.md'), join(shared, 'handoffs', 'link.md'));
  assert.equal(namedFiles(`${shared}/handoffs/link.md`, shared), '', 'a link out of the folder adds nothing');
  writeFileSync(join(shared, 'handoffs', 'huge.md'), `${complete}\n${'x'.repeat(200_001)}`);
  assert.equal(namedFiles(`${shared}/handoffs/huge.md`, shared), '', 'an oversized file adds nothing');
});

test('create_ticket from the Taskmaster gets the warning in its notes; a person typing their own ask does not', async () => {
  const s = await bootServer();
  try {
    const { data: p } = await s.call('/api/projects', { name: 'Scheme' });
    const tm = (await s.call(`/api/projects/${p.id}`)).data.coordinator;
    const asTaskmaster = (body: object) => fetch(`${s.base}/api/projects/${p.id}/tickets`, {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken(s.data, tm.id)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', effort: 'medium', properties: { type: 'feature' }, ...body }),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));

    const bare = await asTaskmaster({ title: 'Retry', message: 'Add a retry button to failed uploads.' });
    assert.equal(bare.status, 201, JSON.stringify(bare.data));
    assert.equal(bare.data.notes.filter((n: string) => n.startsWith('Brief check')).length, 1, bare.data.notes.join('\n'));
    assert.match(bare.data.notes.join('\n'), /no quoted words from a person .* and no "Done when"/);

    const good = await asTaskmaster({ title: 'Retry two', message: complete });
    assert.equal(good.status, 201);
    assert.deepEqual(good.data.notes.filter((n: string) => n.startsWith('Brief check')), []);

    // A handoff in the scheme's shared folder, named by a pointer brief, counts as the brief.
    const shared = join(s.data, 'projects', String(p.id), 'shared', 'project', 'handoffs');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'handoff-retry.md'), complete);
    const pointer = await asTaskmaster({ title: 'Retry three', message: `Start from the handoff ${join(shared, 'handoff-retry.md')}.` });
    assert.deepEqual(pointer.data.notes.filter((n: string) => n.startsWith('Brief check')), [], pointer.data.notes.join('\n'));

    const own = await s.call(`/api/projects/${p.id}/tickets`, { title: 'Mine', message: 'add a retry button' });
    assert.equal(own.status, 201);
    assert.deepEqual((own.data.notes ?? []).filter((n: string) => n.startsWith('Brief check')), [], 'a person typing their own ask is already their words');
  } finally {
    await s.stop();
  }
});
