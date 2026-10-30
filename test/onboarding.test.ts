import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { catalogue, frontmatter } from '../src/catalogue.ts';
import { ONBOARDING, Store, type Project } from '../src/db.ts';
import { onboardingPrompt } from '../src/runner.ts';
import { bootServer, REPO, until } from './helpers.ts';

// New scheme onboarding (#172): the kickoff from the form, the Taskmaster's onboarding section while
// setup runs, its plan card and catalogue, and the catalogue never handing out a file's body.
const root = mkdtempSync(join(tmpdir(), 'onboarding-'));
const procs: ChildProcess[] = [];
after(() => {
  for (const p of procs) p.kill();
  rmSync(root, { recursive: true, force: true });
});

const fakeClaude = join(root, 'claude-fake');
writeFileSync(fakeClaude, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).once('line', (prompt) => {
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), token: process.env.COORDINATOR_TOKEN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fakeClaude, 0o755);
const turns = () => (existsSync(join(root, 'turns.jsonl')) ? readFileSync(join(root, 'turns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

let base = '';
let cookie = '';
async function call(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : { Cookie: cookie }), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  const srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

const project = (onboarding: Project['onboarding']) => ({ name: 'Lanternfall', onboarding, onboarding_mode: 'first-run' }) as Project;

test('the onboarding section is in the prompt only while setup is under way', () => {
  for (const step of ONBOARDING) {
    const text = onboardingPrompt(project(step), '/shared');
    if (step === 'done' || step === 'skipped') assert.equal(text, '', step);
    else {
      assert.match(text, /## Setting up this scheme/, step);
      assert.match(text, /propose_plan/);
      assert.match(text, /list_catalogue/);
      assert.match(text, /citadel:scheme-setup/);
      assert.match(text, /\/shared\/onboarding\.md/);
      assert.match(text, /who pushes main/);
    }
  }
});

test('schemes from before onboarding read as done', () => {
  const store = new Store(join(root, 'old.db'));
  assert.equal(store.createProject('Old', null).onboarding, 'done');
});

test('the catalogue gives names and one-line descriptions, never bodies', () => {
  const kit = join(root, 'kit');
  const repo = join(root, 'repo');
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  write(join(kit, 'skills', 'bug-fixing', 'SKILL.md'), '---\nname: bug-fixing\ndescription: >\n  How to fix\n  a bug.\n---\nKIT-BODY-SECRET\n');
  write(join(repo, '.claude', 'skills', 'bug-fixing', 'SKILL.md'), '---\nname: bug-fixing\ndescription: "Delve\'s copy"\n---\nBODY-SECRET\n');
  write(join(repo, '.claude', 'skills', 'game-design', 'SKILL.md'), '---\nname: game-design\ndescription: Turns a design ask into a spec.\n---\n# Game design\nBODY-SECRET\n');
  write(join(repo, '.claude', 'agents', 'art-critic.md'), '---\nname: art-critic\ndescription: Looks at art.\ntools: Read\n---\nBODY-SECRET\n');
  write(join(repo, '.claude', 'rules', 'godot.md'), '---\npaths:\n  - "godot/**"\n---\n\n# Working in godot/\n\nBODY-SECRET\n');
  const items = catalogue([{ name: 'Delve', repo_dir: repo }, { name: 'Docs', repo_dir: null }], kit);
  assert.ok(!JSON.stringify(items).includes('SECRET'), 'no body text');
  assert.deepEqual(items, [
    { name: 'bug-fixing', kind: 'skill', source: 'kit', description: 'How to fix a bug.', in_kit: true },
    { name: 'bug-fixing', kind: 'skill', source: 'Delve: .claude/skills/bug-fixing/SKILL.md', description: "Delve's copy", in_kit: true },
    { name: 'game-design', kind: 'skill', source: 'Delve: .claude/skills/game-design/SKILL.md', description: 'Turns a design ask into a spec.', in_kit: false },
    { name: 'art-critic', kind: 'agent', source: 'Delve: .claude/agents/art-critic.md', description: 'Looks at art.', in_kit: false },
    { name: 'godot', kind: 'rule', source: 'Delve: .claude/rules/godot.md', description: 'Working in godot/ · for godot/**', in_kit: false },
  ]);
  assert.deepEqual(frontmatter('---\npaths:\n  - "a/**"\n  - b\n---\n'), { paths: ['a/**', 'b'] });
});

test('"Create and set up" sends the Taskmaster one kickoff from Citadel; "Create only" skips setup', async () => {
  const bad = await call('/api/projects', { method: 'POST', body: { name: 'X', source: 'svn' } });
  assert.equal(bad.status, 400);
  const { status, data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Lanternfall', source: 'none', about: 'A small roguelike deckbuilder.', setup: true } });
  assert.equal(status, 201);
  assert.equal(p.onboarding, 'interview');
  const { data: page } = await call(`/api/projects/${p.id}`);
  const events = await until('the kickoff', async () => {
    const { data } = await call(`/api/tickets/${page.coordinator.id}/events?after=0`);
    return data.some((e: any) => e.kind === 'user_message') && data;
  });
  const sent = events.filter((e: any) => e.kind === 'user_message').map((e: any) => JSON.parse(e.data));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].author, 'Citadel');
  assert.match(sent[0].text, /New scheme "Lanternfall" \(code: no code\), created by \w+\. \w+ wrote: "A small roguelike deckbuilder\."/);
  // Its first turn gets the onboarding section.
  const turn = await until('the Taskmaster turn', () => turns().find((t) => t.token?.startsWith(`${page.coordinator.id}.`)));
  assert.match(JSON.stringify(turn.prompt), /New scheme \\"Lanternfall\\"/);

  const only = await call('/api/projects', { method: 'POST', body: { name: 'Scratch', setup: false } });
  assert.equal(only.data.onboarding, 'skipped');
  const { data: scratch } = await call(`/api/projects/${only.data.id}`);
  const { data: none } = await call(`/api/tickets/${scratch.coordinator.id}/events?after=0`);
  assert.ok(!none.some((e: any) => e.kind === 'user_message'), 'no kickoff');

  // The Taskmaster moves it along (set_project_settings), and onboarding never clears.
  const token = turn.token;
  const moved = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: 'planned' }, token });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.onboarding, 'planned');
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: null } })).status, 400);
  assert.equal((await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: 'maybe' } })).status, 400);

  // The Taskmaster posts a plan card in its own chat; only a person approves it.
  const plan = await call(`/api/tickets/${page.coordinator.id}/plans`, { method: 'POST', body: { summary: 'Lanternfall setup', plan: '## Lanternfall setup' }, token });
  assert.equal(plan.status, 201);
  assert.equal((await call(`/api/tickets/${page.coordinator.id}/verdict`, { method: 'POST', body: { planId: plan.data.id, verdict: 'approve' }, token })).status, 403);
  assert.equal((await call(`/api/tickets/${page.coordinator.id}/verdict`, { method: 'POST', body: { planId: plan.data.id, verdict: 'approve' } })).status, 202);
});

test('Taskmasters get propose_plan and list_catalogue, and set_project_settings takes onboarding', async () => {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], { env: { ...process.env, COORDINATOR_ROLE: 'coordinator' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const tools = (await reply).result.tools;
  child.kill();
  const names = tools.map((t: any) => t.name);
  assert.ok(names.includes('propose_plan'));
  assert.ok(names.includes('list_catalogue'));
  assert.deepEqual(tools.find((t: any) => t.name === 'set_project_settings').inputSchema.properties.onboarding.enum, [...ONBOARDING]);
});
