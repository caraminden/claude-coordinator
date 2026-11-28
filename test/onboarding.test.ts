import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { catalogue, frontmatter } from '../src/catalogue.ts';
import { ONBOARDING, ONBOARDING_MODES, Store, type Project } from '../src/db.ts';
import { onboardingPrompt } from '../src/prompts.ts';
import { projectSharedDir, surveyReports } from '../src/workspace.ts';
import { bootServer, jsonLines, REPO, until, tempRoot, type Booted, fakeClaude } from './helpers.ts';

// New scheme onboarding (#172): the kickoff from the form, the Taskmaster's onboarding section while
// setup runs, its plan card and catalogue, and the catalogue never handing out a file's body.
const tmp = tempRoot('onboarding-');
const root = tmp.dir;
after(() => tmp.teardown()); // ends the children and the detached turns (#271) before the folder goes

const fake = fakeClaude(root, { log: { path: join(root, 'turns.jsonl'), record: "JSON.stringify({ prompt: JSON.parse(line), system: require('node:fs').readFileSync(process.argv[process.argv.indexOf('--append-system-prompt-file') + 1], 'utf8'), token: process.env.COORDINATOR_TOKEN })" } });
const turns = () => jsonLines(join(root, 'turns.jsonl'));

type Tool = { name: string; inputSchema: { properties: Record<string, { enum: string[] }> } };
let base = '';
let cookie = '';
let srv: Booted;
const call = (path: string, opts: { method?: string; body?: unknown; token?: string } = {}) => (opts.token ? srv.as({ token: opts.token }) : srv.call)(path, opts.body || undefined, opts.method ?? 'GET');

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fake } });
  base = srv.base;
  cookie = srv.cookie;
  tmp.track(srv.proc);
});

const project = (onboarding: Project['onboarding'], onboarding_mode: Project['onboarding_mode'] = 'first-run') => ({ name: 'Lanternfall', onboarding, onboarding_mode }) as Project;

test('the onboarding section is in the prompt only while setup is under way', () => {
  for (const step of ONBOARDING) {
    const text = onboardingPrompt(project(step), '/shared');
    if (step === 'done' || step === 'skipped') assert.equal(text, '', step);
    else assert.notEqual(text, '', step);
  }
});

