import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { imageHash, type ClaudeLink } from '../src/claude-link.ts';
import { CodexLink, deviceCode } from '../src/codex-link.ts';
import { Containers } from '../src/containers.ts';
import { images, notReady, overPace, REQUIREMENTS, review, usageLine } from '../src/codex-review.ts';
// @ts-expect-error: a plain .mjs, shipped into the image as is.
import { patchPaths } from '../deploy/claude-container/codex/citadel-hook.mjs';

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

const turnCfg = (extra: object = {}) => configFile({ script: tripwire, config: { ...config, turnDir: `${home}/.citadel-turns/9-1` }, mode: 'turn', mcp: ['thread', 'perigee-godot'], rules: ['mcp__*__merge_pull_request', 'Bash(gh pr merge:*)'], ...extra });
const patch = (body: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` }, cwd: worktree });

test('a Codex turn runs the shell through the tripwire, and its ask tier and approval rules are blocks that point at ask_question', () => {
  const t = turnCfg();
  assert.equal(hook(bash('npm test && git commit -am wip'), t).code, 0);
  assert.equal(hook(bash('cat ~/.ssh/id_rsa'), t).code, 2);
  const ask = hook(bash('systemctl --user enable x.timer'), t);
  assert.equal(ask.code, 2);
  assert.match(ask.stderr, /ask_question/);
  const merge = hook(bash('gh  pr merge 12 --squash'), t);
  assert.equal(merge.code, 2);
  assert.match(merge.stderr, /approval rule Bash\(gh pr merge:\*\)/);
  const mcpMerge = hook({ tool_name: 'mcp__github__merge_pull_request', tool_input: {}, cwd: worktree }, configFile({ script: tripwire, config, mode: 'turn', mcp: ['github'], rules: ['mcp__*__merge_pull_request'] }));
  assert.equal(mcpMerge.code, 2);
  assert.match(mcpMerge.stderr, /approval rule/);
});

test("a Codex turn's patches are checked path by path as writes, and one the parser can't read is blocked", () => {
  const t = turnCfg();
  assert.equal(hook(patch('*** Update File: src/x.ts\n@@\n-a\n+b\n*** Add File: test/y.ts\n+z'), t).code, 0);
  const live = hook(patch(`*** Update File: src/x.ts\n*** Move to: ${home}/claude-coordinator/src/x.ts\n@@\n-a\n+b`), t);
  assert.equal(live.code, 2);
  assert.match(live.stderr, /live checkout/);
  assert.equal(hook(patch(`*** Delete File: ${home}/.local/share/claude-coordinator/state.db`), t).code, 2);
  const own = hook(patch(`*** Add File: ${home}/.citadel-turns/9-1/pin/tripwire.ts\n+export {}`), t);
  assert.equal(own.code, 2);
  assert.match(own.stderr, /turn's own folder/);
  for (const bad of ['*** Begin Patch\n*** Frobnicate: x\n*** End Patch', 'just text', '*** Begin Patch\n*** End Patch']) {
    const r = hook({ tool_name: 'apply_patch', tool_input: { command: bad }, cwd: worktree }, t);
    assert.equal(r.code, 2, bad);
    assert.match(r.stderr, /could not be read/);
  }
  assert.equal(hook({ ...patch('*** Add File: x\n+y'), cwd: undefined }, t).code, 2, 'a relative path with no cwd');
  assert.equal(hook(patch('*** Add File: x\n+y'), turnCfg({ rules: ['Edit(docs/**)'] })).code, 2, 'an edit rule blocks patches');
  assert.equal(hook(bash(`echo x > ${home}/.citadel-turns/9-1/codex-tripwire.json`), t).code, 2, 'the shell can\'t rewrite the config either');
});

test("a Codex turn runs only its own MCP servers' tools; Grunts, goals and unknown tools are off", () => {
  const t = turnCfg();
  assert.equal(hook({ tool_name: 'mcp__thread__set_thread_status', tool_input: {}, cwd: worktree }, t).code, 0);
  assert.equal(hook({ tool_name: 'mcp__perigee-godot__run', tool_input: {}, cwd: worktree }, t).code, 0);
  for (const tool of ['mcp__other__x', 'collaborationspawn_agent', 'create_goal', 'Write', '']) {
    assert.equal(hook({ tool_name: tool, tool_input: {}, cwd: worktree }, t).code, 2, tool || 'no tool');
  }
  assert.equal(hook({ tool_name: 'view_image', tool_input: { path: 'shot.png' }, cwd: worktree }, t).code, 0);
  assert.equal(hook({ tool_name: 'view_image', tool_input: { path: `${home}/.ssh/id_rsa` }, cwd: worktree }, t).code, 2);
});

test("a contraption's Codex turn runs only the contraption's own tools: no shell, no patches", () => {
  const c = configFile({ script: tripwire, config, mode: 'contraption', mcp: ['mandate'] });
  assert.equal(hook({ tool_name: 'mcp__mandate__add_item', tool_input: {}, cwd: worktree }, c).code, 0);
  for (const call of [bash('ls'), patch('*** Add File: x\n+y'), { tool_name: 'mcp__thread__x', tool_input: {}, cwd: worktree }, { tool_name: 'view_image', tool_input: { path: 'a.png' }, cwd: worktree }]) {
    const r = hook(call, c);
    assert.equal(r.code, 2, call.tool_name);
    assert.match(r.stderr, /only its own tools \(mcp__mandate\)/);
  }
});

test('an unknown or missing Codex hook mode is the read-only review', () => {
  for (const mode of [undefined, 'admin', 7]) {
    const r = hook(patch('*** Add File: x\n+y'), configFile({ script: tripwire, config, mode, mcp: ['thread'] }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /read-only/);
    assert.equal(hook({ tool_name: 'mcp__thread__x', tool_input: {}, cwd: worktree }, configFile({ script: tripwire, config, mode, mcp: ['thread'] })).code, 2);
  }
});

test('the patch parser reads every path a patch touches, moves included', () => {
  assert.deepEqual(patchPaths('*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** End of File\n*** Delete File: c.ts\n*** End Patch\n'), ['a.ts', 'b.ts', 'c.ts']);
  assert.equal(patchPaths('*** Begin Patch\n*** Copy File: a\n*** End Patch'), null);
  assert.equal(patchPaths(undefined), null);
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
  // The build folder's own modes can be 0600 (a turn's umask), and COPY keeps them: Codex runs as the person (#337).
  assert.match(containerfile, /^RUN chmod 0755 \/etc\/codex && chmod 0644 \/etc\/codex\/\* \\\n && runuser -u nobody -- cat \/etc\/codex\/requirements\.toml \/etc\/codex\/citadel-hook\.mjs > \/dev\/null$/m);
  // write_stdin into a tty shell runs keystrokes no hook sees (#337).
  assert.match(req, /^unified_exec_tty = false$/m);
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
  if (m.method === 'account/rateLimits/read') {
    if (mode === 'no-limits') return send({ id: m.id, error: { code: -32600, message: 'not signed in with ChatGPT' } });
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    const used = mode === 'over' ? 85 : 12;
    send({ id: m.id, result: { rateLimits: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: resetsAt + 86400 * 3 } } } });
  }
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
  assert.deepEqual(r, { code: 0, text: '1. Must fix: x.ts:3 off by one\nRisk: medium: logic', usage: '5-hour 12%, weekly 30%' });
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

test('images go to Codex after the brief, as local image inputs (#408)', async () => {
  rmSync(fakeLog, { force: true });
  const r = await review('Judge the sheet.', { cwd: root, timeoutMs: 10_000, images: ['/w/a.png', '/s/b.webp'], bin: fakeCodex, env: { ...process.env, FAKE_CODEX: 'ok' } });
  assert.equal(r.code, 0);
  assert.deepEqual(logged().find((m) => m.method === 'turn/start').params.input.slice(1), [
    { type: 'localImage', path: '/w/a.png' },
    { type: 'localImage', path: '/s/b.webp' },
  ]);
});

test("--image takes only image files in the review's folder or the turn's shared folders (#408)", () => {
  const w = join(root, 'img-worktree');
  const shared = join(root, 'img-shared');
  const outside = join(root, 'img-outside');
  for (const d of [join(w, 'shots'), shared, outside]) mkdirSync(d, { recursive: true });
  for (const f of [join(w, 'shots', 'a.png'), join(shared, 'b.JPG'), join(outside, 'c.png'), join(w, 'notes.txt')]) writeFileSync(f, 'x');
  symlinkSync(join(outside, 'c.png'), join(w, 'sneaky.png'));
  const env = { COORDINATOR_SHARED_DIR: shared };
  const at = (...a: string[]) => realpathSync(join(...a));
  assert.deepEqual(images(['--timeout', '60', '--image', 'shots/a.png', '--image', join(shared, 'b.JPG')], w, env), { paths: [at(w, 'shots', 'a.png'), at(shared, 'b.JPG')] });
  assert.deepEqual(images(['--timeout', '60'], w, env), { paths: [] });
  const why = (args: string[]) => (images(args, w, env) as { error: string }).error;
  assert.match(why(['--image', join(outside, 'c.png')]), /outside this worktree and the shared folders/);
  assert.match(why(['--image', 'sneaky.png']), /outside/, 'a link out of the worktree is judged by where it points');
  assert.match(why(['--image', 'notes.txt']), /isn't a png, jpg, gif or webp/);
  assert.match(why(['--image', 'shots/missing.png']), /no image at shots\/missing.png/);
  assert.match(why(['--image']), /needs a path/);
  assert.match((images(['--image', join(shared, 'b.JPG')], w, {}) as { error: string }).error, /outside/, 'no shared folder in the env: only the worktree');
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
    const claude = { volumeHome: () => (linked ? home : null), serverLogin: () => false, name: () => 'citadel-claude-2', ensure: async () => {} } as unknown as ClaudeLink;
    // The first start waits (a container rebuilding); later ones are instant.
    let started_ = () => {};
    const slow = new Promise<void>((r) => (started_ = r));
    (claude as any).ensure = () => slow;
    const codex = new CodexLink(claude, new Containers());
    assert.deepEqual(codex.status(2), { state: 'not linked' });
    // From the click on, while the container is still starting, Settings shows it and keeps polling.
    const linking = codex.link(2);
    assert.deepEqual(codex.status(2), { state: 'starting' });
    started_();
    const started = await linking;
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

test('Codex usage: a review is skipped past 80% of a window, or when a window is used faster than an even pace to its reset', () => {
  const now = Date.UTC(2026, 10, 5, 12);
  const at = (minsLeft: number) => Math.round(now / 1000) + minsLeft * 60;
  const week = (usedPercent: number, daysLeft: number) => ({ usedPercent, windowDurationMins: 10080, resetsAt: at(daysLeft * 1440) });
  const fiveHour = (usedPercent: number, minsLeft: number) => ({ usedPercent, windowDurationMins: 300, resetsAt: at(minsLeft) });
  assert.equal(overPace(null, now), null, 'no limits (an API key, an older backend): review');
  assert.equal(overPace({ primary: fiveHour(5, 290), secondary: week(8, 6.9) }, now), null, 'early in both windows, within the slack');
  assert.equal(overPace({ primary: fiveHour(40, 150), secondary: week(50, 3.5) }, now), null, 'exactly on pace');
  assert.match(overPace({ primary: fiveHour(85, 10), secondary: week(10, 6) }, now)!, /5-hour Codex limit is 85% used$/);
  assert.match(overPace({ primary: fiveHour(10, 200), secondary: week(45, 5) }, now)!, /weekly Codex limit is 45% used with 29% of the window gone, on track to run out/);
  assert.equal(overPace({ primary: { usedPercent: 30 } }, now), null, 'no reset time: only the 80% rule');
  assert.equal(usageLine({ primary: fiveHour(12, 100), secondary: week(30, 2) }), '5-hour 12%, weekly 30%');
});

test('a review reads Codex usage first: it skips (exit 4) when over pace, and runs anyway when usage is unknown', async () => {
  rmSync(fakeLog, { force: true });
  const over = await review('Review.', { cwd: root, timeoutMs: 10_000, bin: fakeCodex, env: { ...process.env, FAKE_CODEX: 'over' } });
  assert.equal(over.code, 4);
  assert.match(over.text, /^Skipped to save your Codex plan: the 5-hour Codex limit is 85% used\.$/);
  assert.ok(!logged().some((m) => m.method === 'thread/start'), 'no thread is started');
  const unknown = await review('Review.', { cwd: root, timeoutMs: 10_000, bin: fakeCodex, env: { ...process.env, FAKE_CODEX: 'no-limits' } });
  assert.equal(unknown.code, 0);
  assert.equal(unknown.usage, '');
});

// Host turns (#398): no hook on the host, so a review goes to the Codex container the runner named in the
// turn's Codex config. A fake podman plays the container: FAKE_PODMAN picks what it does with the exec.
// The driver pinned in a turn's folder, as the runner lays it out: <turn>/pin/codex-review.ts beside <turn>/codex-tripwire.json.
const turnDir = join(root, 'turn-1');
mkdirSync(join(turnDir, 'pin'), { recursive: true });
const driver = join(turnDir, 'pin', 'codex-review.ts');
// It looks for the hook at a path of the test's own, where there is none: a person's container has the real
// one at /etc/codex, and there the driver would skip the host path and run Codex on the person's own login (#458).
const source = readFileSync(join(import.meta.dirname, '..', 'src', 'codex-review.ts'), 'utf8');
const unhooked = source.replace(`export const REQUIREMENTS = '${REQUIREMENTS}';`, `export const REQUIREMENTS = ${JSON.stringify(join(root, 'no-hook', 'requirements.toml'))};`);
assert.notEqual(unhooked, source, "the pinned driver's REQUIREMENTS line moved: update the test's rewrite");
writeFileSync(driver, unhooked);
mkdirSync(join(turnDir, 'pin', 'kit', 'agents'), { recursive: true });
writeFileSync(join(turnDir, 'pin', 'kit', 'agents', 'reviewer.md'), 'the reviewer rules');
const podBin = join(root, 'podbin');
const podLog = join(root, 'podman.jsonl');
mkdirSync(podBin, { recursive: true });
writeFileSync(
  join(podBin, 'podman'),
  `#!${process.execPath}
const fs = require('node:fs');
const { dirname } = require('node:path');
const args = process.argv.slice(2);
const log = (m) => fs.appendFileSync(${JSON.stringify(podLog)}, JSON.stringify(m) + '\\n');
const mode = process.env.FAKE_PODMAN;
if (mode === 'gone') { log({ args }); process.stderr.write('Error: no container with name or ID "x" found: no such container\\n'); process.exit(125); }
let i = 1, cwd = null;
const env = {};
for (; i < args.length; i++) {
  if (args[i] === '-i') continue;
  if (args[i] === '-w') { cwd = args[++i]; continue; }
  if (args[i] === '-e') { const [k, ...v] = args[++i].split('='); env[k] = v.join('='); continue; }
  break;
}
const [name, cmd, script, ...rest] = args.slice(i);
const stdin = rest.includes('--check') ? '' : fs.readFileSync(0, 'utf8');
const cfgFile = env.CITADEL_CODEX_TRIPWIRE;
const kitRef = /Follow (\\S+)/.exec(stdin)?.[1] ?? null;
log({ args, name, cmd, script, rest, cwd, env, stdin, kitRef, kitSeen: kitRef && fs.existsSync(kitRef) ? fs.readFileSync(kitRef, 'utf8') : null, cfg: JSON.parse(fs.readFileSync(cfgFile, 'utf8')), writable: (fs.statSync(cfgFile).mode & 0o222) !== 0, files: fs.readdirSync(dirname(cfgFile)).sort() });
if (mode === 'run') {
  // The copy, run as it would be in a container whose image has no hook.
  const r = require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, [script, ...rest], { cwd, env: { PATH: process.env.PATH, ...env }, input: stdin });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);
}
if (mode === 'signed-out') { process.stdout.write("This person hasn't signed in to Codex in their container yet.\\n"); process.exit(3); }
process.stdout.write(rest.includes('--check') ? 'ready\\n' : 'REVIEW OK\\n');
if (!rest.includes('--check')) process.stderr.write('Codex usage: 5-hour 10%, weekly 3%\\n');
process.exit(0);
`,
);
chmodSync(join(podBin, 'podman'), 0o755);
const personTurns = join(root, 'run', 'turns', 'person-1');
const container = { name: 'citadel-claude-test-1', turnsDir: personTurns, env: { HOME: '/home/u', PATH: '/usr/local/bin:/usr/bin' } };
const hostTurn = join(turnDir, 'codex-tripwire.json');
writeFileSync(hostTurn, JSON.stringify({ script: tripwire, config, container }), { mode: 0o444 });
const podCalls = () => {
  try {
    return readFileSync(podLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
function cli(args: string[], fake: string | null, cfg: string, input = '', extra: Record<string, string> = {}) {
  rmSync(podLog, { force: true });
  // HOME too: never the real one, whose ~/.codex may hold a person's Codex login.
  return spawnSync(process.execPath, [driver, ...args], { cwd: root, input, encoding: 'utf8', env: { PATH: `${podBin}:${process.env.PATH}`, HOME: join(root, 'home'), CITADEL_CODEX_TRIPWIRE: cfg, ...(fake ? { FAKE_PODMAN: fake } : {}), ...extra } });
}

test("a host turn's review runs in the Codex container the runner named, read-only, with the brief, exit code and usage line passed through (#398)", () => {
  const check = cli(['--check'], 'ok', hostTurn);
  assert.equal(check.status, 0);
  assert.equal(check.stdout, 'ready\n');

  const r = cli(['--timeout', '60'], 'ok', hostTurn, `Follow ${join(turnDir, 'pin', 'kit')}/agents/reviewer.md then review the diff.\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'REVIEW OK\n');
  assert.match(r.stderr, /^Codex usage: 5-hour 10%, weekly 3%$/m);
  const [call] = podCalls();
  assert.deepEqual(call.args.slice(0, 2), ['exec', '-i']);
  assert.equal(call.name, container.name);
  assert.equal(call.cmd, 'node');
  assert.equal(call.cwd, root, "in the turn's own folder, which the container mounts at the same path");
  assert.deepEqual(call.rest, ['--timeout', '60']);
  // The brief's kit is the turn's pinned one, which the container can't see: it reads the copy beside the driver.
  assert.equal(call.kitRef, join(dirname(call.script), 'kit', 'agents', 'reviewer.md'));
  assert.equal(call.stdin, `Follow ${call.kitRef} then review the diff.\n`);
  assert.equal(call.kitSeen, 'the reviewer rules');
  assert.equal(call.env.HOME, '/home/u', "the container's environment, not the host turn's");
  assert.equal(call.env.FAKE_PODMAN, undefined);
  // Its files sit in the person's mounted turns folder: the driver, the tripwire, and a review-mode config.
  assert.ok(call.script.startsWith(personTurns + '/review-'), call.script);
  assert.deepEqual(call.files, ['codex-review.ts', 'codex-tripwire.json', 'kit', 'tripwire.ts']);
  assert.deepEqual(call.cfg, { script: join(dirname(call.script), 'tripwire.ts'), config }, 'the container turns\' review mode: no container, no turn mode');
  assert.equal(call.writable, false, 'read-only, as the runner writes it');
  assert.deepEqual(readdirSync(personTurns), [], 'the copy goes once the review ends');
});

