import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { imageHash, type ClaudeLink } from '../src/claude-link.ts';
import { CodexLink, deviceCode } from '../src/codex-link.ts';
import { Containers } from '../src/containers.ts';
import { notReady, review } from '../src/codex-review.ts';

// Codex as a read-only second-opinion reviewer (#330): the managed tripwire hook baked into each
// person's container, and the app-server driver behind citadel-codex-review.
const root = mkdtempSync(join(tmpdir(), 'codex-'));
after(() => rmSync(root, { recursive: true, force: true }));
const image = join(import.meta.dirname, '..', 'deploy', 'claude-container');
const HOOK = join(image, 'codex', 'citadel-hook.mjs');
const tripwire = join(import.meta.dirname, '..', 'src', 'tripwire.ts');
const home = '/home/u';
const config = { home, data: `${home}/.local/share/claude-coordinator`, checkout: `${home}/claude-coordinator`, project: 2, claudeConfig: `${home}/.claude`, deployScript: true, env: { PATH: '/usr/bin' } };
const worktree = `${home}/.local/share/claude-coordinator/projects/2/tickets/9`;

function configFile(body: object | string): string {
  const f = join(root, `tw-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  return f;
}
const good = configFile({ script: tripwire, config });
/** Run the hook as Codex does: hook input on stdin, the turn's env. */
function hook(input: object | string, file: string | null = good) {
  const r = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { PATH: process.env.PATH, ...(file ? { CITADEL_CODEX_TRIPWIRE: file } : {}) }, encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}
const bash = (command: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: worktree });

test("the Codex hook passes what the tripwire lets through and blocks what it stops, with exit 2 (Codex's only block)", () => {
  assert.equal(hook(bash('git diff main...HEAD && rg -n tripwire src')).code, 0);
  const ssh = hook(bash('cat ~/.ssh/id_rsa'));
  assert.equal(ssh.code, 2);
  assert.match(ssh.stderr, /\[tripwire\].*SSH keys/);
  assert.equal(hook(bash('cat ~/.codex/auth.json')).code, 2);
});

test('the Codex hook turns the ask tier into a block: Codex ignores "ask", and no card can show', () => {
  const asks = configFile({ script: tripwire, config: { ...config, ask: true } });
  const r = hook({ ...bash('systemctl --user enable x.timer'), tool_input: { command: 'systemctl --user enable x.timer', description: 'Install the timer Cara asked for in #54' } }, asks);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[tripwire\]/);
});

test('the Codex hook runs shell commands only: patches, MCP tools and the rest are off in a read-only review', () => {
  for (const tool of ['apply_patch', 'Write', 'mcp__thread__set_thread_status', '']) {
    const r = hook({ tool_name: tool, tool_input: { command: '*** Begin Patch\n*** Add File: x\n+y\n*** End Patch' }, cwd: worktree });
    assert.equal(r.code, 2, `${tool || 'no tool'} is blocked`);
    assert.match(r.stderr, /read-only/);
  }
});

test('a broken Codex hook blocks: no config, an unreadable one, a missing tripwire, a crash or bad input', () => {
  const thrower = join(root, 'throws.ts');
  writeFileSync(thrower, "export function tripwire() { throw new Error('boom'); }\n");
  const cases: [string, ReturnType<typeof hook>][] = [
    ['no config', hook(bash('echo hi'), null)],
    ['missing config file', hook(bash('echo hi'), join(root, 'nope.json'))],
    ['config not JSON', hook(bash('echo hi'), configFile('{'))],
    ['missing tripwire', hook(bash('echo hi'), configFile({ script: join(root, 'gone.ts'), config }))],
    ['tripwire throws', hook(bash('echo hi'), configFile({ script: thrower, config }))],
    ['input not JSON', hook('not json')],
  ];
  for (const [name, r] of cases) {
    assert.equal(r.code, 2, `${name}: blocked`);
    assert.match(r.stderr, /\[tripwire\]/, name);
  }
});

test("Codex's managed requirements run only Citadel's hook, from a static command, and the image installs both", () => {
  const req = readFileSync(join(image, 'codex', 'requirements.toml'), 'utf8');
  assert.match(req, /^allow_managed_hooks_only = true$/m);
  assert.match(req, /^\[features\]\nhooks = true$/m);
  // Codex un-trusts an edited hook command; the per-turn config travels in CITADEL_CODEX_TRIPWIRE instead.
  assert.match(req, /^command = "\/usr\/local\/bin\/node \/etc\/codex\/citadel-hook\.mjs"$/m);
  assert.match(req, /^matcher = "\.\*"$/m);
  const containerfile = readFileSync(join(image, 'Containerfile'), 'utf8');
  assert.match(containerfile, /@openai\/codex@\d+\.\d+\.\d+ /, 'Codex is pinned to one version');
  assert.match(containerfile, /^COPY codex\/ \/etc\/codex\/$/m);
});

test('the image tag changes with any file in its build folder, not just the Containerfile', () => {
  const dir = join(root, 'img');
  mkdirSync(join(dir, 'codex'), { recursive: true });
  writeFileSync(join(dir, 'Containerfile'), 'FROM x\n');
  writeFileSync(join(dir, 'codex', 'hook.mjs'), 'a');
  const before = imageHash(dir);
  assert.equal(imageHash(dir), before);
  writeFileSync(join(dir, 'codex', 'hook.mjs'), 'b');
  assert.notEqual(imageHash(dir), before);
});

test("a review refuses to run without the managed hook, the turn's tripwire config or the person's Codex sign-in", () => {
  const req = join(root, 'requirements.toml');
  const codexHome = join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  const env = { CITADEL_CODEX_TRIPWIRE: good, CODEX_HOME: codexHome };
  assert.match(notReady(env, req)!, /managed tripwire hook isn't installed/);
  writeFileSync(req, readFileSync(join(image, 'codex', 'requirements.toml')));
  assert.match(notReady({ CODEX_HOME: codexHome }, req)!, /no Codex tripwire config/);
  assert.match(notReady(env, req)!, /hasn't signed in to Codex/);
  writeFileSync(join(codexHome, 'auth.json'), '{}');
  assert.equal(notReady(env, req), null);
});

// A stand-in for `codex app-server`: logs what it gets, and plays the turn FAKE_CODEX names.
const fakeLog = join(root, 'fake-codex.jsonl');
const fakeCodex = join(root, 'codex');
writeFileSync(
  fakeCodex,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const log = (m) => appendFileSync(${JSON.stringify(fakeLog)}, JSON.stringify(m) + '\\n');
log({ argv: process.argv.slice(2) });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const mode = process.env.FAKE_CODEX;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  log(m);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'th1' } } });
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'tu1' } } });
    if (mode === 'hang') return;
    send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'th1', turnId: 'tu1', itemId: 'i1' } });
  }
  if (m.id === 900) {
    if (mode === 'fail') {
      send({ method: 'error', params: { error: { message: 'You have hit your usage limit' }, willRetry: false, threadId: 'th1', turnId: 'tu1' } });
      return send({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu1', status: 'failed', error: null } } });
    }
    send({ method: 'item/completed', params: { threadId: 'th1', turnId: 'tu1', item: { type: 'agentMessage', id: 'a0', text: 'Looking at the diff.' } } });
    send({ method: 'item/completed', params: { threadId: 'th1', turnId: 'tu1', item: { type: 'agentMessage', id: 'a1', text: '1. Must fix: x.ts:3 off by one\\nRisk: medium: logic' } } });
    send({ method: 'turn/completed', params: { threadId: 'th1', turn: { id: 'tu1', status: 'completed', error: null } } });
  }
});
`,
);
chmodSync(fakeCodex, 0o755);
const logged = () => readFileSync(fakeLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a review starts a read-only, ephemeral thread with no approvals, declines what Codex asks, and returns its last message', async () => {
  rmSync(fakeLog, { force: true });
  const r = await review('Review branch x.', { cwd: root, timeoutMs: 10_000, bin: fakeCodex, env: { ...process.env, FAKE_CODEX: 'ok' } });
  assert.deepEqual(r, { code: 0, text: '1. Must fix: x.ts:3 off by one\nRisk: medium: logic' });
  const msgs = logged();
  assert.deepEqual(msgs[0].argv.slice(0, 1), ['app-server']);
  assert.ok(msgs[0].argv.includes('cli_auth_credentials_store="file"'));
  const start = msgs.find((m) => m.method === 'thread/start').params;
  assert.equal(start.sandbox, 'read-only');
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.ephemeral, true);
  assert.equal(start.cwd, root);
  assert.equal(msgs.find((m) => m.method === 'turn/start').params.input[0].text, 'Review branch x.');
  assert.deepEqual(msgs.find((m) => m.id === 900).result, { decision: 'decline' });
});