test("both plans name a skills survey for the stack, with every scheme's survey reports listed for the three-month check (#357)", () => {
  const data = join(root, 'surveys');
  const report = (id: number, name: string) => {
    const dir = join(projectSharedDir(data, id), 'reports');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), '# survey');
    return join(dir, name);
  };
  const general = report(2, 'skills-survey-2026-11.md');
  const godot = report(1, 'skills-survey-godot-csharp-2026-11.md');
  report(1, 'skills-surveyor-notes.md');
  report(3, 'aura-kinds-survey.md');
  mkdirSync(join(data, 'projects', '.heavy'), { recursive: true });
  const found = surveyReports(data);
  assert.deepEqual([...found].sort(), [general, godot].sort());
  assert.deepEqual(surveyReports(join(root, 'no-such-data')), []);
  for (const mode of ONBOARDING_MODES) {
    const text = onboardingPrompt(project('interview', mode), '/shared', found);
    assert.ok(text.includes(godot) && text.includes(general), mode);
    assert.match(onboardingPrompt(project('interview', mode), '/shared'), /Skills survey reports so far, from every scheme \(the name gives the stack and month; [^)]*\): none\./, mode);
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
  const items = catalogue(
    [
      { name: 'Delve', repo_dir: repo },
      { name: 'Docs', repo_dir: null },
    ],
    kit,
  );
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
  const surveyDir = join(projectSharedDir(join(root, 'data'), 98), 'reports');
  mkdirSync(surveyDir, { recursive: true });
  writeFileSync(join(surveyDir, 'skills-survey-2026-11.md'), '# survey');
  const { status, data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Lanternfall', source: 'none', about: 'A small roguelike deckbuilder.', setup: true } });
  assert.equal(status, 201);
  assert.equal(p.onboarding, 'interview');
  const { data: page } = await call(`/api/projects/${p.id}`);
  const events = await until('the kickoff', async () => {
    const { data } = await call(`/api/tickets/${page.coordinator.id}/events?after=0`);
    return data.some((e: { kind: string; data: string }) => e.kind === 'user_message') && data;
  });
  const sent = events.filter((e: { kind: string; data: string }) => e.kind === 'user_message').map((e: { kind: string; data: string }) => JSON.parse(e.data));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].author, 'Citadel');
  assert.match(sent[0].text, /New scheme "Lanternfall" \(code: no code\), created by \w+\. \w+ wrote: "A small roguelike deckbuilder\."/);
  // Its first turn gets the onboarding section.
  const turn = await until('the Taskmaster turn', () => turns().find((t) => t.token?.startsWith(`${page.coordinator.id}.`)));
  assert.match(JSON.stringify(turn.prompt), /New scheme \\"Lanternfall\\"/);
  assert.match(turn.system, /## Setting up this scheme \(onboarding: interview, first-run\)/);
  assert.ok(turn.system.includes(join(surveyDir, 'skills-survey-2026-11.md')), "the plan lists every scheme's survey reports");

  const only = await call('/api/projects', { method: 'POST', body: { name: 'Scratch', setup: false } });
  assert.equal(only.data.onboarding, 'skipped');
  const { data: scratch } = await call(`/api/projects/${only.data.id}`);
  const { data: none } = await call(`/api/tickets/${scratch.coordinator.id}/events?after=0`);
  assert.ok(!none.some((e: { kind: string; data: string }) => e.kind === 'user_message'), 'no kickoff');

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

test('Tune up turns onboarding back on in tune-up mode and messages the Taskmaster, once at a time', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tuned', setup: false } });
  assert.equal(p.onboarding, 'skipped');
  const { status, data: tuned } = await call(`/api/projects/${p.id}/tune-up`, { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(tuned.onboarding, 'interview');
  assert.equal(tuned.onboarding_mode, 'tune-up');
  const { data: page } = await call(`/api/projects/${p.id}`);
  const events = await until('the tune-up message', async () => {
    const { data } = await call(`/api/tickets/${page.coordinator.id}/events?after=0`);
    return data.some((e: { kind: string; data: string }) => e.kind === 'user_message') && data;
  });
  const sent = events.filter((e: { kind: string; data: string }) => e.kind === 'user_message').map((e: { kind: string; data: string }) => JSON.parse(e.data));
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].author, 'Citadel', 'from the person who clicked');
  assert.match(sent[0].text, /Tune up this scheme/);
  // Its turn gets the tune-up section, and a second click while it runs is refused.
  const turn = await until('the Taskmaster turn', () => turns().find((t) => t.token?.startsWith(`${page.coordinator.id}.`)));
  assert.match(turn.system, /## Tuning up this scheme/);
  assert.equal((await call(`/api/projects/${p.id}/tune-up`, { method: 'POST' })).status, 409);
  // A person's button: the Taskmaster sets it with set_project_settings instead.
  assert.equal((await call(`/api/projects/${p.id}/tune-up`, { method: 'POST', token: turn.token })).status, 403);
  const done = await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: 'done' }, token: turn.token });
  assert.equal(done.data.onboarding, 'done');
  assert.equal((await call(`/api/projects/${p.id}/tune-up`, { method: 'POST' })).status, 200, 'and again once it is done');
});

