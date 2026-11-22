import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factsText, liveFacts, newestRun } from '../src/live-facts.ts';

const run = (over: object) => ({ name: 'tests', head_branch: 'ticket/7-x', head_sha: 'abc12345ffff', status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/1', run_started_at: '2026-11-19T10:00:00Z', ...over });

test('newestRun takes the newer of the branch and land/ runs, and says whether it is on the head', async () => {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    const land = path.includes('land%2F');
    return { status: 200, etag: null, body: { workflow_runs: [run(land ? { head_branch: 'land/ticket/7-x', head_sha: 'ffff0000', conclusion: 'failure', run_started_at: '2026-11-19T11:00:00Z' } : {})] } };
  };
  const r = await newestRun(get, 'o/r', undefined, ['ticket/7-x', 'land/ticket/7-x'], 'abc12345');
  assert.equal(asked.length, 2);
  assert.equal(r?.branch, 'land/ticket/7-x');
  assert.equal(r?.conclusion, 'failure');
  assert.equal(r?.onHead, null, "a land run is on the branch rebased onto main: its commit can't say whether it is the head's");
  const old = await newestRun(async () => ({ status: 200, etag: null, body: { workflow_runs: [run({ head_sha: '99990000' })] } }), 'o/r', undefined, ['ticket/7-x'], 'abc12345');
  assert.equal(old?.onHead, false);
  assert.equal(await newestRun(async () => ({ status: 200, etag: null, body: { workflow_runs: [] } }), 'o/r', undefined, ['b'], null), null);
  await assert.rejects(newestRun(async () => ({ status: 404, etag: null, body: {} }), 'o/r', undefined, ['b'], null), /404/);
});

/** A fake app with one minion, as liveFacts reads it. */
function fakeApp(ticket: object, view: object, project: object, branch: object | null) {
  return {
    store: { getTicket: () => ticket, getProject: () => project, listProjects: () => [project], getUser: () => null },
    runner: { view: () => view },
    github: { token: () => null },
    dataDir: '/nowhere',
    ticketBranch: async () => branch,
  } as any;
}

test('liveFacts reads state, cards, park, branch, change and CI in one go, and factsText says them', async () => {
  const card = { minion: 7, kind: 'question', label: 'Ship it?', href: '#/p/3/t/70?e=5' };
  const app = fakeApp(
    { id: 70, number: 7, title: 'Fix the thing', project_id: 3, status: 'idle', state: 'parked', note: 'waits on #6', branch: 'ticket/7-x' },
    { wakes_on: "#6 Leader's work is live", open_cards: [card], wait: null, ship: { stage: 'main', text: 'On main, not deployed', commit: 'abc1234' } },
    { id: 3, name: 'Delve', repo_url: 'https://github.com/o/r.git', repo_dir: '/repo' },
    { tip: 'abc12345ffff', pr: { number: 12, state: 'OPEN', url: 'https://github.com/o/r/pull/12' } },
  );
  const f = await liveFacts(app, 70, async () => ({ status: 200, etag: null, body: { workflow_runs: [run({})] } }));
  assert.equal(f.parkedOn, "#6 Leader's work is live");
  assert.equal(f.head, 'abc12345');
  assert.equal((f.ci as any).conclusion, 'success');
  const text = factsText(f);
  for (const want of ['#7 Fix the thing (scheme Delve)', 'status: idle, sealed', "sealed on: #6 Leader's work is live", '[open it](#/p/3/t/70?e=5)', 'branch: ticket/7-x @ abc12345', 'change: On main, not deployed', 'PR #12: open', 'newest CI run: tests on ticket/7-x @ abc12345: success']) {
    assert.ok(text.includes(want), `missing ${want} in:\n${text}`);
  }
});

test('liveFacts says why CI could not be read, and a minion with no branch has no CI line', async () => {
  const project = { id: 3, name: 'Delve', repo_url: 'https://github.com/o/r.git', repo_dir: '/repo' };
  const broken = fakeApp({ id: 70, number: 7, title: 'T', project_id: 3, status: 'idle', state: null, branch: 'b' }, { open_cards: [] }, project, { tip: 'abc', pr: null });
  const f = await liveFacts(broken, 70, async () => { throw new Error('gh: not logged in\nmore'); });
  assert.match(factsText(f), /newest CI run: couldn't read \(gh: not logged in\)/);
  assert.match(factsText(f), /cards waiting on people: none/);
  assert.match(factsText(f), /change: nothing committed on its branch/);
  const unread = fakeApp({ id: 70, number: 7, title: 'T', project_id: 3, status: 'idle', state: null, branch: 'b' }, { open_cards: [] }, project, null);
  assert.match(factsText(await liveFacts(unread, 70, async () => ({ status: 200, etag: null, body: { workflow_runs: [run({ head_branch: 'land/b' })] } }))), /change: couldn't read its branch[\s\S]*a ship run: the branch rebased onto main/);
  const none = fakeApp({ id: 70, number: 7, title: 'T', project_id: 3, status: 'idle', state: 'parked', branch: null }, { open_cards: [] }, project, null);
  const text = factsText(await liveFacts(none, 70, async () => assert.fail('no branch, no GitHub call')));
  assert.match(text, /branch: none/);
  assert.match(text, /nothing wakes it by itself/);
  assert.doesNotMatch(text, /CI/);
});
