import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CODEX_MODELS } from '../src/codex.ts';
import { Store } from '../src/db.ts';
import { reviewsSinceShip, reviewRefusal } from '../src/review-gate.ts';
import { addReview } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'review-gate-'));
const store = new Store(join(root, 'test.db'));
after(() => {
  store.db.close();
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});
const scheme = store.createProject('Elsewhere', null);
const minion = () => store.createTicket({ project_id: scheme.id, title: 'M', permission_mode: 'default', created_by: 'Josh' });
let n = 0;
const call = (ticket: number, name: string, input: object, result: object | null, model?: string) => {
  const id = `toolu_${++n}`;
  store.addEvent(ticket, 'claude', { type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'tool_use', id, name, input }] } });
  if (result) store.addEvent(ticket, 'claude', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...result }] } });
};

test('a ship with no reviewer is refused in any scheme, whatever else ran; a review that came back lets it through', () => {
  const t = minion();
  assert.match(reviewRefusal(store, t, []) ?? '', /^Not handed off: no reviewer has read this change/);
  call(t.id, 'Skill', { skill: 'citadel:self-review' }, {});
  call(t.id, 'Agent', { subagent_type: 'Explore', prompt: 'read kit/agents/reviewer.md' }, {});
  call(t.id, 'Agent', { subagent_type: 'citadel:reviewer' }, null);
  call(t.id, 'Agent', { subagent_type: 'citadel:reviewer' }, { is_error: true });
  call(t.id, 'Agent', { subagent_type: 'citadel:reviewer', run_in_background: true }, {});
  assert.ok(reviewRefusal(store, t, [], true), "a person's go is no review");
  assert.ok(reviewRefusal(store, t, []), 'the skill alone, another Grunt, an unfinished review, a failed one and one only launched are no review');
  assert.ok(reviewRefusal(store, t, ['--into', 'build/2']), "a feeder's merge too");
  assert.ok(reviewRefusal(store, t, ['--build']), "a build's ship too");
  assert.equal(reviewRefusal(store, t, ['--into', 'build/2', '--full']), null, "a build's take-in of main");
  addReview(store, t.id);
  assert.equal(reviewRefusal(store, t, []), null);
  assert.ok(reviewRefusal(store, minion(), []), "another minion's review doesn't count");
});

test('a ship or a merge into a build uses the review up; a failed ship and other notes do not', () => {
  const t = minion();
  addReview(store, t.id);
  store.addEvent(t.id, 'note', { text: 'Your ship failed: main moved. Risk high.' });
  assert.ok(reviewsSinceShip(store, t.id).done);
  for (const text of ['Shipped abc1234: x. Risk low: docs. Live now.', 'Merged into build/2: x. Risk medium: y. ']) {
    store.addEvent(t.id, 'note', { text });
    assert.ok(!reviewsSinceShip(store, t.id).done, text);
    addReview(store, t.id, `toolu_r${++n}`);
    assert.ok(reviewsSinceShip(store, t.id).done);
  }
});

test('on a Codex turn, which has no Grunts, citadel-codex-review is the review; its --check is not, nor a Claude turn running it', () => {
  const codex = CODEX_MODELS[0][0];
  const t = minion();
  call(t.id, 'Bash', { command: 'citadel-codex-review --check' }, {}, codex);
  call(t.id, 'Bash', { command: 'citadel-codex-review < b.md' }, { is_error: true }, codex);
  call(t.id, 'Bash', { command: 'citadel-codex-review < b.md' }, {}, 'claude-opus-5-5');
  assert.ok(reviewRefusal(store, t, []));
  assert.equal(reviewRefusal(store, t, [], true), null, "its review can't run, so a person's go ships it");
  call(t.id, 'Bash', { command: 'citadel-codex-review < b.md' }, {}, codex);
  assert.equal(reviewRefusal(store, t, []), null);
});

test("a scheme whose people switched its pre-ship review off is not refused: each ship waits for a person's go there", () => {
  const t = minion();
  store.reviews.ensureBuiltIns(scheme.id);
  store.reviews.save(scheme.id, 'pre-ship-review', { enabled: false }, 'Josh', 'off');
  assert.equal(reviewRefusal(store, t, []), null);
});
