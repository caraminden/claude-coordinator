import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, REPO, stopProcs, stopTurns, until } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'review-set-api-'));
const procs: ChildProcess[] = [];
after(async () => {
  await stopProcs(procs);
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});

let base = '';
let cookie = '';

/** A request as Cara, or as the minion or Taskmaster `as` (a ticket id) with its token. */
async function call(path: string, opts: { method?: string; body?: unknown; as?: number } = {}) {
  const auth: Record<string, string> = opts.as === undefined ? { Cookie: cookie } : { Authorization: `Bearer ${agentToken(join(root, 'data'), opts.as)}` };
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { ...auth, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  // A stand-in Claude for the describe box: a turn (stream-json) fails as /bin/false would; a describe call proposes
  // an edit to the finding checker when the ask reaches it on stdin, and answers nonsense otherwise.
  const claude = join(root, 'fake-claude');
  writeFileSync(claude, `#!/bin/sh
case "$*" in *stream-json*) exit 1;; esac
if grep -q 'twice as picky'; then
  printf '%s' '{"type":"result","is_error":false,"result":"{\\"edits\\":[{\\"slug\\":\\"finding-checker\\",\\"body\\":\\"Be twice as picky with migrations.\\",\\"why\\":\\"Pickier on migrations\\"},{\\"slug\\":\\"no-such\\",\\"body\\":\\"x\\"}],\\"note\\":\\"One edit\\"}"}'
else
  printf '%s' '{"type":"result","is_error":false,"result":"I would rather chat."}'
fi
`);
  chmodSync(claude, 0o755);
  const srv = await bootServer({ root, stdout: true, env: { CLAUDE_BIN: claude } });
  base = srv.base;
  cookie = srv.cookie;
  procs.push(srv.proc);
});

