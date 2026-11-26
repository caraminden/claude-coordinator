// A minion's turn as a cloud session (#2153, src/cloud-turn.mjs), against a fake `claude`: the pty start through its first-run
// screen, the follow-up, the branch poll, the result's card and files, the branch deleted after fetch, and the teleport
// read-back when nothing is pushed. Origin is a bare repo here; the card route a stand-in server.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { keyFor, printedResult, readResult, sessionIn } from '../src/cloud-turn.mjs';
import { jsonLines } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'cloud-turn-'));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const origin = join(root, 'origin.git');
const work = join(root, 'work');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['clone', '-q', origin, work], { stdio: 'ignore' });
git(work, 'commit', '-q', '--allow-empty', '-m', 'start');
git(work, 'push', '-q', 'origin', 'HEAD:main');

const posted: unknown[] = [];
const api = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url !== '/api/tickets/7/questions' || req.headers.authorization !== 'Bearer tok') return res.writeHead(404).end();
    // As src/routes/tickets.ts: 2 or more options, one of them recommended.
    const card = JSON.parse(body) as { questions: { options: { recommended?: boolean }[] }[] };
    if (!card.questions.every((q) => q.options.length >= 2 && q.options.some((o) => o.recommended))) return res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"each question needs a recommended option"}');
    posted.push(card);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"href":"#/p/2/t/7?e=1"}');
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
after(() => {
  api.close();
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});

