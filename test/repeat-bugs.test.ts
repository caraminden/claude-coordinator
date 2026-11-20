import assert from 'node:assert/strict';
import { type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BY_TYPE, nextStep, tierLabel } from '../public/model-table.js';
import { Store } from '../src/db.ts';
import { flagBlock, ownBrief, repeats, steppedTier, termCounts, type BugBrief, type EarlierBug } from '../src/repeat-bugs.ts';
import { bootServer, stopProcs } from './helpers.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
// Everyday bug briefs, so the words of a scheme's usual work are common and only a fix's own words are rare.
const FILLER = ['The settings page button is misaligned on phone widths', 'Chat scroll jumps when a new message arrives', 'The card check stalls after a turn ends',
  'Login page shows the wrong error on a bad password', 'The minions list sorts in the wrong order', 'Images in the chat fail to load on phone']
  .flatMap((t, i) => [0, 1, 2, 3, 4].map((k) => ({ number: 100 + i * 10 + k, title: t, brief: `${t}. Fix the bug and test it on the page.`, at: NOW - 20 * 86_400_000 })));
const bug = (number: number, title: string, brief: string, hoursAgo: number, files: string[] = []): EarlierBug => ({ number, title, brief, at: NOW - hoursAgo * HOUR, files, subjects: files.length ? [`#${number}: ${title}`] : [] });
const match = (now: BugBrief, earlier: EarlierBug[], hubs: string[] = []) => repeats(now, earlier, { df: termCounts([...FILLER, ...earlier, now]), hubs: new Set(hubs) }).map((m) => m.number);

// The Peek Auras chain (#493, #494, #495 then #535): the same aura id and "supercharged slam" across every brief.
const slamA = bug(493, 'Supercharged Slam glow missing', 'The Supercharged Slam aura bg3cYVmFZbrQ shows no glow when it procs.', 200, ['src/auras/glow.ts']);
const slamB = bug(495, 'Supercharged Slam still not glowing', 'Supercharged Slam (bg3cYVmFZbrQ) still has no glow after the last fix.', 100, ['src/auras/glow.ts']);
const slamNow = { number: 0, title: 'Supercharged Slam glow broken again', brief: 'The glow on Supercharged Slam bg3cYVmFZbrQ is gone again.', at: NOW };

test('a third fix for the same aura flags both earlier minions', () => {
  assert.deepEqual(match(slamNow, [slamA, slamB, { ...FILLER[0], files: [], subjects: [] }]), [493, 495]);
});

test('an unrelated bug, or one earlier match alone, does not flag', () => {
  assert.deepEqual(match({ number: 0, title: 'Phone keyboard covers the reply box', brief: 'On Android the keyboard hides the reply box.', at: NOW }, [slamA, slamB]), []);
  assert.deepEqual(match(slamNow, [slamA]), [], 'one earlier minion is not a chain');
});

test('a sibling started within the hour of the new one is not an earlier fix', () => {
  const sibling = { ...slamB, at: NOW - HOUR / 2 };
  assert.deepEqual(match(slamNow, [slamA, sibling]), []);
});

test('a cited minion and a shared file count, unless the file is a hub every minion changes', () => {
  const a = bug(40, 'Deploy watch misses a restart', 'The watcher never sees the restart.', 50, ['src/deploy-probe.ts']);
  const b = bug(41, 'Restart notice never shows', 'Nobody hears the server came back.', 30, ['src/deploy-probe.ts']);
  const now = { number: 0, title: 'Deploy notice lost again', brief: 'Earlier fixes #40 and #41 didn\'t hold: src/deploy-probe.ts still drops it.', at: NOW };
  assert.deepEqual(match(now, [a, b]), [40, 41]);
  assert.deepEqual(match(now, [a, b], ['src/deploy-probe.ts']), [], 'a hub file is no evidence');
  const elsewhere = { ...now, brief: 'Like PR #40 and Citadel #41, src/deploy-probe.ts still drops it.' };
  assert.deepEqual(match(elsewhere, [a, b]), [], 'a PR or another scheme\'s #N is not a citation');
});

test('the block lists each earlier minion, what it shipped, and says diagnose first', () => {
  const [a, b] = repeats(slamNow, [slamA, { ...slamB, files: [], subjects: [] }], { df: termCounts([...FILLER, slamA, slamB, slamNow]), hubs: new Set() });
  const block = flagBlock([a, b]);
  assert.match(block, /^\*\*Third fix: diagnose first\.\*\* 2 bug minions in the last 14 days/);
  assert.match(block, /- #493 "Supercharged Slam glow missing" \(same words: [^)]*bg3cyvmfzbrq[^)]*\)\. What it shipped: "#493: Supercharged Slam glow missing"\./);
  assert.match(block, /- #495 .*Nothing shipped from it yet\./);
  assert.match(block, /run `citadel:diagnosing-bugs`/);
  assert.equal(ownBrief(`${block}\n\n---\n\nThe real ask.`), 'The real ask.', 'a later check reads the brief, not the block');
});

test('the step-up applies only to the table\'s own pick', () => {
  const table = BY_TYPE.bug;
  assert.deepEqual(steppedTier(table, table, true), nextStep(table.model, table.effort, true));
  assert.equal(steppedTier({ model: 'claude-opus-5-5', effort: 'high' }, table, true), null, 'a tier picked by hand stays');
});

const root = mkdtempSync(join(tmpdir(), 'repeat-bugs-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  rmSync(root, { recursive: true, force: true });
});

test('a third bug minion in a plain scheme starts flagged, one tier up', async () => {
  const srv = await bootServer({ root });
  procs.push(srv.proc);
  const call = async (path: string, body?: unknown) => {
    const res = await fetch(srv.base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: srv.cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json() };
  };
  const { data: p } = await call('/api/projects', { name: 'Aura Watch' });
  const start = (title: string, message: string) => call(`/api/projects/${p.id}/tickets`, { title, message, properties: { type: 'bug' } });
  const first = await start(slamA.title, slamA.brief);
  const second = await start(slamB.title, slamB.brief);
  const store = new Store(join(root, 'data', 'coordinator.db'));
  store.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(Date.now() - 5 * 86_400_000, first.data.id);
  store.db.prepare('UPDATE tickets SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 86_400_000, second.data.id);

  const third = await start(slamNow.title, slamNow.brief);
  assert.equal(third.status, 201);
  const up = nextStep(BY_TYPE.bug.model, BY_TYPE.bug.effort, true)!;
  assert.deepEqual([third.data.model, third.data.effort], [up.model, up.effort]);
  assert.equal(third.data.picked_because, `third fix (#${first.data.number}, #${second.data.number}): one tier up → ${tierLabel(up.model, up.effort)}`);
  assert.ok(third.data.notes.some((n: string) => n.startsWith('Third-fix flag:')), 'the Taskmaster hears it');
  const brief = store.db.prepare("SELECT json_extract(data, '$.text') AS t FROM events WHERE ticket_id = ? AND kind = 'user_message' ORDER BY id LIMIT 1").get(third.data.id) as { t: string };
  assert.match(brief.t, /^\*\*Third fix: diagnose first\.\*\*[^]*citadel:diagnosing-bugs[^]*\n\n---\n\nThe glow on Supercharged Slam/);

  const other = await call(`/api/projects/${p.id}/tickets`, { title: 'Same words, a chore', message: slamNow.brief, properties: { type: 'chore' } });
  assert.deepEqual([other.data.model, other.data.effort], [BY_TYPE.chore.model, BY_TYPE.chore.effort], 'only bug minions are checked');
  store.close?.();
});
