import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { agentToken, bootServer, REPO, stopProcs, stopTurns } from './helpers.ts';

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
  const tool = async (args: Record<string, unknown>, name = 'review_set') => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
      env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: base, COORDINATOR_TOKEN: agentToken(join(root, 'data'), minion.id), COORDINATOR_PROJECT: String(p.id), COORDINATOR_TICKET: String(minion.id), COORDINATOR_ROLE: 'thread' },
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
  // Phase 3: a round's verdict, and a person's disagreement, recorded with the tools.
  assert.equal((await tool({ slug: 'claims', run: { round: 1, verdict: 'fail' } })).text, 'Recorded round 1 of claims: fail.');
  assert.ok((await tool({ slug: 'claims', run: { round: 1, verdict: 'meh' } })).error);
  assert.equal((await tool({ slug: 'claims', person: 'Cara', words: 'Hedging is fine here.' }, 'record_verdict')).text, 'Recorded on claims: Cara, "Hedging is fine here.". Its later runs read it.');
  assert.match((await tool({})).text, /\nclaims \(critic, on, trial, 0% first-round pass\): schedule: monthly$/);
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
  assert.deepEqual([kit[0], kit.includes('lens-tests'), kit.includes('finding-checker'), kit.at(-1)], ['pre-ship-review', true, true, 'fresh-eyes']);
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
