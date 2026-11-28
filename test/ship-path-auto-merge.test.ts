import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, tempRoot, type Booted } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

// #2301: SpellAutoCombat's setup picked pr-auto on a private free-plan repo, where GitHub can't
// auto-merge, and its PRs sat green. set_project_settings now asks GitHub before saving pr-auto.
const tmp = tempRoot('ship-path-auto-merge-');
const data = join(tmp.dir, 'data');
mkdirSync(data, { recursive: true });
const bin = join(tmp.dir, 'bin');
mkdirSync(bin, { recursive: true });
// A fake gh: prints $FAKE_AUTO_MERGE for `gh api repos/<slug> --jq .allow_auto_merge`, logs its args.
writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> "${join(tmp.dir, 'gh.log')}"\n[ "$FAKE_GH_FAIL" = 1 ] && { echo "HTTP 404: Not Found" >&2; exit 1; }\necho "$FAKE_AUTO_MERGE"\n`, { mode: 0o755 });

const store = new Store(join(data, 'coordinator.db'));
const Scheme = store.createProject('Game', 'https://github.com/someone/game');
const Bare = store.createProject('Local', null);
const TM = store.createTicket({ project_id: Scheme.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const BareTM = store.createTicket({ project_id: Bare.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root: tmp.dir });
});
after(async () => {
  await srv?.stop();
  await tmp.teardown();
});

async function setShip(ticket: { id: number; project_id: number }, ship_path: string, env: Record<string, string>) {
  const r = await mcpOnce(agentEnv(srv.base, tokens.agentToken(ticket.id), { id: ticket.id, project_id: ticket.project_id }, 'coordinator', { PATH: `${bin}:${process.env.PATH}`, ...env }), 'tools/call', { name: 'set_project_settings', arguments: { ship_path } });
  return { isError: r.isError, text: r.content[0].text as string };
}

test('pr-auto is refused, naming pr-minion, when the repo reports allow_auto_merge false', async () => {
  const r = await setShip(TM, 'pr-auto', { FAKE_AUTO_MERGE: 'false' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /pr-minion/);
  assert.match(r.text, /someone\/game/);
  assert.equal(store.getProject(Scheme.id)!.ship_path, 'citadel');
});

test('pr-auto is refused when GitHub cannot be asked', async () => {
  const r = await setShip(TM, 'pr-auto', { FAKE_GH_FAIL: '1' });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /pr-minion/);
  assert.equal(store.getProject(Scheme.id)!.ship_path, 'citadel');
});

test('pr-auto is refused for a scheme with no GitHub repo', async () => {
  const r = await setShip(BareTM, 'pr-auto', { FAKE_AUTO_MERGE: 'true' });
  assert.equal(r.isError, true, r.text);
  assert.equal(store.getProject(Bare.id)!.ship_path, 'citadel');
});

test('pr-auto saves when allow_auto_merge is true, and pr-minion needs no check', async () => {
  const ok = await setShip(TM, 'pr-auto', { FAKE_AUTO_MERGE: 'true' });
  assert.ok(!ok.isError, ok.text);
  assert.equal(store.getProject(Scheme.id)!.ship_path, 'pr-auto');
  const minion = await setShip(TM, 'pr-minion', { FAKE_GH_FAIL: '1' });
  assert.ok(!minion.isError, minion.text);
  assert.equal(store.getProject(Scheme.id)!.ship_path, 'pr-minion');
});