test("a scheme's review set: new on trial, switches, a minion's learning, History, and other schemes kept out", async () => {
  // Not Citadel: the set is keyed by scheme, and nothing here names Citadel.
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Genesis Tree' } });
  const { data: other } = await call('/api/projects', { method: 'POST', body: { name: 'Other' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: otherPage } = await call(`/api/projects/${other.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'hi', properties: { type: 'chore' } } });
  const url = `/api/projects/${p.id}/reviews`;

  // The kit's own reviewers are there from the start (#1052); this test is about the scheme's own entries.
  const own = (entries: any[]) => entries.filter((e) => !e.kit);
  const empty = await call(url);
  assert.deepEqual(own(empty.data.entries), []);
  assert.ok(empty.data.starters.some((s: any) => s.slug === 'ui-screenshots'));

  // From a kit starter: its slug, its when, and on trial whatever the request says (Q12).
  const made = await call(url, { method: 'POST', body: { extends: 'ui-screenshots', name: 'Tree UI', trial: false } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.deepEqual([made.data.slug, made.data.trial, made.data.stage, made.data.when], ['ui-screenshots', true, 'work', 'diff: public/**, **/*.css, **/*.html']);
  assert.match(made.data.text, /^---\nname: ui-screenshots\nextends: citadel:critique\/rubrics\/ui-screenshots\n/);
  assert.equal((await call(url, { method: 'POST', body: { extends: 'no-such' } })).status, 400);
  assert.equal((await call(url, { method: 'POST', body: { extends: 'ui-screenshots' } })).status, 409);
  const blank = await call(url, { method: 'POST', body: { slug: 'claims', when: 'schedule: monthly', body: '# Claims' }, as: page.coordinator.id });
  assert.deepEqual([blank.status, blank.data.name, blank.data.stage], [201, 'Claims', 'schedule']);

  // A switch is a version; a save from an older one is refused.
  const entry = `${url}/ui-screenshots`;
  const off = await call(entry, { method: 'PATCH', body: { enabled: false, version: 1 } });
  assert.deepEqual([off.status, off.data.enabled, off.data.version], [200, false, 2]);
  const stale = await call(entry, { method: 'PATCH', body: { body: 'mine', version: 1 } });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /at version 2 now/);

  // A minion writes what it learned into the body, and no more.
  const learned = await call(entry, { method: 'PATCH', body: { body: '## Notes\n\nA person passed the long labels.', note: 'Learned from a verdict' }, as: minion.id });
  assert.equal(learned.status, 200, JSON.stringify(learned.data));
  assert.equal((await call(entry, { method: 'PATCH', body: { enabled: true }, as: minion.id })).status, 403);
  assert.equal((await call(url, { method: 'POST', body: { slug: 'x' }, as: minion.id })).status, 403);

  const history = await call(`${entry}/versions`);
  assert.deepEqual(history.data.versions.map((v: any) => [v.version, v.note]), [[3, 'Learned from a verdict'], [2, 'Turned off'], [1, 'Made']]);
  const back = await call(`${entry}/restore`, { method: 'POST', body: { version: 1 } });
  assert.deepEqual([back.status, back.data.version, back.data.enabled, back.data.body], [200, 4, true, '']);
  assert.equal((await call(`${entry}/restore`, { method: 'POST', body: { version: 9 } })).status, 404);

  // Another scheme's Taskmaster can't read or change this one's, and its own set is empty.
  assert.equal((await call(url, { as: otherPage.coordinator.id })).status, 403);
  assert.equal((await call(entry, { method: 'PATCH', body: { enabled: false }, as: otherPage.coordinator.id })).status, 403);
  assert.deepEqual(own((await call(`/api/projects/${other.id}/reviews`)).data.entries), []);

  // The minion's tool: list, read one, save what it learned.
  const tool = async (args: Record<string, unknown>, name = 'review_set', as: { id: number } = minion) => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
      env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), as.id), COORDINATOR_PROJECT: String(p.id), COORDINATOR_TICKET: String(as.id), COORDINATOR_ROLE: 'thread' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
      const { result } = await reply;
      return { error: !!result.isError, text: result.content[0].text as string };
    } finally {
      child.kill();
    }
  };
  assert.match((await tool({})).text, /^pre-ship-review \(reviewer, on, kit\): Every change, before it ships\n[^]*\nui-screenshots \(critic, on, trial, on kit ui-screenshots\): diff: public\/\*\*, .*\nclaims \(critic, on, trial\): schedule: monthly$/);
  assert.match((await tool({ slug: 'claims' })).text, /^claims, version 1 \(.+ saved it\)\. As the critic reads it:\n\n---\nname: claims\nwhen: "schedule: monthly"\ntrial: true\n---\n\n# Claims\n/);
  const saved = await tool({ slug: 'claims', body: '# Claims\n\n## Notes\n\nCara passed the hedged ones.', version: 1, note: 'Calibration' });
  assert.equal(saved.text, 'Saved claims as version 2.');
  assert.ok((await tool({ slug: 'claims', enabled: false })).error);
  // A save's `when` is not dropped: the Taskmaster's sets it as a new version, a minion's is refused.
  const refused = await tool({ slug: 'claims', when: 'diff: src/**', version: 2 });
  assert.ok(refused.error, 'a minion passing when gets an error, not Saved');
  assert.equal((await tool({ slug: 'claims', extends: 'ui-screenshots', body: 'x', version: 2 })).error, true, 'extends without add is refused, not dropped');
  const { data: page2 } = await call(`/api/projects/${p.id}`);
  const widened = await tool({ slug: 'claims', when: 'diff: src/**', version: 2 }, 'review_set', page2.coordinator);
  assert.equal(widened.text, 'Saved claims as version 3.');
  assert.match((await tool({ slug: 'claims' })).text, /when: "diff: src\/\*\*"/);
  assert.ok((await tool({ slug: 'claims', when: 'nonsense: x', version: 3 }, 'review_set', page2.coordinator)).error, 'the page\'s checks apply');
  // Phase 3: a round's verdict, and a person's disagreement, recorded with the tools.
  assert.equal((await tool({ slug: 'claims', run: { round: 1, verdict: 'fail' } })).text, 'Recorded round 1 of claims: fail.');
  assert.ok((await tool({ slug: 'claims', run: { round: 1, verdict: 'meh' } })).error);
  assert.equal((await tool({ slug: 'claims', person: 'Cara', words: 'Hedging is fine here.' }, 'record_verdict')).text, 'Recorded on claims: Cara, "Hedging is fine here.". Its later runs read it.');
  assert.match((await tool({})).text, /\nclaims \(critic, on, trial, 0% first-round pass\): diff: src\/\*\*$/);
  assert.match((await tool({ slug: 'claims' })).text, /## Verdicts[^]*Cara, \d{4}-\d\d-\d\d, on #\d+: "Hedging is fine here\."/);
});

// Phase 2 (#1052), in a scheme that isn't Citadel: the kit's reviewers switch per scheme, the pre-ship review's switch
// decides whether a ship needs a go, trial locks blocking until calibrated, and the describe box proposes edits.
test("kit reviewers switch per scheme, trial locks blocking until calibrated, and the describe box proposes what Apply saves", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Peek' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'hi', properties: { type: 'chore' } } });
  const url = `/api/projects/${p.id}/reviews`;

  const first = await call(url);
  assert.equal(first.status, 200);
  const kit = first.data.entries.filter((e: any) => e.kit).map((e: any) => e.slug);
  assert.deepEqual([kit[0], kit.includes('lens-tests'), kit.includes('finding-checker'), kit.at(-2), kit.at(-1)], ['pre-ship-review', true, true, 'fresh-eyes', 'professor']);
  // #1089: the kit's teacher shows in this scheme too, with its agent file's text (frontmatter cut) and no stage of its own to judge.
  const prof = first.data.entries.find((e: any) => e.slug === 'professor');
  assert.deepEqual([prof.kind, prof.agent?.path, prof.passes], ['teacher', 'kit/agents/professor.md', 0]);
  assert.match(prof.agent.text, /^You are the teacher/);
  assert.equal(first.data.entries.find((e: any) => e.slug === 'lens-tests').agent, null, 'a lens has no agent file of its own');
  assert.equal(first.data.label, 'Pre-ship review');
  assert.ok(first.data.audits.length, 'the standard audits are listed');
  assert.ok(first.data.entries.every((e: any) => !e.kit || (!e.trial && e.what)), "kit entries are off trial and carry the kit's own words");

  // A person switches a lens, fresh eyes and the pre-ship review off; a kit entry's name stays the kit's.
  for (const slug of ['lens-tests', 'fresh-eyes', 'pre-ship-review']) {
    const r = await call(`${url}/${slug}`, { method: 'PATCH', body: { enabled: false } });
    assert.deepEqual([r.status, r.data.enabled], [200, false], JSON.stringify(r.data));
  }
  const renamed = await call(`${url}/fresh-eyes`, { method: 'PATCH', body: { name: 'Mine' } });
  assert.equal(renamed.status, 400);
  assert.match(renamed.data.error, /kit's/);
  assert.equal((await call(url)).data.label, null, 'nothing gives the label now');

  // With the pre-ship review off, a ship with a label is still sent back for a go (before land.sh would run).
  const { data: { ticket: t } } = await call(`/api/tickets/${minion.id}`);
  assert.ok(t.cwd);
  mkdirSync(join(t.cwd, 'tools'), { recursive: true });
  writeFileSync(join(t.cwd, 'tools', 'land.sh'), 'exit 1\n');
  const handOff = await fetch(`${base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(join(root, 'data'), minion.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'x', risk: 'low', risk_reason: 'front end' }) });
  assert.equal(handOff.status, 400);
  assert.match((await handOff.json()).error, /pre-ship review is off and nothing else gives the risk label, so this ship waits for a person's go/);

  // Even where the scheme's go threshold is never, an unlabelled ship waits for a go (Q10).
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { go_from: 'never' } });
  const never = await fetch(`${base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(join(root, 'data'), minion.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'x', risk: 'low', risk_reason: 'front end' }) });
  assert.equal(never.status, 400);
  await call(`/api/projects/${p.id}`, { method: 'PATCH', body: { go_from: 'high' } });

  // A new entry is on trial: it can't block or give the label until it's calibrated.
  await call(url, { method: 'POST', body: { slug: 'gatekeeper', when: 'ask', body: '# Gate' } });
  const gk = `${url}/gatekeeper`;
  const locked = await call(gk, { method: 'PATCH', body: { gate: 'block' } });
  assert.equal(locked.status, 400);
  assert.match(locked.data.error, /on trial, so it only advises/);
  assert.equal((await call(gk, { method: 'PATCH', body: { gives_label: true } })).status, 400);
  // A minion records a calibration that fails, then one that passes (most notes hit, no false alarms), which takes it off trial.
  const weak = await call(gk, { method: 'PATCH', body: { calibration: { hits: 1, notes: 4, false_alarms: 0, controls: 2, model: 'sonnet' } }, as: minion.id });
  assert.deepEqual([weak.status, weak.data.trial], [200, true], JSON.stringify(weak.data));
  const good = await call(gk, { method: 'PATCH', body: { calibration: { hits: 3, notes: 4, false_alarms: 0, controls: 2, model: 'sonnet' } }, as: minion.id });
  assert.deepEqual([good.data.trial, good.data.calibrated], [false, `${new Date().toISOString().slice(0, 10)}, sonnet: 3/4 hits, 0/2 false alarms`]);
  assert.equal((await call(gk, { method: 'PATCH', body: { enabled: false }, as: minion.id })).status, 403, 'a minion still only saves bodies and calibrations');
  // Now it can block and give the label, and the ship gate names it.
  assert.equal((await call(gk, { method: 'PATCH', body: { gate: 'block', gives_label: true } })).data.gate, 'block');
  assert.equal((await call(url)).data.label, 'Gatekeeper');
  // A person can mark one good instead of calibrating it.
  await call(url, { method: 'POST', body: { slug: 'trusted', body: '# T' } });
  const marked = await call(`${url}/trusted`, { method: 'PATCH', body: { trial: false } });
  assert.match(marked.data.calibrated, /marked good by Cara$/);

  // An audit's switch is its schedule's pause.
  const audit = first.data.audits[0];
  const paused = await call(`${url}/audits/${audit.slug}`, { method: 'POST', body: { enabled: !audit.on } });
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  assert.equal((await call(url)).data.audits.find((a: any) => a.slug === audit.slug).on, !audit.on);
  assert.equal((await call(`${url}/audits/nope`, { method: 'POST', body: { enabled: true } })).status, 404);

  // The describe box: only a person, on their own login; it proposes before and after, and Apply is a save History undoes.
  assert.equal((await call(`${url}/describe`, { method: 'POST', body: { text: 'x' }, as: page.coordinator.id })).status, 403);
  const proposed = await call(`${url}/describe`, { method: 'POST', body: { text: 'Make the finding checker twice as picky' } });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.data));
  assert.equal(proposed.data.note, 'One edit');
  assert.deepEqual(proposed.data.proposals.map((x: any) => [x.slug, x.before, x.after, x.why]), [['finding-checker', '', 'Be twice as picky with migrations.', 'Pickier on migrations']], 'an entry not in the set is dropped');
  const pr = proposed.data.proposals[0];
  const applied = await call(`${url}/finding-checker`, { method: 'PATCH', body: { body: pr.after, version: pr.version, note: 'Described: Make the finding checker twice as picky' } });
  assert.deepEqual([applied.status, applied.data.body], [200, 'Be twice as picky with migrations.']);
  const undone = await call(`${url}/finding-checker/restore`, { method: 'POST', body: { version: pr.version } });
  assert.equal(undone.data.body, '');
  const chatty = await call(`${url}/describe`, { method: 'POST', body: { text: 'Something else' } });
  assert.equal(chatty.status, 502);
  assert.match(chatty.data.error, /wasn't the proposal/);
});

test('phase 3 in a scheme of its own: a panel with a referee, run order, the record and verdicts, and a blocking critic holds the ship', async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Glade' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'Make the glade glow', properties: { type: 'feature' } } });
  const url = `/api/projects/${p.id}/reviews`;
  const tm = page.coordinator.id;
  for (const [slug, kind] of [['look', 'critic'], ['taste-a', 'critic'], ['taste-b', 'critic'], ['taste-ref', 'referee']]) {
    assert.equal((await call(url, { method: 'POST', body: { slug, kind, when: 'creative: art', body: `# ${slug}` }, as: tm })).status, 201);
  }
  // The Taskmaster groups the panel and sets the hand-offs; a minion may not.
  for (const slug of ['taste-a', 'taste-b', 'taste-ref']) assert.equal((await call(`${url}/${slug}`, { method: 'PATCH', body: { panel: 'Taste' }, as: tm })).data.panel, 'Taste');
  assert.equal((await call(`${url}/look`, { method: 'PATCH', body: { panel: 'Taste' }, as: minion.id })).status, 403);
  const handOff = await call(`${url}/look`, { method: 'PATCH', body: { on_fail: [{ after: 1, to: 'taste-ref' }, { after: 2, to: 'person' }] }, as: tm });
  assert.match(handOff.data.text, /^on_fail: taste-ref after 1 fail, person after 2 fails$/m);
  assert.equal((await call(`${url}/look`, { method: 'PATCH', body: { on_fail: [{ after: 1, to: 'ghost' }] } })).status, 400);
  const moved = await call(`${url}/look/move`, { method: 'POST', body: { dir: 'down' } });
  assert.equal(moved.status, 200);
  assert.equal((await call(`${url}/look/move`, { method: 'POST', body: { dir: 'down' }, as: minion.id })).status, 403);

  // Calibrated and set to block: its fail on this minion holds the ship.
  await call(`${url}/look`, { method: 'PATCH', body: { trial: false } });
  await call(`${url}/look`, { method: 'PATCH', body: { gate: 'block' } });
  for (const [slug, verdict] of [['taste-a', 'pass'], ['taste-b', 'fail'], ['taste-ref', 'pass'], ['look', 'fail']]) {
    assert.equal((await call(`${url}/${slug}/runs`, { method: 'POST', body: { round: 1, verdict }, as: minion.id })).status, 201);
  }
  assert.equal((await call(`${url}/look/runs`, { method: 'POST', body: { round: 1, verdict: 'pass' } })).status, 403, 'only a minion records a run');
  const { data: { ticket: t } } = await call(`/api/tickets/${minion.id}`);
  mkdirSync(join(t.cwd, 'tools'), { recursive: true });
  writeFileSync(join(t.cwd, 'tools', 'land.sh'), 'exit 1\n');
  const held = await fetch(`${base}/api/tickets/${minion.id}/land/handoff`, { method: 'POST', headers: { Authorization: `Bearer ${agentToken(join(root, 'data'), minion.id)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: 'x', risk: 'low', risk_reason: 'front end' }) });
  assert.equal(held.status, 400);
  assert.match((await held.json()).error, /^Not handed off: Look \(`look`, last verdict fail\) blocks this ship\./);

  // A person disagrees in chat; the minion records it, and the run turns amber.
  assert.equal((await call(`${url}/look/verdicts`, { method: 'POST', body: { person: 'Josh', words: 'x' } })).status, 403, 'no Add box for people (Q13)');
  const v = await call(`${url}/look/verdicts`, { method: 'POST', body: { person: 'Josh', words: 'The glow is meant to be faint.' }, as: minion.id });
  assert.equal(v.status, 201);
  const look = (await call(url)).data.entries.find((e: any) => e.slug === 'look');
  assert.deepEqual([look.runs.length, look.runs[0].disagreed, look.rate, look.verdicts[0].minion], [1, true, 0, `#${minion.number}`]);
  assert.match(look.text, /## Verdicts[\s\S]*Josh, \d{4}-\d\d-\d\d, on #\d+: "The glow is meant to be faint\."/);
  assert.equal((await call(`${url}/look/verdicts/${v.data.id}`, { method: 'DELETE', as: minion.id })).status, 403);
  assert.equal((await call(`${url}/look/verdicts/${v.data.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await call(url)).data.entries.find((e: any) => e.slug === 'look').verdicts, []);
});

// Build 4 gap (Delve #127), in a scheme that isn't Citadel: the Taskmaster's tool sets kind, model, effort, on_fail and
// context, a critic's on_fail can name a teacher entry, and the kit has creative and teacher starters.
test("a Taskmaster's review_set tool adds a teacher and sets a critic's model, effort, on_fail and context", async () => {
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Tidepool' } });
  const { data: page } = await call(`/api/projects/${p.id}`);
  const { data: minion } = await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'Draw a crab', properties: { type: 'art' } } });
  const url = `/api/projects/${p.id}/reviews`;
  const tool = async (as: number, args: Record<string, unknown>) => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
      env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), as), COORDINATOR_PROJECT: String(p.id), COORDINATOR_TICKET: String(as), COORDINATOR_ROLE: 'thread' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'review_set', arguments: args } }) + '\n');
      const { result } = await reply;
      return { error: !!result.isError, text: result.content[0].text as string };
    } finally {
      child.kill();
    }
  };
  const tm = page.coordinator.id;
  const one = async (slug: string) => (await call(url)).data.entries.find((e: any) => e.slug === slug);
  const starters = (await call(url)).data.starters.map((s: any) => s.slug);
  assert.ok(starters.includes('creative') && starters.includes('teacher'), starters.join());

  // A teacher from the kit starter is a teacher without being told; a critic from the creative starter.
  assert.equal((await tool(tm, { add: true, extends: 'teacher', slug: 'art-professor' })).text.slice(0, 22), 'Added art-professor (o');
  assert.equal((await one('art-professor')).kind, 'teacher');
  assert.equal((await tool(tm, { add: true, extends: 'creative', slug: 'art', when: 'creative: new art', kind: 'critic', model: 'opus', effort: 'high' })).error, false);
  const added = (await one('art'));
  assert.deepEqual([added.model, added.effort, added.kind], ['opus', 'high', 'critic']);

  // A save sets the rest and is a version in History; a bad value is the store's own refusal.
  const guides = [{ label: 'Taste', href: 'docs/design/art-style/taste.md' }, { label: 'Techniques', href: 'docs/design/art-style/techniques.md' }];
  const saved = await tool(tm, { slug: 'art', model: 'sonnet', effort: 'medium', on_fail: [{ after: 2, to: 'art-professor' }, { after: 3, to: 'person' }], context: { guides }, note: 'Teacher after 2' });
  assert.equal(saved.text, 'Saved art as version 2.', saved.text);
  const art = (await one('art'));
  assert.deepEqual([art.model, art.effort, art.on_fail, art.context.guides], ['sonnet', 'medium', [{ after: 2, to: 'art-professor' }, { after: 3, to: 'person' }], guides]);
  assert.match(art.text, /\non_fail: art-professor after 2 fails, person after 3 fails\n/);
  assert.match(art.text, /- Guide: \[Taste\]\(docs\/design\/art-style\/taste\.md\)/);
  assert.match((await one('art-professor')).text, /^---\nname: art-professor\nkind: teacher\n/);
  assert.equal((await call(`${url}/art/versions`)).data.versions[0].note, 'Teacher after 2');
  for (const bad of [{ model: 'gpt' }, { kind: 'wizard' }, { on_fail: [{ after: 2, to: 'no-such' }] }, { on_fail: [{ after: 3, to: 'person' }, { after: 2, to: 'professor' }] }, { context: { guides: [{ label: 'x' }] } }]) {
    assert.equal((await tool(tm, { slug: 'art', ...bad })).error, true, JSON.stringify(bad));
  }
  assert.equal((await one('art')).version, 2, 'a refused save leaves no version');
  assert.deepEqual((await tool(tm, { slug: 'art', on_fail: [] })).error, false);
  assert.equal((await one('art')).on_fail, null);

  // A minion keeps to body, calibrations and runs.
  for (const f of [{ model: 'haiku' }, { kind: 'teacher' }, { on_fail: [{ after: 2, to: 'professor' }] }, { context: { guides } }]) {
    assert.equal((await tool(minion.id, { slug: 'art', ...f })).error, true, JSON.stringify(f));
  }
  assert.equal((await one('art')).model, 'sonnet');
});

test("a scheme's own reviewing agent files are entries: read live, guessed or kind:, one row with a same-named entry, and gone when deleted", async () => {
  // Not Citadel: a scheme with its own repo holding three agents (#1089).
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Agent Files' } });
  const repo = join(root, 'agent-files-repo');
  const agents = join(repo, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'art-critic.md'), '---\nname: art-critic\ndescription: Judges new art against the art bible\n---\n\nYou judge art.\n');
  writeFileSync(join(agents, 'art-professor.md'), '---\nname: art-professor\ndescription: Teaches fixes for art the critic keeps failing\n---\n\nYou teach.\n');
  writeFileSync(join(agents, 'balance-tuner.md'), '---\nname: balance-tuner\ndescription: Tunes numbers\n---\nTune.\n');
  writeFileSync(join(agents, 'copy-judge.md'), '---\nname: copy-judge\ndescription: Judges copy\nkind: none\n---\nNo.\n');
  const url = `/api/projects/${p.id}/reviews`;
  // A rubric entry made before its file came is one row with that file's text (Q4 "One").
  assert.equal((await call(url, { method: 'POST', body: { slug: 'art-professor', name: 'Art professor', kind: 'teacher', body: '## Rules\nFix palettes first.' } })).status, 201);
  const db = new DatabaseSync(join(root, 'data', 'coordinator.db'));
  db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(repo, p.id);
  db.close();
  const { data } = await call(url);
  const by = (s: string) => data.entries.find((e: any) => e.slug === s);
  assert.equal(by('balance-tuner'), undefined, 'not a reviewing agent');
  assert.equal(by('copy-judge'), undefined, 'kind: none leaves it off');
  const critic = by('art-critic');
  assert.deepEqual([critic.kind, critic.file, critic.what, critic.agent?.path, critic.agent?.text.trim()], ['critic', '.claude/agents/art-critic.md', 'Judges new art against the art bible', '.claude/agents/art-critic.md', 'You judge art.']);
  const prof = by('art-professor');
  assert.deepEqual([prof.file, prof.agent?.path, prof.agent?.text.trim(), data.entries.filter((e: any) => e.slug === 'art-professor').length], [null, '.claude/agents/art-professor.md', 'You teach.', 1]);
  // Its additions and switch save; its text, kind and name stay the file's.
  assert.equal((await call(`${url}/art-critic`, { method: 'PATCH', body: { body: 'Pixel art at whole scales.', version: critic.version } })).status, 200);
  const kindTry = await call(`${url}/art-critic`, { method: 'PATCH', body: { kind: 'reviewer', version: critic.version + 1 } });
  assert.equal(kindTry.status, 400);
  assert.match(kindTry.data.error, /agent file \.claude\/agents\/art-critic\.md/);
  assert.equal((await call(`${url}/art-critic`, { method: 'PATCH', body: { on_fail: [{ after: 2, to: 'art-professor' }, { after: 3, to: 'person' }], version: critic.version + 1 } })).status, 200);
  // The review_set tool names it as the file's, and reads out the file's text with the scheme's additions.
  const tm = (await call(`/api/projects/${p.id}`)).data.coordinator.id;
  const tool = async (args: Record<string, unknown>) => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
      env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), tm), COORDINATOR_PROJECT: String(p.id), COORDINATOR_TICKET: String(tm), COORDINATOR_ROLE: 'thread' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'review_set', arguments: args } }) + '\n');
      return (await reply).result.content[0].text as string;
    } finally {
      child.kill();
    }
  };
  assert.match(await tool({}), /^art-critic \(critic, on, agent_file \.claude\/agents\/art-critic\.md/m);
  assert.match(await tool({ slug: 'art-critic' }), /agent_file \.claude\/agents\/art-critic\.md \(on here\): Judges new art.*\n\nYou judge art\.[\s\S]*what a save replaces:\n\nPixel art at whole scales\./);
  // The file is read live: deleted, the entry stays with no text, so the page can say it's gone.
  rmSync(join(agents, 'art-critic.md'));
  const gone = (await call(url)).data.entries.find((e: any) => e.slug === 'art-critic');
  assert.deepEqual([gone.file, gone.agent, gone.body], ['.claude/agents/art-critic.md', null, 'Pixel art at whole scales.']);
});

test("the page at a glance (#1094): judged this week, the last run, unwatched folders, review skills, and the Every scheme rows", async () => {
  // Not Citadel: a scheme with a repo whose last month touched src/ and game/logic/, and one critic on src/**.
  const { data: p } = await call('/api/projects', { method: 'POST', body: { name: 'Glance Grove' } });
  // And one Cara isn't a member of: its row stays off her Every scheme tab.
  const { data: away } = await call('/api/projects', { method: 'POST', body: { name: 'Not Hers' } });
  const repo = join(root, 'glance-repo');
  mkdirSync(join(repo, 'game', 'logic'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.claude', 'skills', 'level-review'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'skills', 'level-review', 'SKILL.md'), '---\nname: level-review\ndescription: Reviews a new level against the level rules\n---\nReview it.\n');
  writeFileSync(join(repo, 'src', 'a.ts'), '1');
  writeFileSync(join(repo, 'game', 'logic', 'b.ts'), '1');
  writeFileSync(join(repo, 'game', 'logic', 'c.ts'), '1');
  writeFileSync(join(repo, 'README.md'), 'docs are left out');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  execFileSync('git', ['init', '-q', repo]);
  git('add', '.'); git('commit', '-qm', 'first');
  const url = `/api/projects/${p.id}/reviews`;
  assert.equal((await call(url, { method: 'POST', body: { slug: 'src-critic', name: 'Src critic', kind: 'critic', when: 'diff: src/**', body: '## Rules\nTidy.' } })).status, 201);
  const a = (await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'one', properties: { type: 'chore' } } })).data;
  const b = (await call(`/api/projects/${p.id}/tickets`, { method: 'POST', body: { message: 'two', properties: { type: 'chore' } } })).data;
  // Each new minion's first turn ends by setting its status (error here): a close before then is lost under load.
  for (const t of [a, b]) await until(`#${t.number}'s first turn to end`, async () => ['idle', 'error'].includes((await call(`/api/tickets/${t.id}`)).data.ticket.status));
  const db = new DatabaseSync(join(root, 'data', 'coordinator.db'));
  db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(repo, p.id);
  db.prepare('UPDATE projects SET owner_id = NULL WHERE id = ?').run(away.id);
  db.prepare('DELETE FROM project_members WHERE project_id = ?').run(away.id);
  db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id IN (?, ?)").run(Date.now(), a.id, b.id);
  const entry = db.prepare("SELECT id FROM review_entries WHERE project_id = ? AND slug = 'src-critic'").get(p.id) as { id: number };
  const at = Date.now() - 60_000;
  db.prepare('INSERT INTO review_runs (entry_id, ticket_id, minion, round, verdict, at) VALUES (?, ?, ?, 1, ?, ?)').run(entry.id, a.id, `#${a.number}`, 'pass', at);
  db.close();

  const { data } = await call(url);
  assert.deepEqual([data.glance.closed, data.glance.judged, data.glance.last, data.glance.days], [2, 1, at, 30]);
  assert.deepEqual(data.glance.coverage, { changes: 3, watched: 1, gaps: [{ folder: 'game/logic', changes: 2 }] });
  assert.deepEqual(data.glance.skills, [{ name: 'level-review', what: 'Reviews a new level against the level rules' }]);

  const { status, data: every } = await call('/api/reviews/schemes');
  assert.equal(status, 200);
  assert.equal(every.schemes.some((s: any) => s.id === away.id), false, 'only schemes the person is a member of');
  const row = every.schemes.find((s: any) => s.id === p.id);
  assert.deepEqual([row.name, row.opened, row.critics, row.trial, row.preship, row.rate, row.last, row.closed, row.judged],
    ['Glance Grove', true, 1, 1, true, 100, at, 2, 1]);
  assert.deepEqual(row.coverage, { changes: 3, watched: 1, gap: { folder: 'game/logic', changes: 2 } });
});