// The fake: `--cloud <text>` shows a first-run screen, waits for Enter, pushes its result to the branch named in the text and
// shows the session's link; `-p <text> --cloud <id>` pushes the next result; `--teleport <id>` prints a result between the markers.
const log = join(root, 'claude.log');
const fake = join(root, 'claude');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_MODE || 'push';
function push(text, reply) {
  if (mode === 'silent') return;
  const branch = text.match(/cloud\\/[\\w-]+/)[0];
  const d = mkdtempSync(join(${JSON.stringify(root)}, 'vm-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 'vm', GIT_AUTHOR_EMAIL: 'v@m', GIT_COMMITTER_NAME: 'vm', GIT_COMMITTER_EMAIL: 'v@m' } });
  execFileSync('git', ['clone', '-q', ${JSON.stringify(origin)}, d]);
  mkdirSync(join(d, '.citadel/out'), { recursive: true });
  writeFileSync(join(d, '.citadel/out/report.md'), '# Report ' + reply);
  writeFileSync(join(d, '.citadel/result.json'), JSON.stringify({ reply, card: reply === 'first' ? { questions: [{ question: 'Which?', options: [{ label: 'A', recommended: true }, { label: 'B' }] }] } : null, files: ['.citadel/out/report.md', '../../etc/passwd'] }));
  g('add', '-A'); g('commit', '-q', '-m', reply); g('push', '-q', 'origin', 'HEAD:refs/heads/' + branch);
}
if (args[0] === '-p') {
  push(args[1], 'second');
  console.log(JSON.stringify({ ok: true }));
} else if (args[0] === '--teleport') {
  process.stdout.write('\\x1b[2Jtranscript...\\nCITADEL-RESULT-BEGIN\\n{"reply":"from teleport","files":[]}\\nCITADEL-RESULT-END\\n');
  setInterval(() => {}, 1000);
} else {
  process.stdout.write('Welcome\\n\\x1b[1mPress Enter to continue\\x1b[0m\\n');
  process.stdin.setRawMode?.(true);
  process.stdin.once('data', () => {
    push(args[1], 'first');
    process.stdout.write('Created https://claude.ai/code/session_01FAKEabc123\\n');
    setInterval(() => {}, 1000);
  });
}
`,
);
chmodSync(fake, 0o755);

/** Run the driver on `job`; its stream-json lines. */
function drive(job: object, env: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
  const file = join(root, `job-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify({ claude: fake, cwd: work, files: join(root, 'files'), limitMs: 60_000, pollMs: 100, startMs: 30_000, sha: null, session: null, ...job }));
  const p = spawn(process.execPath, [join(import.meta.dirname, '../src/cloud-turn.mjs'), file], {
    env: { ...process.env, COORDINATOR_API: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, COORDINATOR_TOKEN: 'tok', COORDINATOR_TICKET: '7', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  p.stdin.end('{"type":"user"}\n');
  let out = '';
  p.stdout.on('data', (b) => (out += b));
  return new Promise((r) =>
    p.on('exit', () =>
      r(
        out
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l)),
      ),
    ),
  );
}
const texts = (evs: Record<string, unknown>[]) => evs.filter((e) => e.type === 'assistant').map((e) => (e.message as { content: { text: string }[] }).content[0].text);

test('a start presses through the first-run screen, reads the result off its branch, posts its card and deletes the branch', async () => {
  const branch = 'cloud/t7-a';
  const evs = await drive({ branch, text: `Push your result to ${branch}.` });
  const session = evs.find((e) => e.type === 'system' && e.subtype === 'cloud' && !e.sha);
  assert.deepEqual({ ...session }, { type: 'system', subtype: 'cloud', session: 'session_01FAKEabc123', url: 'https://claude.ai/code/session_01FAKEabc123', branch });
  const read = evs.find((e) => e.subtype === 'cloud' && e.sha);
  assert.equal(typeof read?.sha, 'string');
  assert.match(texts(evs).at(-1)!, /^first\n\nFiles: \[report\.md\]/);
  assert.equal((evs.at(-1) as { type: string; is_error: boolean }).is_error, false);
  assert.deepEqual(posted.at(-1), { questions: [{ question: 'Which?', options: [{ label: 'A', recommended: true }, { label: 'B' }] }] });
  assert.equal(readFileSync(join(root, 'files', 'report.md'), 'utf8'), '# Report first');
  assert.equal(existsSync(join(root, 'files', 'passwd')), false, 'a path out of .citadel/out is refused');
  assert.equal(git(origin, 'branch', '--list', branch), '', 'deleted after the fetch');
  assert.equal(git(work, 'for-each-ref', 'refs/citadel-cloud'), '');
});

test('a follow-up goes to the same session with -p and reads its next push', async () => {
  const branch = 'cloud/t7-b';
  const before = posted.length;
  const evs = await drive({ branch, session: 'session_01FAKEabc123', sha: 'old', text: `The answer: A. Push to ${branch}.` });
  const calls = jsonLines(log);
  assert.deepEqual(calls.at(-1), ['-p', `The answer: A. Push to ${branch}.`, '--cloud', 'session_01FAKEabc123', '--output-format', 'json']);
  assert.equal(
    evs.some((e) => e.subtype === 'cloud' && e.session !== 'session_01FAKEabc123'),
    false,
    'no new session',
  );
  assert.match(texts(evs).at(-1)!, /^second/);
  assert.equal(posted.length, before, 'no card in this result');
  assert.equal(git(origin, 'branch', '--list', branch), '');
});

/** Push `result` to `branch` on origin, as a session would; its sha. */
function pushed(branch: string, result: string) {
  const d = mkdtempSync(join(root, 'push-'));
  execFileSync('git', ['clone', '-q', origin, d], { stdio: 'ignore' });
  mkdirSync(join(d, '.citadel'), { recursive: true });
  writeFileSync(join(d, '.citadel/result.json'), result);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', branch);
  git(d, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
  return git(d, 'rev-parse', 'HEAD');
}

test("an answer pushed after its turn ended is shown as late before the next message goes, never as that message's reply", async () => {
  pushed('cloud/t7-late', '{"reply":"the late one","card":null,"files":[]}');
  const evs = await drive({ branch: 'cloud/t7-next', last: 'cloud/t7-late', session: 'session_01FAKEabc123', sha: 'old', text: 'Next. Push to cloud/t7-next.' });
  const said = texts(evs);
  assert.match(said[0], /came in after that turn ended:\n\nthe late one/);
  assert.match(said.at(-1)!, /^second/, 'its own reply is its own push');
  assert.equal(git(origin, 'branch', '--list', 'cloud/t7-late'), '', 'the late branch is read and deleted');
  assert.equal(
    evs.some((e) => e.subtype === 'cloud' && e.branch === 'cloud/t7-next' && !e.sha),
    true,
    "this turn's branch is said, for the next one's late look",
  );
});

test('a result that cannot be read stays on its branch, and its sha is said so it is not read again', async () => {
  const sha = pushed('cloud/t7-bad', '{"card":null}');
  const evs = await drive({ branch: 'cloud/t7-bad', session: 'session_01FAKEabc123', text: 'x' }, { FAKE_MODE: 'silent' });
  const last = evs.at(-1) as { is_error: boolean; result: string };
  assert.equal(last.is_error, true);
  assert.match(last.result, /couldn't be read: .*no reply/);
  assert.equal(git(origin, 'rev-parse', 'refs/heads/cloud/t7-bad'), sha, 'kept on origin for a look');
  assert.equal(
    evs.some((e) => e.subtype === 'cloud' && e.sha === sha),
    true,
  );
});

test('a session that never pushes is read back through teleport in a throwaway clone', async () => {
  const head = git(work, 'rev-parse', 'HEAD');
  const evs = await drive({ branch: 'cloud/t7-c', session: 'session_01FAKEabc123', text: 'cloud/t7-c', limitMs: 300 }, { FAKE_MODE: 'silent' });
  assert.equal(texts(evs).at(-1), 'from teleport');
  const calls = jsonLines(log);
  assert.deepEqual(calls.at(-1), ['--teleport', 'session_01FAKEabc123']);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head, "the minion's checkout is untouched");
});

test('the result from outside is checked before anything is done with it', () => {
  assert.deepEqual(readResult('{"reply":"hi","card":{"questions":[1]},"files":[".citadel/out/a.md","x/y","../.citadel/out/b",".citadel/out/../../c",7]}'), { reply: 'hi', card: { questions: [1] }, files: ['.citadel/out/a.md'] });
  assert.throws(() => readResult('{"card":null}'), /no reply/);
  assert.throws(() => readResult('[1]'), /no reply/);
  assert.deepEqual(readResult('{"reply":"x","card":{"questions":"no"}}').card, null);
  assert.equal(printedResult('a CITADEL-RESULT-BEGIN {"reply":1} CITADEL-RESULT-END'), '{"reply":1}');
  assert.equal(printedResult('CITADEL-RESULT-BEGIN half'), null);
  assert.deepEqual(sessionIn('\x1b[32mhttps://claude.ai/code/session_01Ab-c_d\x1b[0m'), { session: 'session_01Ab-c_d', url: 'https://claude.ai/code/session_01Ab-c_d' });
  assert.equal(sessionIn('nothing yet'), null);
  assert.equal(keyFor('Yes, I trust this folder'), '\x1b[B\r');
  assert.equal(keyFor('Press  Enter to continue'), '\r');
  assert.equal(keyFor('working'), null);
});

mkdirSync(join(root, 'files'), { recursive: true });
