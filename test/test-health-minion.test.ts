import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { projectRoutes } from '../src/routes/projects.ts';

// Test health's "#N is on it" (#1922 WP3): only a minion that is still open owns a flaky file's fix; a closed one whose proof
// isn't held leaves "Start a minion to fix it" for people to press, and a held fix still reads "fixed it".
const root = mkdtempSync(join(tmpdir(), 'test-health-minion-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'coordinator.db'));

async function read(projectId: number) {
  const route = projectRoutes.find((r) => r.method === 'GET' && r.path === '/api/projects/:project/test-health')!;
  let body = '';
  const res = { destroyed: false, writeHead() {}, end: (b: Buffer | string) => (body += b), setHeader() {}, on() {} };
  const app = { store, dataDir: root, ciHealth: null, fastMode: null };
  const project = { ...store.getProject(projectId)!, repo_dir: null, land_mode: 'land' };
  await (route.handler as unknown as (c: unknown) => Promise<void>)({ res, app, project });
  return JSON.parse(body) as { flakes: { file: string; minion: number | null }[] };
}

test('a flaky file whose fix minion is closed shows no owner unless its proof is held', async () => {
  const project = store.createProject('Scheme', null);
  const now = Date.now();
  const mk = (title: string) => store.createTicket({ project_id: project.id, title, permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const files = { open: 'test/open.test.ts', closed: 'test/closed.test.ts', held: 'test/held.test.ts' };
  for (const f of Object.values(files)) store.addFlakeEvents(project.id, 1, 'abc', now - 1000, [{ file: f, source: 'in CI', detail: '' }]);
  const openT = mk('Fix flaky open');
  const closedT = mk('Fix flaky closed');
  const heldT = mk('Fix flaky held');
  store.addFlakeFix(project.id, files.open, openT.id, now - 5000);
  store.addFlakeFix(project.id, files.closed, closedT.id, now - 5000);
  store.addFlakeFix(project.id, files.held, heldT.id, now - 5000, { state: 'held', clean_runs: 50, held_at: now - 2000 });
  store.updateTicket(closedT.id, { status: 'closed' });
  store.updateTicket(heldT.id, { status: 'closed' });
  const by = Object.fromEntries((await read(project.id)).flakes.map((f) => [f.file, f.minion]));
  assert.equal(by[files.open], openT.number, 'an open fix minion is on it');
  assert.equal(by[files.closed], null, 'a closed minion with no proof is nobody');
  assert.equal(by[files.held], heldT.number, 'a held fix still reads fixed it');
});