// Without the turn's own COORDINATOR_* env: its ticket would make the tool server keep a tool list in this TMPDIR.
test('Taskmasters get propose_plan and list_catalogue, and set_project_settings takes onboarding', async () => {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], { env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('COORDINATOR_'))), COORDINATOR_ROLE: 'coordinator' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = new Promise<{ result: { tools: Tool[] } }>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const tools = (await reply).result.tools;
  child.kill();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('propose_plan'));
  assert.ok(names.includes('list_catalogue'));
  const settings = tools.find((t) => t.name === 'set_project_settings')!.inputSchema.properties;
  assert.deepEqual(settings.onboarding.enum, [...ONBOARDING]);
  assert.deepEqual(settings.onboarding_mode.enum, [...ONBOARDING_MODES]);
});

test('keys and values an approved setup plan names go in approved, only while that plan is the newest and setup is open (#180)', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Peek', source: 'none', setup: true } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const tm = page.coordinator.id;
  const mine = () => turns().filter((t) => t.token?.startsWith(`${tm}.`));
  const token = async (n: number) => (await until(`Taskmaster turn ${n}`, () => mine().length >= n && mine()))[n - 1].token;
  const props = async () => (await call(`/api/projects/${p.id}/properties`)).data.keys.filter((k: { scope: string }) => k.scope === 'scheme');
  const register = async (key: string, values: string[], t: string) => call(`/api/projects/${p.id}/properties/keys`, { method: 'POST', body: { key, description: 'x', values: values.map((value) => ({ value })) }, token: t });
  let t = await token(1);

  // Before any plan, a Taskmaster's key waits for a person.
  assert.equal((await register('early', [], t)).data.status, 'proposed');
  // A plan card still pending doesn't count either.
  const plan = await call(`/api/tickets/${tm}/plans`, { method: 'POST', body: { summary: 'Peek setup', plan: '## Properties\n- `game`: wow, poe\n- `area`: capture, overlay' }, token: t });
  assert.equal((await register('area', ['capture'], t)).data.status, 'proposed');
  await call(`/api/tickets/${tm}/verdict`, { method: 'POST', body: { planId: plan.data.id, verdict: 'approve' } });
  t = await token(2);

  // Approved: what the plan names is live and reviewed; what it doesn't name still waits.
  assert.equal((await register('game', ['wow', 'poe', 'all'], t)).data.status, 'active');
  const game = (await props()).find((k: { key: string }) => k.key === 'game');
  assert.deepEqual(
    game.values.map((v: { value: string; reviewed: boolean }) => [v.value, v.reviewed]),
    [
      ['wow', true],
      ['poe', true],
      ['all', false],
    ],
  );
  const added = await call(`/api/projects/${p.id}/properties/values`, { method: 'POST', body: { key: 'game', values: [{ value: 'lol' }] }, token: t });
  assert.deepEqual(added.data.unreviewed, ['lol']);
  assert.equal((await register('zone', [], t)).data.status, 'proposed', 'a key the plan never names');

  // A newer plan card, even one naming the key, takes the approval away until a person approves it.
  const next = await call(`/api/tickets/${tm}/plans`, { method: 'POST', body: { summary: 'More', plan: '`mode`, `extra`, `quarry`, `lantern`' }, token: t });
  assert.equal((await register('mode', [], t)).data.status, 'proposed');
  await call(`/api/tickets/${tm}/verdict`, { method: 'POST', body: { planId: next.data.id, verdict: 'approve' } });
  t = await token(3);

  // Once setup is done, an old approved plan counts for nothing, even if the Taskmaster names the key...
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: 'done' }, token: t });
  assert.equal((await register('extra', [], t)).data.status, 'proposed');
  // ...nor after the Taskmaster reopens onboarding by itself, at any step: it needs a newly approved plan.
  for (const step of ['setting-up', 'interview'] as const) {
    await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: 'done' }, token: t });
    await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { onboarding: step }, token: t });
    assert.equal((await register(step === 'interview' ? 'lantern' : 'quarry', [], t)).data.status, 'proposed', step);
  }
  // A person's key is live as always.
  assert.equal((await call(`/api/projects/${p.id}/properties/keys`, { method: 'POST', body: { key: 'personal', description: 'x' } })).data.status, 'active');
});
