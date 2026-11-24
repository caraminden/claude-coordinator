// The list chip's waits (ADR 0021 step 7, #1387): timed rows show a Pacific time, a wait on another minion its number,
// anything else "event"; dropped rows stay 7 days, greyed; a Taskmaster's own rows are its own.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { DROPPED_SHOWN_MS, firstLine, waitsFor } from '../src/waits-readout.ts';
import { testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'waits-readout-'));
after(() => rmSync(root, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 14, 20, 0); // 12:00 PST

test('chips: a time, another minion, an event; dropped rows age out after 7 days', () => {
  const store = new Store(join(root, 'a.db'));
  const p = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const a = mk(),
    b = mk();
  const add = (d: any) => store.addDelivery({ project_id: p.id, kind: 'k', to_kind: 'minion', to_id: a.id, set_by: 'minion:1', when_kind: 'at', ...d }, NOW);
  add({ when_arg: NOW + 14 * 3_600_000, due: NOW + 14 * 3_600_000, payload: { note: 'check' } }); // 02:00 next day PST
  add({ when_kind: 'live', when_arg: { ticket: b.id } });
  add({ when_kind: 'ci', when_arg: { sha: 'abc' } });
  const old = add({ when_kind: 'ci', state: 'dropped', reason: 'cancelled' });
  store.updateDelivery(old.id, { reason: 'cancelled' }, undefined, NOW - DROPPED_SHOWN_MS - 1);
  const gone = add({ when_kind: 'ci', state: 'dropped', reason: 'minion dismissed' });
  const rows = waitsFor(store, store.getTicket(a.id)!, () => [{ kind: 'chain', chip: '⇢ #9', what: 'x', set_by: 'c', since: null }], NOW);
  assert.deepEqual(
    rows.slice(1).map((r) => r.chip),
    [`⇢ #${b.number}`, '⇢ CI', '⇢ #9', '⇢ CI'],
  );
  assert.match(rows[0].chip, /^⏱ (\w{3} )?\d\d:\d\d$/);
  assert.equal(rows[2].headline, 'Wakes when CI finishes', 'a kind with no words of its own never shows its internal name');
  assert.ok(rows[0].cancellable && !rows[3].cancellable, 'old-key waits have no Cancel');
  assert.equal(rows.at(-1)!.id, gone.id);
  assert.equal(rows.at(-1)!.reason, 'minion dismissed');
});

test('a chain row (its held brief) shows its leader and has no Cancel: Start now or dismiss instead', () => {
  const store = new Store(join(root, 'c.db'));
  const p = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const a = mk(),
    lead = mk();
  store.addDelivery({ project_id: p.id, kind: 'chain', to_kind: 'minion', to_id: a.id, set_by: 'Taskmaster', when_kind: 'merged', when_arg: { after: lead.id }, payload: { message: 'go', reason: 'its work' } }, NOW);
  const [row] = waitsFor(store, store.getTicket(a.id)!, () => [], NOW);
  assert.deepEqual([row.chip, row.what, row.cancellable], [`⇢ #${lead.number}`, 'its work', false]);
});

// #1512 (Cara, 2026-11-21: "a headline single sentence description, and then clicking it opens a few sentence summary";
// she picked take A, Citadel builds it from the wait): a relay names its sender, not "event", and says what and when.
test("a relay shows its sender's number and a headline; its words become the second line and the summary", () => {
  const store = new Store(join(root, 'r.db'));
  const p = store.createProject('P', null);
  const mk = () => store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const to = mk(),
    from = mk();
  const text = "#824 here: main's windows-check is green again. crates/app/src/run/tests.rs now uses #808's CaptureError::Unsupported. Rebase onto main and hand off again.";
  store.addDelivery({ project_id: p.id, kind: 'relay', to_kind: 'minion', to_id: to.id, set_by: `minion:${from.id}`, when_kind: 'live', when_arg: 'fa4fb3f6d0000000000000000000000000000000', payload: { ticket: from.id, to: { minion: to.id, number: to.number }, text } }, NOW - 3_600_000);
  store.addDelivery({ project_id: p.id, kind: 'wake_at', to_kind: 'minion', to_id: to.id, set_by: 'minion:1', when_kind: 'at', when_arg: NOW + 1_800_000, due: NOW + 1_800_000, payload: { note: 'Check the run.', setBy: 'Taskmaster' } }, NOW);
  const [relay, wake] = waitsFor(store, store.getTicket(to.id)!, () => [], NOW);
  assert.equal(relay.chip, `⇢ #${from.number}`);
  assert.equal(relay.headline, `Note from #${from.number} once its change is live`);
  assert.equal(relay.line, "Main's windows-check is green again.");
  assert.equal(relay.text, text);
  assert.deepEqual(relay.facts, [`Set by #${from.number} at 11:00 PST`, 'waits for fa4fb3f to go live']);
  assert.deepEqual(relay.link, { project: p.id, number: from.number });
  assert.equal(wake.headline, 'Wakes itself at 12:30, set by the Taskmaster');
  assert.deepEqual(wake.facts, ['Set by the Taskmaster at 12:00 PST', 'due 12:30']);
});

test('the second line: a first sentence, cut at a colon or a word when long; a line with no sentence still reads', () => {
  assert.equal(firstLine('#823 is live (3325dcea). Your seam can rebase now.'), '#823 is live (3325dcea).');
  assert.equal(firstLine("Check whether main's windows-check is fixed: git fetch, then git grep UnsupportedWindows origin/main -- crates/app must come back empty."), "Check whether main's windows-check is fixed");
  // A colon too early would leave a stub ("Re-ship #832"), so that one is cut at a word.
  assert.equal(firstLine("Re-ship #832: check main's crates/app/src/run/tests.rs no longer names CaptureError::UnsupportedWindows (the #824 fix is live), then ship again."), "Re-ship #832: check main's crates/app/src/run/tests.rs no longer names CaptureError::UnsupportedWindows (the…");
  const long = firstLine(`${'word '.repeat(40)}end.`);
  assert.ok(long.endsWith('…') && long.length <= 111 && !long.includes('  '), long);
  assert.equal(firstLine('its work'), 'Its work');
  assert.equal(firstLine('   '), '');
});
