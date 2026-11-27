// A cloud turn through the real Runner (#2153): the line sends a research minion's first turn to the cloud first, though
// perigee has room and with no mark, and keeps one create_ticket didn't let go home; its turn runs src/cloud-turn.mjs in claude's place on the sender's login, the session is kept on
// the minion and its next turn is a follow-up to it there, and another person's turn comes home to perigee (sender pays).
// The fake `claude` stands in for both a perigee turn and the cloud; origin is a bare repo.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { CLOUD, CLOUD_PLACE } from '../src/cloud-pool.ts';
import { Runner } from '../src/runner.ts';
import { jsonLines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';

testPins();

const root = mkdtempSync(join(tmpdir(), 'cloud-runner-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
const origin = join(root, 'origin.git');
const work = join(root, 'work');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
git(work, 'commit', '-q', '--allow-empty', '-m', 'start');
git(work, 'push', '-q', 'origin', 'HEAD:main');

// The fake: on perigee (`-p` with no `--cloud`) it logs its prompt and runs until `end-<minion>` is there; `--cloud <text>`
// pushes a result to the branch the text names and shows the session's link; `-p <text> --cloud <id>` pushes the next one.
const calls = join(root, 'calls.log');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([process.env.TEST_MINION, ...args]) + '\\n');
function push(text, reply) {
  const branch = text.match(/cloud\\/[\\w-]+/)[0];
  const d = mkdtempSync(join(${JSON.stringify(root)}, 'vm-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 'vm', GIT_AUTHOR_EMAIL: 'v@m', GIT_COMMITTER_NAME: 'vm', GIT_COMMITTER_EMAIL: 'v@m' } });
  execFileSync('git', ['clone', '-q', ${JSON.stringify(origin)}, d]);
  mkdirSync(join(d, '.citadel'), { recursive: true });
  writeFileSync(join(d, '.citadel/result.json'), JSON.stringify({ reply, card: null, files: [] }));
  g('add', '-A'); g('commit', '-q', '-m', reply); g('push', '-q', 'origin', 'HEAD:refs/heads/' + branch);
}
if (args[0] === '--cloud') {
  push(args[1], 'from the cloud');
  process.stdout.write('Created https://claude.ai/code/session_01RUNNERabc\\n');
  setInterval(() => {}, 1000);
} else if (args.includes('--cloud')) {
  push(args[1], 'the follow-up');
  console.log('{}');
} else {
  require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
    console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on perigee' }] } }));
    setInterval(() => {
      if (!existsSync(${JSON.stringify(root)} + '/end-' + process.env.TEST_MINION)) return;
      console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
      process.exit(0);
    }, 10);
  });
}
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
store.setProjectUpstream(project.id, 'https://github.com/caraminden/claude-coordinator', null); // a cloud session clones from GitHub
const cara = store.createUser({ name: 'Cara', login: 'cara' });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
store.addMember(project.id, cara.id);
store.addMember(project.id, josh.id);
const runner = new Runner(
  store,
  () => {},
  (t: { id: number }) => ({ TEST_MINION: String(t.id) }),
  fake,
);
runner.pollMs = 10;
runner.resumeGapMs = 0;
runner.personOf = (author) => (author === 'Josh' ? josh.id : author === 'Cara' ? cara.id : null);
runner.placeFor = () => ({ host: true });
runner.turnLine.setSize(1, 'Cara');

function minion(type: string | null) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, work, null);
  if (type) store.props.set('minion', t.id, project.id, { type }, 'Cara');
  return t.id;
}
const say = (id: number, text: string, by = 'Cara') => runner.send(id, by, text, [], { typed: true });
const said = (id: number) => JSON.stringify(store.eventsOfKinds(id, ['claude', 'note']).map((e) => e.data));
const idle = (id: number) => until(`minion ${id} to finish`, () => !runner.isRunning(id) && store.getTicket(id)!.status !== 'running');
const ofMinion = (id: number) => jsonLines(calls).filter((c) => Array.isArray(c) && c[0] === String(id)) as string[][];

test("a research minion's first turn goes to the cloud though perigee is free; its next turn follows it up there; another person's comes home", async () => {
  const home = minion('research'); // made by a schedule, or create_ticket's cloud: false
  say(home, 'read the shared folder');
  await until('the kept-home turn at perigee', () => ofMinion(home).length > 0);
  assert.equal(ofMinion(home)[0].includes('--cloud'), false);
  writeFileSync(join(root, `end-${home}`), '');
  await idle(home);

  const research = minion('research');
  runner.cloud.made(research, { go: true }, 'Cara'); // create_ticket's research minion
  say(research, 'compare X and Y');
  await until('the cloud result', () => said(research).includes('from the cloud'));
  await idle(research);
  const start = ofMinion(research);
  assert.equal(start.length, 1);
  assert.equal(start[0][1], '--cloud', 'a pty start, not a perigee turn');
  assert.deepEqual(start[0].slice(3), ['--effort', 'high'], "a start gets the minion's effort too");
  assert.match(start[0][2], /\[Cara\]: compare X and Y/);
  const s = runner.cloud.session(research);
  assert.equal(s?.session, 'session_01RUNNERabc');
  assert.equal(s?.person, cara.id, "on its sender's own login");
  assert.equal(git(origin, 'branch', '--list', 'cloud/*'), '', 'its branch is deleted once read');

  // Its conversation is in the cloud: its next turn goes there.
  say(research, 'go with A');
  await until('the follow-up', () => said(research).includes('the follow-up'));
  await idle(research);
  const next = ofMinion(research).at(-1)!;
  assert.deepEqual([next[1], next.slice(3)], ['-p', ['--cloud', 'session_01RUNNERabc', '--effort', 'high', '--output-format', 'json']], "with the minion's own effort");
  assert.match(next[2], /\[Cara\]: go with A/);
  assert.equal(ofMinion(research).filter((a) => a[1] !== '-p').length, 1, 'a follow-up is no new session');
  // Each turn is counted its own estimate: a running total would book the second at nothing.
  const want = CLOUD.costUsd.start + CLOUD.costUsd.followUp;
  await until('both cloud turns counted', () => Math.abs(store.ticketCost(research) - want) < 1e-9);

  // Josh can't follow up a session on Cara's login: his turn runs at perigee, and the chat says why.
  say(research, 'and B?', 'Josh');
  await until("Josh's turn at perigee", () => ofMinion(research).length === 3);
  assert.equal(ofMinion(research).at(-1)!.includes('--cloud'), false);
  assert.notEqual(runner.turnLine.placeOf(research), CLOUD_PLACE);
  assert.match(said(research), /cloud session is on Cara's login/);
  writeFileSync(join(root, `end-${research}`), '');
  await idle(research);
});
