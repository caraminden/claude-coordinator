// The reviewer's test-habits check (kit/skills/test-quality/scripts/test-habits.ts): a branch that plants each habit
// gets a line naming the file or helper to use; a clean branch and the same habits already on main get none.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, test } from 'node:test';
import { addedFromGit, fixedSleep, prosePin, scan } from '../kit/skills/test-quality/scripts/test-habits.ts';
import { git, makeRepo } from './git.ts';
import { tempRoot } from './helpers.ts';

const tmp = tempRoot('test-habits-');
after(() => tmp.teardown());

const write = (root: string, files: Record<string, string>) => {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(`${root}/${f}`), { recursive: true });
    writeFileSync(`${root}/${f}`, body);
  }
};

const mcpTool = (name: string) => `async function ${name}(name, args) {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], { env: { ...process.env, API: srv.base }, stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = new Promise((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\\n');
  const { result } = await reply;
  child.kill();
  return { text: result.content[0].text, error: !!result.isError };
}
`;

// main: a relay module and the test that drives it, a shared helper with a wait and a fake maker, a test with a tool() harness
function repo(name: string): string {
  const root = makeRepo(tmp.path(name));
  write(root, {
    'src/relay.ts': 'export const relay = (x) => x;\n',
    'test/helpers.ts': `export async function until(what, fn) {
  for (;;) {
    const v = await fn();
    if (v) return v;
    await tick();
  }
}
export function fakeClaude(dir) {
  const path = join(dir, 'claude');
  writeFileSync(path, '#!/bin/sh\\necho ok\\n', { mode: 0o755 });
  return path;
}
`,
    'test/relay-when-live.test.ts': `import { relay } from '../src/relay.ts';
import { until } from './helpers.ts';
test('relays once live', async () => {
  await post('/api/relay/when-live', { kind: 'relay_when_live' });
  assert.equal(relay(1), 1);
});
`,
    'test/missing-args.test.ts': `import { until } from './helpers.ts';\n${mcpTool('tool')}\ntest('x', async () => assert.ok(await tool('a', {})));\n`,
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'checkout', '-qb', 'feature');
  return root;
}

test('a branch that plants each habit gets a line for each, naming the file or helper to use', () => {
  const root = repo('planted');
  write(root, {
    'test/relay-when-live-replay.test.ts': `import { relay } from '../src/relay.ts';
import { until } from './helpers.ts';
${mcpTool('call')}
test('the #1234 replay', async () => {
  await post('/api/relay/when-live', { kind: 'relay_when_live' });
  writeFileSync(join(dir, 'claude'), '#!/bin/sh\\necho hi\\n', { mode: 0o755 });
  globalThis.fetch = async () => ({ ok: true });
  // timing-ok: the planted sleep the checker must flag
  await new Promise((r) => setTimeout(r, 2_000));
  assert.match(text, /End your turn now with a short reply/);
  assert.equal(relay(2), 2);
});
`,
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'replay');
  const hits = scan(root, addedFromGit(root, 'main'));
  const by = (kind: string, re: RegExp) => hits.find((h) => h.kind === kind && re.test(h.text));
  assert.ok(by('seam', /test\/relay-when-live\.test\.ts already drives the same seam/), JSON.stringify(hits, null, 1));
  assert.ok(by('harness', /call\(\) repeats test\/missing-args\.test\.ts:\d+ tool\(\)/), JSON.stringify(hits, null, 1));
  assert.ok(by('harness', /fake executable.*fakeClaude \(test\/helpers\.ts\)/), JSON.stringify(hits, null, 1));
  assert.ok(by('harness', /stubs the browser's fetch/), JSON.stringify(hits, null, 1));
  assert.ok(by('sleep', /fixed 2000 ms wait.*until \(test\/helpers\.ts\)/), JSON.stringify(hits, null, 1));
  assert.ok(by('prose', /End your turn now with a short reply/), JSON.stringify(hits, null, 1));
  assert.equal(hits.length, 6, JSON.stringify(hits, null, 1));
});

test('a clean branch, and habits that were already on main, give no lines', () => {
  const root = repo('clean');
  write(root, {
    'test/relay-when-live.test.ts': `import { relay } from '../src/relay.ts';
import { until } from './helpers.ts';
test('relays once live', async () => {
  await post('/api/relay/when-live', { kind: 'relay_when_live' });
  assert.equal(relay(1), 1);
});
test('a second relay waits on the event', async () => {
  await until('relayed', () => relay(3));
  assert.match(res.data.error, /refused/);
  assert.equal(res.status, 409);
});
`,
    'src/queue.ts': 'export const queue = [];\n',
    'test/queue.test.ts': "import { queue } from '../src/queue.ts';\ntest('starts empty', () => assert.deepEqual(queue, []));\n",
  });
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'clean');
  assert.deepEqual(scan(root, addedFromGit(root, 'main')), []);
});

test('prose pins and fixed sleeps: the cut-offs', () => {
  for (const [line, hit] of [
    ['assert.match(text, /Never send that you shipped/);', true],
    ["expect(out).toContain('the answers will come back as a message');", true],
    ['self.assertRegex(body, r"must wait for the go card")', true],
    ['assert.match(r.data.error, /not found/);', false],
    ['assert.match(line, /^\\d+ ms$/);', false],
    ["const note = 'a sentence that is not in an assert at all';", false],
  ] as const)
    assert.equal(prosePin(line) !== null, hit, line);
  for (const [line, ms] of [
    // timing-ok: lines the checker reads, not waits
    ['await new Promise((r) => setTimeout(r, 1200));', 1200],
    // timing-ok: a line the checker reads, not a wait
    ['await sleep(500);', 500],
    ['time.sleep(0.5)', 500],
    ["await holds('no repaint', () => n === 1, { ms: 2000 });", 2000],
    ["await holds('no repaint', () => n === 1, { after: () => done, ms: 2000 });", null],
    ["await until('ready', () => up, 5000);", null],
    // timing-ok: a line the checker reads, not a wait
    ['await new Promise((r) => setTimeout(r, 20));', null],
  ] as const)
    assert.equal(fixedSleep(line), ms, line);
});