test("a host turn's review is exit 3 with the reason when the container isn't signed in, isn't running, or has no hook; never Codex on the host (#398)", () => {
  const out = cli(['--check'], 'signed-out', hostTurn);
  assert.equal(out.status, 3);
  assert.match(out.stdout, /hasn't signed in to Codex/);

  const gone = cli(['--check'], 'gone', hostTurn);
  assert.equal(gone.status, 3);
  assert.match(gone.stdout, /Couldn't run the review in Codex's container \(citadel-claude-test-1\): it isn't running[\s\S]*no such container/);
  const goneRun = cli([], 'gone', hostTurn, 'brief');
  assert.equal(goneRun.status, 3);
  assert.match(goneRun.stderr, /isn't running/);

  // The real copy, in a "container" without the managed hook: it refuses rather than run Codex unhooked.
  for (const args of [['--check'], ['--timeout', '60']]) {
    const r = cli(args, 'run', hostTurn, 'brief');
    assert.equal(r.status, 3, r.stderr);
    assert.match(args[0] === '--check' ? r.stdout : r.stderr, /managed tripwire hook isn't installed/);
  }
  assert.deepEqual(readdirSync(personTurns), []);

  // A host turn the runner named no container for (anyone else, or before the Codex sign-in): exit 3, no podman.
  const plain = cli(['--check'], 'ok', good);
  assert.equal(plain.status, 3);
  assert.match(plain.stdout, /managed tripwire hook isn't installed/);
  assert.equal(podCalls().length, 0);
  // A config the turn points CITADEL_CODEX_TRIPWIRE at itself, naming some container: not the runner's, so ignored.
  const forged = configFile({ script: tripwire, config, container: { ...container, name: 'citadel-claude-someone-else' } });
  for (const args of [['--check'], ['--timeout', '60']]) {
    const r = cli(args, 'ok', forged, 'brief');
    assert.equal(r.status, 3);
    assert.match(args[0] === '--check' ? r.stdout : r.stderr, /managed tripwire hook isn't installed/);
  }
  assert.equal(podCalls().length, 0, 'never execs into a container the runner didn\'t name');
});

test("a host turn's images go to the Codex container as --image, with the shared folders to check them against; a bad one stops before podman (#408)", () => {
  const shared = join(root, 'host-shared');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(root, 'shot.png'), 'x');
  writeFileSync(join(shared, 'sheet.webp'), 'x');
  const r = cli(['--timeout', '60', '--image', 'shot.png', '--image', join(shared, 'sheet.webp')], 'ok', hostTurn, 'brief', { COORDINATOR_SHARED_DIR: shared });
  assert.equal(r.status, 0, r.stderr);
  const [call] = podCalls();
  assert.deepEqual(call.rest, ['--timeout', '60', '--image', 'shot.png', '--image', join(shared, 'sheet.webp')]);
  assert.equal(call.cwd, root);
  assert.equal(call.env.COORDINATOR_SHARED_DIR, shared);

  const bad = cli(['--image', '/etc/hostname.png'], 'ok', hostTurn, 'brief', { COORDINATOR_SHARED_DIR: shared });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no image at \/etc\/hostname.png/);
  // Outside the worktree (the review's cwd) with no shared folder to cover it.
  const elsewhere = mkdtempSync(join(tmpdir(), 'codex-elsewhere-'));
  after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'x.png'), 'x');
  const outside = cli(['--image', join(elsewhere, 'x.png')], 'ok', hostTurn, 'brief', { COORDINATOR_SHARED_DIR: shared });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /outside this worktree and the shared folders/);
  assert.equal(podCalls().length, 0);
});
