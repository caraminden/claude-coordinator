import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';

// A turn that hits the usage limit leaves the minion in `limited`, with Claude's words on when it
// resets as the note; any other failure stays plain stuck. Fake `claude -p` as in pending-deploy.test.ts.
const root = mkdtempSync(join(tmpdir(), 'usage-limit-'));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync, readFileSync } = require('node:fs');
process.stdin.resume();
const wait = setInterval(() => {
  const release = ${JSON.stringify(join(root, 'release'))};
  if (!existsSync(release)) return;
  clearInterval(wait);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: readFileSync(release, 'utf8') }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const runner = new Runner(store, () => {}, () => ({}), fake);

async function failTurn(state: any, result: string) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', state, note: 'before' });
  runner.send(t.id, 'Cara', 'go');
  rmSync(join(root, 'release'), { force: true });
  writeFileSync(join(root, 'release'), result);
  while (runner.isRunning(t.id)) await new Promise((r) => setTimeout(r, 20));
  rmSync(join(root, 'release'), { force: true });
  return store.getTicket(t.id)!;
}

const LIMIT = "You've hit your 5-hour limit · resets 3:30pm (America/Los_Angeles)";

test('a usage-limit failure is limited, with the reset time as the note', async () => {
  const t = await failTurn(null, LIMIT);
  assert.equal(t.status, 'error');
  assert.equal(t.state, 'limited');
  assert.equal(t.note, LIMIT);
  assert.equal((await failTurn('ready', "You've hit your session limit · resets 7:40am")).state, 'limited');
});

test('other failures stay stuck, and pending-deploy outlasts a limit', async () => {
  const other = await failTurn(null, 'API Error: 400 Identity verification is required to continue.');
  assert.equal(other.status, 'error');
  assert.equal(other.state, null);
  assert.equal(other.note, 'before');
  assert.equal((await failTurn('pending-deploy', LIMIT)).state, 'pending-deploy');
});