test("a failed Codex turn says why (a usage limit, say), and a stuck one times out and is stopped", async () => {
  const failed = await review('Review.', { cwd: root, timeoutMs: 10_000, bin: fakeCodex, env: { ...process.env, FAKE_CODEX: 'fail' } });
  assert.equal(failed.code, 1);
  assert.match(failed.text, /failed: You have hit your usage limit/);
  rmSync(fakeLog, { force: true });
  const stuck = await review('Review.', { cwd: root, timeoutMs: 500, bin: fakeCodex, env: { ...process.env, FAKE_CODEX: 'hang' } });
  assert.equal(stuck.code, 124);
  assert.match(stuck.text, /didn't finish the review within 1 s/);
  const missing = await review('Review.', { cwd: root, timeoutMs: 5_000, bin: join(root, 'no-codex') });
  assert.equal(missing.code, 3);
});

// Signing in from Settings: a fake `podman exec` prints Codex's device-code screen, then signs in (or
// fails) when the test says so, as OpenAI's side would once the person enters the code.
const DEVICE = `Welcome to Codex [v\x1b[90m0.166.0\x1b[0m]

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m

2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m
   \x1b[94mAB12-CD34Z\x1b[0m
`;

test("the device link and code are read from codex login's screen, and not before both are out", () => {
  const plain = DEVICE.replace(/\x1b\[[0-9;]*m/g, '');
  assert.deepEqual(deviceCode(plain), { url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z' });
  assert.equal(deviceCode(plain.slice(0, plain.indexOf('2. Enter'))), null);
});

test("Codex signs in inside the person's container by device code, and the login stays a file Citadel only checks for", async () => {
  const dir = join(root, 'link');
  const home = join(dir, 'volume');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls.jsonl');
  const go = join(dir, 'go');
  writeFileSync(join(bin, 'podman'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const args = process.argv.slice(2);
if (args.includes('logout')) { fs.rmSync(${JSON.stringify(join(home, '.codex', 'auth.json'))}, { force: true }); process.exit(0); }
process.stdout.write(${JSON.stringify(DEVICE)});
const wait = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(go)})) return;
  const how = fs.readFileSync(${JSON.stringify(go)}, 'utf8');
  if (how === 'ok') fs.writeFileSync(${JSON.stringify(join(home, '.codex', 'auth.json'))}, '{}');
  else process.stderr.write('Error: device code expired');
  clearInterval(wait);
  process.exit(how === 'ok' ? 0 : 1);
}, 50);
`);
  chmodSync(join(bin, 'podman'), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    let linked = true;
    const claude = { meta: () => (linked ? { container: 'citadel-claude-2', home, linkedAt: 1 } : null), name: () => 'citadel-claude-2', ensure: async () => {} } as unknown as ClaudeLink;
    const codex = new CodexLink(claude, new Containers());
    assert.deepEqual(codex.status(2), { state: 'not linked' });
    const started = await codex.link(2);
    assert.deepEqual(started, { state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z' });
    const argv = JSON.parse(readFileSync(calls, 'utf8').trim().split('\n')[0]);
    assert.deepEqual(argv, ['exec', '-i', 'citadel-claude-2', 'codex', 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"']);
    // OpenAI turns the code down: the sign-in says why, without the link or the code.
    writeFileSync(go, 'expired');
    await until(() => codex.status(2).state === 'not linked');
    assert.match(codex.status(2).error!, /exit 1.*device code expired/);
    assert.doesNotMatch(codex.status(2).error!, /AB12|auth\.openai/);
    rmSync(go);
    await codex.link(2);
    writeFileSync(go, 'ok');
    await until(() => codex.status(2).state === 'linked');
    // Signing out runs codex logout in the container, which deletes the login.
    await codex.unlink(2);
    assert.deepEqual(codex.status(2), { state: 'not linked' });
    assert.ok(readFileSync(calls, 'utf8').includes('"logout"'));
    // Without a Claude container (the server's own login, or not linked) there's nowhere for Codex to run.
    linked = false;
    assert.deepEqual(codex.status(2), { state: 'no container' });
  } finally {
    process.env.PATH = savedPath;
  }
});

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}
