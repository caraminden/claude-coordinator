// The generative media tools a minion is offered (#717 OpenRouter, #733 Codex): what they say first, and generate_image_codex's run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'media-tools-'));
after(() => rmSync(root, { recursive: true, force: true }));

// A stand-in for the pinned citadel-codex-review: logs its argv and stdin, and answers as FAKE_REVIEW says.
const fakeLog = join(root, 'review.json');
writeFileSync(
  join(root, 'citadel-codex-review'),
  `#!${process.execPath}
const { writeFileSync, readFileSync } = require('node:fs');
const stdin = readFileSync(0, 'utf8');
writeFileSync(${JSON.stringify(fakeLog)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
const mode = process.env.FAKE_REVIEW;
if (mode === 'over') { process.stderr.write('Skipped to save your Codex plan: the 5-hour window is 85% used.\\nCodex usage: 5-hour 85%, weekly 30%\\n'); process.exit(4); }
if (mode === 'fail') { process.stderr.write("citadel-codex-review: Codex made no image: Codex's image generation limit is used up\\n"); process.exit(1); }
process.stdout.write('Wrote /w/art/cat.png\\n');
process.stderr.write('Codex usage: 5-hour 13%, weekly 30%\\n');
`,
);
chmodSync(join(root, 'citadel-codex-review'), 0o755);

async function mcp(env: Record<string, string>, method: string, params: object = {}) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'mcp.ts')], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, COORDINATOR_API: 'http://127.0.0.1:9', COORDINATOR_TOKEN: 't', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '2', COORDINATOR_ROLE: 'thread', COORDINATOR_MEDIA: '', COORDINATOR_CODEX_IMAGES: '', COORDINATOR_MEMORY: '', ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((ok) => createInterface({ input: child.stdout }).once('line', (l) => ok(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    return (await reply).result;
  } finally {
    child.kill();
  }
}
const tools = async (env: Record<string, string>) => (await mcp(env, 'tools/list')).tools as { name: string; description: string }[];
const both = { COORDINATOR_MEDIA: '1', COORDINATOR_CODEX_IMAGES: '1' };

test('the generative media tools are offered, in order', async () => {
  const media = (await tools(both)).filter((t) => /^generate_|^edit_image$/.test(t.name));
  assert.deepEqual(media.map((t) => t.name), ['generate_image', 'edit_image', 'generate_audio', 'generate_speech', 'generate_image_codex']);
});

test('every generative media tool opens with the made-by-code rule (Cara, 2026-11-14)', async () => {
  const media = (await tools(both)).filter((t) => /^generate_|^edit_image$/.test(t.name));
  for (const t of media) assert.match(t.description, /^Only on a person's explicit ask or a scheme system's call; otherwise (draw|make sound) with code\./, t.name);
  assert.match(media.find((t) => t.name === 'generate_speech')!.description, /otherwise make sound with code/);
});

test('the media tools are listed for every minion whatever its person has, refused at call time without, and never for a Taskmaster (#878)', async () => {
  const list = async (env: Record<string, string>) => JSON.stringify(await tools(env));
  // The tool list is the head of the cache prefix: it mustn't change with who sent the turn.
  assert.equal(await list({}), await list(both));
  assert.ok((await tools({})).some((t) => t.name === 'generate_image_codex'));
  assert.ok(!(await tools({ ...both, COORDINATOR_ROLE: 'coordinator' })).some((t) => /image|audio|speech/.test(t.name)));
  const codex = await mcp({ COORDINATOR_MEDIA: '1' }, 'tools/call', { name: 'generate_image_codex', arguments: { prompt: 'a cat', out: 'cat.png' } });
  assert.ok(codex.isError);
  assert.match(codex.content[0].text, /^Error: Not on this turn: the person it runs for has no Codex login/);
  const media = await mcp({ COORDINATOR_CODEX_IMAGES: '1' }, 'tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', out: 'cat.png' } });
  assert.ok(media.isError);
  assert.match(media.content[0].text, /^Error: Not on this turn: the person it runs for hasn't connected OpenRouter/);
});

test('generate_image_codex runs citadel-codex-review --image-gen with the prompt on stdin and returns the path and usage', async () => {
  const call = (args: object, env: Record<string, string> = {}) => mcp({ ...both, ...env }, 'tools/call', { name: 'generate_image_codex', arguments: args });
  const made = await call({ prompt: 'a cat\non a mat', out: 'art/cat.png', refs: ['ref/a.png', 'ref/b.webp'], transparent: true });
  assert.equal(made.isError, undefined);
  assert.equal(made.content[0].text, "Wrote /w/art/cat.png with Codex on this person's ChatGPT plan. Codex usage: 5-hour 13%, weekly 30%.");
  const ran = JSON.parse(readFileSync(fakeLog, 'utf8'));
  assert.deepEqual(ran.argv, ['--image-gen', '--timeout', '600', '--out', 'art/cat.png', '--transparent', '--image', 'ref/a.png', '--image', 'ref/b.webp']);
  assert.equal(ran.stdin, 'a cat\non a mat');

  const over = await call({ prompt: 'a cat', out: 'cat.png', overwrite: true }, { FAKE_REVIEW: 'over' });
  assert.ok(over.isError);
  assert.equal(over.content[0].text, 'Error: Skipped to save your Codex plan: the 5-hour window is 85% used. Use generate_image (OpenRouter) for this one; it refuses too when the person has no OpenRouter key.');
  assert.ok(JSON.parse(readFileSync(fakeLog, 'utf8')).argv.includes('--overwrite'));

  const failed = await call({ prompt: 'a cat', out: 'cat.png' }, { FAKE_REVIEW: 'fail' });
  assert.match(failed.content[0].text, /^Error: Codex couldn't make the image \(exit 1\): Codex made no image: Codex's image generation limit is used up$/);

  rmSync(fakeLog);
  assert.match((await call({ out: 'cat.png' })).content[0].text, /prompt is required/);
  assert.match((await call({ prompt: 'x', out: 'cat.png', refs: 'a.png' })).content[0].text, /refs must be a list/);
  assert.throws(() => readFileSync(fakeLog), 'a bad call never starts Codex');
});
