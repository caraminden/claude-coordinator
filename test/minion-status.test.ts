import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'minion-status-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

// A `claude -p` that runs until the test lets it go, so the checks below have a turn that is certainly live.
const go = join(root, 'go');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
const { existsSync } = require('node:fs');
const t = setInterval(() => {
  if (!existsSync(${JSON.stringify(go)})) return;
  clearInterval(t);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`);
chmodSync(fake, 0o755);

// #1618: the row a read is served can be behind the write queue (src/db-writer.ts gives up after READ_WAIT_MS and
// serves what it has), and on a loaded box that row still said 'new' or 'idle' for a minion whose turn had launched.
// A turn's token is minted at that launch and only the newest one works (src/auth.ts turnToken), so everything that
// acts on "idle, nothing queued" -- the UI, another minion, test/host-tool-cards.test.ts -- then used a dead token and
// got 401s. The status people and tokens are judged by comes from the live turns, as `queued` already did.
test('a minion shows as running while its turn is live, however stale the row the read was served', async () => {
  const store = new Store(join(root, 'test.db'));
  const project = store.createProject('P', null);
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  try {
    runner.send(t.id, 'Cara', 'look into it');
    await until('the turn to start', () => runner.isRunning(t.id));
    const stale = { ...store.getTicket(t.id)!, status: 'new' };
    assert.equal(runner.view(stale).status, 'running', 'the row said new, but the turn (and its token) had started');
    assert.equal(runner.view({ ...stale, status: 'idle' }).status, 'running');
    // A closed minion keeps its own status: nothing of its is live, and the list sorts and hides by it.
    assert.equal(runner.view({ ...stale, status: 'closed' }).status, 'closed');
    // The readers' copy carries the live turn, not a status (src/reader-live.ts posts it on each broadcast): a reader
    // combines it with its own fresh row, so a minion doesn't stay 'running' there until the next sweep.
    assert.equal('status' in runner.live(stale), false, 'the posted copy leaves the status to the row');
    assert.equal(runner.live(stale).turn_live, true);
    // A keepalive (#862) is hidden on purpose: no chat, no state, and the list never shows it as running.
    (runner as unknown as { keepalives: Set<number> }).keepalives.add(t.id);
    assert.equal(runner.view({ ...stale, status: 'idle' }).status, 'idle', 'a hidden keepalive shows no turn');
    (runner as unknown as { keepalives: Set<number> }).keepalives.delete(t.id);
  } finally {
    writeFileSync(go, '');
    // The row too: the runner wraps the turn up after it stops counting it running, writing into the temp folder (#1763).
    await until('the turn to end', () => !runner.isRunning(t.id) && store.getTicket(t.id)!.status !== 'running');
  }
});
